/**
 * F2 — testes adversariais do Finance Kernel (ordem §8, 06-FATIAS).
 * Extende o kernel existente (sem modelo financeiro paralelo).
 *
 * Propriedades:
 *  1. Isolamento multi-tenant
 *  2. Concorrência allocate + ingest
 *  3. Cash (registered / Fiscalizacao / depósito tenant-scoped)
 *  4. AuthZ gestor
 *  5. Reauth (destino nunca IBAN)
 *  6. Identity (substring + caps)
 *  7. Hash-chain via ledger/validate
 *  8. Idempotência outbox (notify.bank_reauth / f2.issue_receipt)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./database/schema";
import {
  approveBudgetAndCreateObligations,
  confirmFracaoLines,
  createAnnualBudget,
  extractDocumentLines,
  listConstitutionFracoes,
  registerIngestDocument,
} from "./application/constitution/f1-constitution";
import {
  allocatePayment,
  depositCashPayment,
  issueReceiptForPayment,
  recordKernelBankMovement,
  registerPayment,
  validateLedgerChain,
  verifyCashPayment,
} from "./application/finance/f2-finance";
import {
  ingestCandidateMovement,
  ingestCandidateMovements,
  MAX_CANDIDATE_CSV_CHARS,
  MAX_CANDIDATE_MOVEMENTS,
} from "./application/finance/f2-candidates";
import {
  BANK_REAUTH_ADMIN_FALLBACK,
  isResolvedAdminMailbox,
  listBankConnections,
  sweepBankReauthNotices,
  upsertBankConnection,
} from "./application/finance/f2-bank-connection";
import { generateMonthlyPaymentNotices } from "./application/finance/f2-jobs";
import { identityNameMatches } from "./application/finance/f2-identity";
import { processOutbox } from "./application/jobs/process-outbox";
import { ownerContactDrafts } from "./database/schema";
import { BUDGET_LINE_KINDS, INGEST_DOCUMENT_KINDS } from "./domain/constitution";
import {
  ALLOCATION_STATUS,
  BANK_CONSENT_STATUS,
  CANDIDATE_SOURCES,
  CASH_STATUS,
  PAYMENT_METHODS,
  VERIFICATION_METHOD,
} from "./domain/finance";
import { OUTBOX_JOB_TYPES, OUTBOX_STATUS } from "./domain/outbox";
import { applyDomainKernelSchema } from "./infra/kernel-schema";
import { applyF1ConstitutionSchema } from "./infra/f1-schema";
import { applyF2FinanceSchema } from "./infra/f2-schema";
import type { KernelDeps } from "./infra/kernel-deps";
import { createMembershipRepo } from "./infra/repos/membership-repo";
import { createPersonRepo } from "./infra/repos/person-repo";
import type { KernelAuthUser, KernelVariables } from "./middleware/membership";
import { createF2Routes } from "./routes/f2";

const DB_PATH = path.join(import.meta.dir, "..", "..", ".tmp-test-f2-adversarial.db");
const DB_URL = `file:${DB_PATH}`;

const TENANT_A = "tenant-f2-adv-a";
const TENANT_B = "tenant-f2-adv-b";

const WIPE_TABLES = [
  "financial_documents",
  "allocations",
  "ledger_entries",
  "tenant_ledger_integrity",
  "payments",
  "f2_bank_movements",
  "settlement_policies",
  "accounting_periods",
  "condo_bank_connections",
  "obligations",
  "annual_budget_lines",
  "annual_budgets",
  "constitution_fracoes",
  "extract_lines",
  "ingest_documents",
  "owner_contact_drafts",
  "memberships",
  "persons",
  "audit_events",
  "domain_events",
  "outbox_jobs",
  "notification_deliveries",
  "quotas",
] as const;

let client: ReturnType<typeof createClient>;
let deps: KernelDeps;
let currentUser: KernelAuthUser | null = null;
let tenantIdOverride = TENANT_A;
let app: Hono;

const MANAGER_ROUTES: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [
  { path: "/f2/payments/candidates", method: "POST", body: { movements: [{ amountCents: 100 }] } },
  {
    path: "/f2/bank-connections",
    method: "POST",
    body: { accountIban: "PT50001800034978380602065" },
  },
  { path: "/f2/bank-connections", method: "GET" },
  { path: "/f2/bank-connections/authorize", method: "POST", body: {} },
  { path: "/f2/bank-connections/reauthorize", method: "POST", body: {} },
  { path: "/f2/bank-connections/revoke", method: "POST", body: {} },
  { path: "/f2/bank-connections/sync", method: "POST", body: {} },
  { path: "/f2/jobs/reauth-notices", method: "POST", body: {} },
  { path: "/f2/jobs/monthly-notices", method: "POST", body: {} },
  { path: "/f2/jobs/receipt-sweep", method: "POST", body: {} },
  { path: "/f2/jobs/calendar-sweep", method: "POST", body: {} },
  { path: "/f2/jobs/bank-sync", method: "POST", body: {} },
];

async function seedFracaoWithObligations(tenantId: string, year = 2026) {
  const doc = await registerIngestDocument(deps, {
    tenantId,
    kind: INGEST_DOCUMENT_KINDS.regulamento,
    filename: `regulamento-${tenantId}.pdf`,
  });
  const { lines } = await extractDocumentLines(deps, {
    tenantId,
    documentId: doc.id,
    extraction: {
      lines: [
        {
          kind: "fracao",
          payload: { codigo: "A", permilagem: 1000 },
          sourceExcerpt: "A — 1000‰",
        },
      ],
    },
  });
  await confirmFracaoLines(deps, {
    tenantId,
    documentId: doc.id,
    confirmations: lines.map((l) => ({ lineId: l.id })),
  });
  const fracoes = await listConstitutionFracoes(deps, { tenantId });
  const budget = await createAnnualBudget(deps, {
    tenantId,
    year,
    title: `Orçamento ${year}`,
    lines: [
      { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Quota", amountCents: 10_000_00 },
      { kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 1_000_00 },
    ],
  });
  const approved = await approveBudgetAndCreateObligations(deps, {
    tenantId,
    budgetId: budget.budget.id,
  });
  return { fracao: fracoes[0]!, obligations: approved.obligations };
}

async function seedActor(
  tenantId: string,
  opts: { userId: string; roleCode: string; name: string; email: string },
) {
  const personRepo = createPersonRepo(deps.db);
  const membershipRepo = createMembershipRepo(deps.db);
  const person = await personRepo.insert({
    id: crypto.randomUUID(),
    userId: opts.userId,
    name: opts.name,
    email: opts.email,
    createdAt: new Date(),
  });
  const membership = await membershipRepo.insert({
    id: crypto.randomUUID(),
    personId: person.id,
    tenantId,
    roleCode: opts.roleCode,
    createdAt: new Date(),
  });
  return { person, membership };
}

async function seedConfirmedOwner(tenantId: string, fracaoCodigo: string, personName: string) {
  await deps.db.insert(ownerContactDrafts).values({
    id: crypto.randomUUID(),
    tenantId,
    fracaoCodigo,
    personName,
    status: "confirmed",
    sourceExcerpt: `${personName} — ${fracaoCodigo}`,
    createdAt: new Date(),
  });
}

async function countForTenant(table: string, tenantId: string): Promise<number> {
  const res = await client.execute(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`, [
    tenantId,
  ]);
  return Number(res.rows[0]!.n);
}

async function openAmountSum(tenantId: string): Promise<number> {
  const res = await client.execute(
    `SELECT COALESCE(SUM(open_amount_cents), 0) AS n FROM obligations WHERE tenant_id = ?`,
    [tenantId],
  );
  return Number(res.rows[0]!.n);
}

async function resetOutboxJobToPending(jobType: string, tenantId: string) {
  await client.execute({
    sql: `UPDATE outbox_jobs
          SET status = ?, processed_at = NULL, available_at = 0, last_error = NULL
          WHERE tenant_id = ? AND job_type = ?`,
    args: [OUTBOX_STATUS.pending, tenantId, jobType],
  });
}

function buildApp() {
  return new Hono<{ Variables: KernelVariables }>()
    .use(async (c, next) => {
      c.set("user", currentUser);
      await next();
    })
    .route("/f2", createF2Routes(deps));
}

beforeAll(async () => {
  try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  } catch {
    /* ignore */
  }
  client = createClient({ url: DB_URL });
  await client.execute("PRAGMA journal_mode=WAL");
  await client.execute("PRAGMA busy_timeout=8000");
  await applyDomainKernelSchema(client);
  await applyF1ConstitutionSchema(client);
  await applyF2FinanceSchema(client);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS quotas (
      id TEXT PRIMARY KEY NOT NULL,
      fracao_id TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'condominio',
      mes INTEGER NOT NULL,
      ano INTEGER NOT NULL,
      valor REAL NOT NULL,
      pago INTEGER NOT NULL DEFAULT 0
    )
  `);
  const db = drizzle(client, { schema });
  deps = { db, getTenantId: () => tenantIdOverride };
  app = buildApp();
});

beforeEach(async () => {
  currentUser = null;
  tenantIdOverride = TENANT_A;
  deps.now = undefined;
  for (const table of WIPE_TABLES) {
    await client.execute(`DELETE FROM ${table}`);
  }
});

afterAll(() => {
  try {
    client.close();
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  } catch {
    /* ignore */
  }
});

describe("F2 adversarial — isolamento multi-tenant", () => {
  test("A nunca lê/escreve payments, ledger, bank_connections ou outbox de B", async () => {
    const seededA = await seedFracaoWithObligations(TENANT_A, 2026);
    const seededB = await seedFracaoWithObligations(TENANT_B, 2027);
    const adminA = await seedActor(TENANT_A, {
      userId: "user-admin-a",
      roleCode: "Admin",
      name: "Admin A",
      email: "admin-a@test",
    });
    const adminB = await seedActor(TENANT_B, {
      userId: "user-admin-b",
      roleCode: "Admin",
      name: "Admin B",
      email: "admin-b@test",
    });
    await seedConfirmedOwner(TENANT_A, "A", "Maria Silva");
    await seedConfirmedOwner(TENANT_B, "A", "Maria Silva");

    const payA = await registerPayment(deps, {
      tenantId: TENANT_A,
      fracaoId: seededA.fracao.id,
      amountCents: 20_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
      actor: { personId: adminA.person.id },
    });
    const payB = await registerPayment(deps, {
      tenantId: TENANT_B,
      fracaoId: seededB.fracao.id,
      amountCents: 20_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
      actor: { personId: adminB.person.id },
    });
    await allocatePayment(deps, { tenantId: TENANT_A, paymentId: payA.id });
    await allocatePayment(deps, { tenantId: TENANT_B, paymentId: payB.id });

    const ibanA = "PT50001800034978380602065";
    const ibanB = "PT50000700000000000000000";
    deps.now = () => new Date("2026-09-10T12:00:00.000Z");
    await upsertBankConnection(deps, {
      tenantId: TENANT_A,
      accountIban: ibanA,
      consentStatus: BANK_CONSENT_STATUS.authorized,
      consentValidUntil: "2026-09-20T00:00:00.000Z",
      authorizedByMembershipId: adminA.membership.id,
    });
    await upsertBankConnection(deps, {
      tenantId: TENANT_B,
      accountIban: ibanB,
      consentStatus: BANK_CONSENT_STATUS.authorized,
      consentValidUntil: "2026-09-20T00:00:00.000Z",
      authorizedByMembershipId: adminB.membership.id,
    });

    const listedA = await listBankConnections(deps, TENANT_A);
    const listedB = await listBankConnections(deps, TENANT_B);
    expect(listedA.map((r) => r.accountIban)).toEqual([ibanA]);
    expect(listedB.map((r) => r.accountIban)).toEqual([ibanB]);
    expect(listedA.some((r) => r.accountIban === ibanB)).toBe(false);
    expect(listedB.some((r) => r.accountIban === ibanA)).toBe(false);

    await expect(
      allocatePayment(deps, { tenantId: TENANT_A, paymentId: payB.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      issueReceiptForPayment(deps, { tenantId: TENANT_A, paymentId: payB.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      registerPayment(deps, {
        tenantId: TENANT_A,
        fracaoId: seededB.fracao.id,
        amountCents: 1_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      }),
    ).rejects.toMatchObject({ code: "fracao_not_found" });

    const movementB = await recordKernelBankMovement(deps, {
      tenantId: TENANT_B,
      amountCents: 5_000,
    });
    const cashA = await registerPayment(deps, {
      tenantId: TENANT_A,
      fracaoId: seededA.fracao.id,
      amountCents: 5_000,
      paymentMethod: PAYMENT_METHODS.cash,
      evidenceUploadId: "ev-cross",
      actor: { personId: adminA.person.id },
    });
    await expect(
      verifyCashPayment(deps, {
        tenantId: TENANT_A,
        paymentId: cashA.id,
        verificationMethod: VERIFICATION_METHOD.bankDeposit,
        bankMovementId: movementB.id,
        actor: { personId: adminA.person.id },
      }),
    ).rejects.toMatchObject({ code: "bank_movement_not_found" });

    const sharedRef = "shared-external-ref-1";
    const ingestA = await ingestCandidateMovement(deps, {
      tenantId: TENANT_A,
      movement: {
        amountCents: 50_00,
        description: "TRF CRED SEPA+ DE MARIA SILVA",
        externalRef: sharedRef,
        source: CANDIDATE_SOURCES.identityMatrix,
      },
    });
    const ingestB = await ingestCandidateMovement(deps, {
      tenantId: TENANT_B,
      movement: {
        amountCents: 50_00,
        description: "TRF CRED SEPA+ DE MARIA SILVA",
        externalRef: sharedRef,
        source: CANDIDATE_SOURCES.identityMatrix,
      },
    });
    expect(ingestA.paymentId).not.toBe(ingestB.paymentId);
    expect(ingestA.fracaoId).toBe(seededA.fracao.id);
    expect(ingestB.fracaoId).toBe(seededB.fracao.id);

    const noticedA = await sweepBankReauthNotices(deps, { tenantId: TENANT_A });
    expect(noticedA.noticed.some((n) => n.noticed)).toBe(true);
    const noticesB = await sweepBankReauthNotices(deps, { tenantId: TENANT_B });
    expect(noticesB.noticed.some((n) => n.noticed)).toBe(true);

    const jobsA = await client.execute(
      `SELECT id, job_type FROM outbox_jobs WHERE tenant_id = ?`,
      [TENANT_A],
    );
    const jobsB = await client.execute(
      `SELECT id FROM outbox_jobs WHERE tenant_id = ?`,
      [TENANT_B],
    );
    expect(jobsA.rows.length).toBeGreaterThan(0);
    expect(jobsB.rows.length).toBeGreaterThan(0);
    const idsA = new Set(jobsA.rows.map((r) => String(r.id)));
    expect(jobsB.rows.some((r) => idsA.has(String(r.id)))).toBe(false);
    expect(jobsA.rows.some((r) => r.job_type === OUTBOX_JOB_TYPES.bankReauthNotice)).toBe(true);

    const chainA = await validateLedgerChain(deps, { tenantId: TENANT_A });
    const chainB = await validateLedgerChain(deps, { tenantId: TENANT_B });
    expect(chainA.ok).toBe(true);
    expect(chainB.ok).toBe(true);
    expect(chainA.entries).toBeGreaterThan(0);
    expect(chainB.entries).toBeGreaterThan(0);

    expect(await countForTenant("payments", TENANT_A)).toBeGreaterThan(0);
    expect(await countForTenant("payments", TENANT_B)).toBeGreaterThan(0);
    expect(await countForTenant("ledger_entries", TENANT_A)).toBe(chainA.entries);
    expect(await countForTenant("ledger_entries", TENANT_B)).toBe(chainB.entries);

    tenantIdOverride = TENANT_A;
    currentUser = { id: adminA.person.userId!, email: "admin-a@test" };
    const httpListA = await app.request("/f2/bank-connections");
    expect(httpListA.status).toBe(200);
    const bodyA = (await httpListA.json()) as {
      connections: Array<{ accountIban: string | null }>;
    };
    expect(bodyA.connections.map((c) => c.accountIban)).toEqual([ibanA]);

    const httpAllocB = await app.request(`/f2/payments/${payB.id}/allocate`, { method: "POST" });
    expect(httpAllocB.status).toBe(404);

    tenantIdOverride = TENANT_B;
    currentUser = { id: adminB.person.userId!, email: "admin-b@test" };
    const httpListB = await app.request("/f2/bank-connections");
    expect(httpListB.status).toBe(200);
    const bodyB = (await httpListB.json()) as {
      connections: Array<{ accountIban: string | null }>;
    };
    expect(bodyB.connections.map((c) => c.accountIban)).toEqual([ibanB]);

    const noticesAOnly = await generateMonthlyPaymentNotices(deps, {
      tenantId: TENANT_A,
      force: true,
    });
    expect(noticesAOnly.issued.length + noticesAOnly.reused.length).toBe(1);
    expect(await countForTenant("financial_documents", TENANT_B)).toBe(0);
  });
});

describe("F2 adversarial — concorrência allocate + ingest", () => {
  test("allocate + ingest em paralelo: sequences e external_ref únicos, sem double-spend", async () => {
    const { fracao, obligations: obs } = await seedFracaoWithObligations(TENANT_A);
    const keep = obs[0]!;
    await client.execute({
      sql: `UPDATE obligations SET open_amount_cents = 10000, amount_cents = 10000 WHERE id = ?`,
      args: [keep.id],
    });
    for (const o of obs.slice(1)) {
      await client.execute({
        sql: `UPDATE obligations SET open_amount_cents = 0, status = 'paid' WHERE id = ?`,
        args: [o.id],
      });
    }

    const p1 = await registerPayment(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      amountCents: 10_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
    });
    const p2 = await registerPayment(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      amountCents: 10_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
    });
    const movement = {
      amountCents: 12_00,
      description: "TRF CRED SEPA+ DE DESCONHECIDO RACE",
      externalRef: "adv-race-ext-1",
      source: CANDIDATE_SOURCES.reconciliation,
    };

    const clientA = createClient({ url: DB_URL });
    const clientB = createClient({ url: DB_URL });
    try {
      await clientA.execute("PRAGMA busy_timeout=250");
      await clientB.execute("PRAGMA busy_timeout=250");
      const depsA: KernelDeps = { db: drizzle(clientA, { schema }), getTenantId: () => TENANT_A };
      const depsB: KernelDeps = { db: drizzle(clientB, { schema }), getTenantId: () => TENANT_A };

      const settled = await Promise.allSettled([
        allocatePayment(depsA, { tenantId: TENANT_A, paymentId: p1.id }),
        allocatePayment(depsB, { tenantId: TENANT_A, paymentId: p2.id }),
        ingestCandidateMovement(depsA, { tenantId: TENANT_A, movement }),
        ingestCandidateMovement(depsB, { tenantId: TENANT_A, movement }),
      ]);
      expect(settled.filter((s) => s.status === "fulfilled").length).toBeGreaterThanOrEqual(2);
    } finally {
      clientA.close();
      clientB.close();
    }

    const seq = await client.execute(
      `SELECT sequence FROM ledger_entries WHERE tenant_id = ? ORDER BY sequence`,
      [TENANT_A],
    );
    const sequences = seq.rows.map((r) => Number(r.sequence));
    expect(new Set(sequences).size).toBe(sequences.length);

    const paymentsCount = await client.execute(
      `SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ? AND external_ref = ?`,
      [TENANT_A, "adv-race-ext-1"],
    );
    expect(Number(paymentsCount.rows[0]!.n)).toBe(1);
    const movementsCount = await client.execute(
      `SELECT COUNT(*) AS n FROM f2_bank_movements WHERE tenant_id = ? AND external_ref = ?`,
      [TENANT_A, "adv-race-ext-1"],
    );
    expect(Number(movementsCount.rows[0]!.n)).toBe(1);

    const chain = await validateLedgerChain(deps, { tenantId: TENANT_A });
    expect(chain.ok).toBe(true);

    const openCents = Number(
      (
        await client.execute(`SELECT open_amount_cents FROM obligations WHERE id = ?`, [keep.id])
      ).rows[0]!.open_amount_cents,
    );
    expect(openCents).toBeGreaterThanOrEqual(0);
    expect(openCents).toBe(0);

    const allocSum = await client.execute(
      `SELECT COALESCE(SUM(amount_cents), 0) AS t FROM allocations WHERE obligation_id = ?`,
      [keep.id],
    );
    expect(Number(allocSum.rows[0]!.t)).toBe(10_000);
  }, 20_000);
});

describe("F2 adversarial — cash", () => {
  test("Obligation não liquida em registered; Fiscalizacao ≠ registante; depósito tenant-scoped", async () => {
    const { fracao } = await seedFracaoWithObligations(TENANT_A);
    const admin = await seedActor(TENANT_A, {
      userId: "user-admin-cash",
      roleCode: "Admin",
      name: "Admin Cash",
      email: "admin-cash@test",
    });
    const fiscal = await seedActor(TENANT_A, {
      userId: "user-fiscal-cash",
      roleCode: "Fiscalizacao",
      name: "Fiscal Cash",
      email: "fiscal-cash@test",
    });

    const openBefore = await openAmountSum(TENANT_A);
    const payment = await registerPayment(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      amountCents: 5_000,
      paymentMethod: PAYMENT_METHODS.cash,
      evidenceUploadId: "ev-adv-cash",
      actor: { personId: admin.person.id },
    });
    expect(payment.cashStatus).toBe(CASH_STATUS.registered);
    expect(await openAmountSum(TENANT_A)).toBe(openBefore);
    const allocs = await client.execute(
      `SELECT COUNT(*) AS n FROM allocations WHERE payment_id = ?`,
      [payment.id],
    );
    expect(Number(allocs.rows[0]!.n)).toBe(0);

    await expect(
      allocatePayment(deps, { tenantId: TENANT_A, paymentId: payment.id }),
    ).rejects.toMatchObject({ code: "cash_not_verified" });
    expect(await openAmountSum(TENANT_A)).toBe(openBefore);

    await expect(
      verifyCashPayment(deps, {
        tenantId: TENANT_A,
        paymentId: payment.id,
        verificationMethod: VERIFICATION_METHOD.secondPerson,
        actor: { personId: admin.person.id },
      }),
    ).rejects.toMatchObject({ code: "self_verify_forbidden" });

    const verified = await verifyCashPayment(deps, {
      tenantId: TENANT_A,
      paymentId: payment.id,
      verificationMethod: VERIFICATION_METHOD.secondPerson,
      actor: { personId: fiscal.person.id },
    });
    expect(verified.cashStatus).toBe(CASH_STATUS.verified);
    expect(await openAmountSum(TENANT_A)).toBe(openBefore);

    await expect(
      depositCashPayment(deps, {
        tenantId: TENANT_A,
        paymentId: payment.id,
        actor: { personId: admin.person.id },
      }),
    ).rejects.toMatchObject({ code: "bank_movement_required" });

    const foreign = await recordKernelBankMovement(deps, {
      tenantId: TENANT_B,
      amountCents: 5_000,
    });
    await expect(
      depositCashPayment(deps, {
        tenantId: TENANT_A,
        paymentId: payment.id,
        bankMovementId: foreign.id,
        actor: { personId: admin.person.id },
      }),
    ).rejects.toMatchObject({ code: "bank_movement_not_found" });

    const movement = await recordKernelBankMovement(deps, {
      tenantId: TENANT_A,
      amountCents: 5_000,
    });
    const deposited = await depositCashPayment(deps, {
      tenantId: TENANT_A,
      paymentId: payment.id,
      bankMovementId: movement.id,
      actor: { personId: admin.person.id },
    });
    expect(deposited.cashStatus).toBe(CASH_STATUS.deposited);
    expect(deposited.bankMovementId).toBe(movement.id);
  });
});

describe("F2 adversarial — AuthZ gestor", () => {
  test("Owner / Fiscalizacao / sem membership → 403 nas rotas gestor", async () => {
    const owner = await seedActor(TENANT_A, {
      userId: "user-owner-adv",
      roleCode: "Owner",
      name: "Owner Adv",
      email: "owner-adv@test",
    });
    const fiscal = await seedActor(TENANT_A, {
      userId: "user-fiscal-adv",
      roleCode: "Fiscalizacao",
      name: "Fiscal Adv",
      email: "fiscal-adv@test",
    });
    const noMem = await createPersonRepo(deps.db).insert({
      id: crypto.randomUUID(),
      userId: "user-no-mem-adv",
      name: "Sem Membership",
      email: "no-mem-adv@test",
      createdAt: new Date(),
    });

    for (const actor of [
      { email: owner.person.email, userId: owner.person.userId! },
      { email: fiscal.person.email, userId: fiscal.person.userId! },
      { email: noMem.email, userId: noMem.userId! },
    ]) {
      currentUser = { id: actor.userId, email: actor.email };
      for (const route of MANAGER_ROUTES) {
        const res = await app.request(route.path, {
          method: route.method,
          headers: route.body ? { "content-type": "application/json" } : undefined,
          body: route.body ? JSON.stringify(route.body) : undefined,
        });
        expect({
          who: actor.email,
          method: route.method,
          path: route.path,
          status: res.status,
        }).toEqual({
          who: actor.email,
          method: route.method,
          path: route.path,
          status: 403,
        });
      }
    }
  });
});

describe("F2 adversarial — reauth", () => {
  test("destino nunca é IBAN; sem gestor → admin@invalid + skipped; com gestor → email real", async () => {
    const iban = "PT50001800034978380602065";
    deps.now = () => new Date("2026-09-10T12:00:00.000Z");

    await upsertBankConnection(deps, {
      tenantId: TENANT_A,
      accountIban: iban,
      consentStatus: BANK_CONSENT_STATUS.authorized,
      consentValidUntil: "2026-09-20T00:00:00.000Z",
    });
    await sweepBankReauthNotices(deps, { tenantId: TENANT_A });
    await processOutbox(deps);

    const none = await client.execute(
      `SELECT destination, status FROM notification_deliveries
       WHERE tenant_id = ? AND template = 'bank_reauth_required'`,
      [TENANT_A],
    );
    expect(none.rows.length).toBe(1);
    expect(String(none.rows[0]!.destination)).toBe(BANK_REAUTH_ADMIN_FALLBACK);
    expect(String(none.rows[0]!.destination)).not.toBe(iban);
    expect(String(none.rows[0]!.destination).startsWith("PT")).toBe(false);
    expect(String(none.rows[0]!.status)).toBe("skipped");
    expect(isResolvedAdminMailbox(BANK_REAUTH_ADMIN_FALLBACK)).toBe(false);

    await client.execute(`DELETE FROM notification_deliveries`);
    await client.execute(`DELETE FROM outbox_jobs`);
    await client.execute(`DELETE FROM condo_bank_connections`);

    const admin = await seedActor(TENANT_A, {
      userId: "user-admin-reauth-adv",
      roleCode: "Admin",
      name: "Admin Reauth Adv",
      email: "admin-reauth-adv@test",
    });
    await upsertBankConnection(deps, {
      tenantId: TENANT_A,
      accountIban: iban,
      consentStatus: BANK_CONSENT_STATUS.authorized,
      consentValidUntil: "2026-09-20T00:00:00.000Z",
      authorizedByMembershipId: admin.membership.id,
    });
    await sweepBankReauthNotices(deps, { tenantId: TENANT_A });
    await processOutbox(deps);
    const withAdmin = await client.execute(
      `SELECT destination, status FROM notification_deliveries
       WHERE tenant_id = ? AND template = 'bank_reauth_required'`,
      [TENANT_A],
    );
    expect(withAdmin.rows.length).toBe(1);
    expect(String(withAdmin.rows[0]!.destination)).toBe("admin-reauth-adv@test");
    expect(String(withAdmin.rows[0]!.destination)).not.toBe(iban);
    expect(String(withAdmin.rows[0]!.status)).toBe("attempted");
  });
});

describe("F2 adversarial — identity", () => {
  test("ANA ⊄ JOANA/MARIANA; caps csv/movements → 400", async () => {
    const { fracao } = await seedFracaoWithObligations(TENANT_A);
    await seedConfirmedOwner(TENANT_A, "A", "Mariana Silva");
    await seedConfirmedOwner(TENANT_A, "A", "Joana Costa");

    expect(identityNameMatches("ANA", "MARIANA")).toBe(false);
    expect(identityNameMatches("ANA", "JOANA")).toBe(false);
    expect(identityNameMatches("ANA", "Mariana Silva")).toBe(false);
    expect(identityNameMatches("ANA", "Joana Costa")).toBe(false);

    const miss = await ingestCandidateMovements(deps, {
      tenantId: TENANT_A,
      movements: [
        {
          amountCents: 50_00,
          description: "TRF CRED SEPA+ DE ANA",
          externalRef: "ana-false-1",
          source: CANDIDATE_SOURCES.identityMatrix,
        },
      ],
    });
    expect(miss.results[0]!.fracaoId).toBeNull();
    expect(miss.results[0]!.allocationStatus).toBe(ALLOCATION_STATUS.naoAlocadoPendente);

    const hit = await ingestCandidateMovements(deps, {
      tenantId: TENANT_A,
      movements: [
        {
          amountCents: 50_00,
          description: "TRF CRED SEPA+ DE MARIANA SILVA",
          externalRef: "mariana-hit-1",
          source: CANDIDATE_SOURCES.identityMatrix,
        },
      ],
    });
    expect(hit.results[0]!.fracaoId).toBe(fracao.id);

    const admin = await seedActor(TENANT_A, {
      userId: "user-admin-id-adv",
      roleCode: "Admin",
      name: "Admin Id",
      email: "admin-id-adv@test",
    });
    currentUser = { id: admin.person.userId!, email: admin.person.email };

    const tooMany = await app.request("/f2/payments/candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        movements: Array.from({ length: MAX_CANDIDATE_MOVEMENTS + 1 }, (_, i) => ({
          amountCents: 100,
          externalRef: `cap-${i}`,
        })),
      }),
    });
    expect(tooMany.status).toBe(400);
    expect(((await tooMany.json()) as { message: string }).message).toContain("movements[]");

    const tooBigCsv = await app.request("/f2/payments/candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csvText: "x".repeat(MAX_CANDIDATE_CSV_CHARS + 1) }),
    });
    expect(tooBigCsv.status).toBe(400);
    expect(((await tooBigCsv.json()) as { message: string }).message).toContain("csvText");
  });
});

describe("F2 adversarial — hash-chain", () => {
  test("adulteração em A é detetável via ledger/validate e não parte a cadeia de B", async () => {
    const seededA = await seedFracaoWithObligations(TENANT_A, 2026);
    const seededB = await seedFracaoWithObligations(TENANT_B, 2027);
    const adminA = await seedActor(TENANT_A, {
      userId: "user-admin-hash-a",
      roleCode: "Admin",
      name: "Admin Hash A",
      email: "admin-hash-a@test",
    });

    const payA = await registerPayment(deps, {
      tenantId: TENANT_A,
      fracaoId: seededA.fracao.id,
      amountCents: 20_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
    });
    const payB = await registerPayment(deps, {
      tenantId: TENANT_B,
      fracaoId: seededB.fracao.id,
      amountCents: 20_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
    });
    await allocatePayment(deps, { tenantId: TENANT_A, paymentId: payA.id });
    await allocatePayment(deps, { tenantId: TENANT_B, paymentId: payB.id });

    expect((await validateLedgerChain(deps, { tenantId: TENANT_A })).ok).toBe(true);
    expect((await validateLedgerChain(deps, { tenantId: TENANT_B })).ok).toBe(true);

    const tip = await client.execute(
      `SELECT id FROM ledger_entries WHERE tenant_id = ? AND entry_type = 'allocation' LIMIT 1`,
      [TENANT_A],
    );
    await client.execute({
      sql: `UPDATE ledger_entries SET payload_json = ? WHERE id = ?`,
      args: ['{"tampered":true}', String(tip.rows[0]!.id)],
    });

    const broken = await validateLedgerChain(deps, { tenantId: TENANT_A });
    expect(broken.ok).toBe(false);
    expect((await validateLedgerChain(deps, { tenantId: TENANT_B })).ok).toBe(true);

    tenantIdOverride = TENANT_A;
    currentUser = { id: adminA.person.userId!, email: adminA.person.email };
    const httpBroken = await app.request("/f2/ledger/validate", { method: "POST" });
    expect(httpBroken.status).toBe(200);
    const httpBody = (await httpBroken.json()) as { ok: boolean };
    expect(httpBody.ok).toBe(false);

    await expect(
      registerPayment(deps, {
        tenantId: TENANT_A,
        fracaoId: seededA.fracao.id,
        amountCents: 1_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      }),
    ).rejects.toMatchObject({ code: "ledger_chain_broken" });
    await expect(
      registerPayment(deps, {
        tenantId: TENANT_B,
        fracaoId: seededB.fracao.id,
        amountCents: 1_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      }),
    ).resolves.toMatchObject({ tenantId: TENANT_B });
  });
});

describe("F2 adversarial — idempotência outbox", () => {
  test("retry de notify.bank_reauth e f2.issue_receipt não duplica efeitos observáveis", async () => {
    const { fracao } = await seedFracaoWithObligations(TENANT_A);
    const admin = await seedActor(TENANT_A, {
      userId: "user-admin-outbox",
      roleCode: "Admin",
      name: "Admin Outbox",
      email: "admin-outbox@test",
    });

    deps.now = () => new Date("2026-09-10T12:00:00.000Z");
    await upsertBankConnection(deps, {
      tenantId: TENANT_A,
      accountIban: "PT50001800034978380602065",
      consentStatus: BANK_CONSENT_STATUS.authorized,
      consentValidUntil: "2026-09-20T00:00:00.000Z",
      authorizedByMembershipId: admin.membership.id,
    });
    const firstSweep = await sweepBankReauthNotices(deps, { tenantId: TENANT_A });
    expect(firstSweep.noticed.some((n) => n.noticed)).toBe(true);
    const secondSweep = await sweepBankReauthNotices(deps, { tenantId: TENANT_A });
    expect(secondSweep.noticed.every((n) => n.noticed === false)).toBe(true);

    const reauthJobs = await client.execute(
      `SELECT COUNT(*) AS n FROM outbox_jobs WHERE tenant_id = ? AND job_type = ?`,
      [TENANT_A, OUTBOX_JOB_TYPES.bankReauthNotice],
    );
    expect(Number(reauthJobs.rows[0]!.n)).toBe(1);

    await processOutbox(deps);
    await resetOutboxJobToPending(OUTBOX_JOB_TYPES.bankReauthNotice, TENANT_A);
    await processOutbox(deps);

    const deliveries = await client.execute(
      `SELECT destination FROM notification_deliveries
       WHERE tenant_id = ? AND template = 'bank_reauth_required'`,
      [TENANT_A],
    );
    expect(deliveries.rows.length).toBe(1);
    expect(String(deliveries.rows[0]!.destination)).toBe("admin-outbox@test");

    const payment = await registerPayment(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      amountCents: 20_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
    });
    await allocatePayment(deps, { tenantId: TENANT_A, paymentId: payment.id });

    const receiptJobs = await client.execute(
      `SELECT COUNT(*) AS n FROM outbox_jobs WHERE tenant_id = ? AND job_type = ?`,
      [TENANT_A, OUTBOX_JOB_TYPES.issueReceipt],
    );
    expect(Number(receiptJobs.rows[0]!.n)).toBe(1);

    await processOutbox(deps);
    await resetOutboxJobToPending(OUTBOX_JOB_TYPES.issueReceipt, TENANT_A);
    await processOutbox(deps);
    await issueReceiptForPayment(deps, { tenantId: TENANT_A, paymentId: payment.id });

    const receipts = await client.execute(
      `SELECT id FROM financial_documents
       WHERE tenant_id = ? AND doc_type = 'Receipt' AND source_payment_id = ?`,
      [TENANT_A, payment.id],
    );
    expect(receipts.rows.length).toBe(1);
  });
});
