/**
 * F2 — testes adversariais do Finance Kernel (ordem §8, 06-FATIAS).
 * Astra A5: HTTP real via `createF2Routes` + Membership; use cases só onde o HTTP
 * não chega (concorrência 2 clientes, job sem gestor). Sem modelo financeiro paralelo.
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
  recordKernelBankMovement,
} from "./application/finance/f2-finance";
import {
  ingestCandidateMovement,
  MAX_CANDIDATE_CSV_CHARS,
  MAX_CANDIDATE_MOVEMENTS,
} from "./application/finance/f2-candidates";
import {
  BANK_REAUTH_ADMIN_FALLBACK,
  isResolvedAdminMailbox,
  sweepBankReauthNotices,
  upsertBankConnection,
} from "./application/finance/f2-bank-connection";
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
import { systemAuditActor } from "./domain/audit";

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
    { path: "/f2/payments", method: "GET" },
    {
      path: "/f2/payments/x/allocations/y/reverse",
      method: "POST",
      body: {},
    },
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

type SeededActor = Awaited<ReturnType<typeof seedActor>>;

function authUser(person: SeededActor["person"]): KernelAuthUser {
  return { id: person.userId!, email: person.email ?? undefined };
}

async function f2Request(
  path: string,
  init?: { method?: string; body?: unknown; user?: SeededActor["person"] | KernelAuthUser | null },
): Promise<Response> {
  if (init && "user" in init) {
    const u = init.user;
    if (!u) currentUser = null;
    else if ("userId" in u) currentUser = authUser(u);
    else currentUser = u;
  }
  const method = init?.method ?? (init?.body !== undefined ? "POST" : "GET");
  return app.request(path, {
    method,
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function f2Json<T>(
  path: string,
  init?: { method?: string; body?: unknown; user?: SeededActor["person"] | KernelAuthUser | null },
): Promise<{ status: number; body: T }> {
  const res = await f2Request(path, init);
  return { status: res.status, body: (await res.json()) as T };
}

async function expectDomainCode(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { code?: string };
  expect(body.code).toBe(code);
  return body;
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

    const payA = await f2Json<{ id: string }>("/f2/payments", {
      user: adminA.person,
      body: {
        fracaoId: seededA.fracao.id,
        amountCents: 20_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(payA.status).toBe(201);
    tenantIdOverride = TENANT_B;
    const payB = await f2Json<{ id: string }>("/f2/payments", {
      user: adminB.person,
      body: {
        fracaoId: seededB.fracao.id,
        amountCents: 20_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(payB.status).toBe(201);
    tenantIdOverride = TENANT_A;
    const allocA = await f2Request(`/f2/payments/${payA.body.id}/allocate`, {
      user: adminA.person,
      method: "POST",
    });
    expect(allocA.status).toBe(200);
    tenantIdOverride = TENANT_B;
    const allocB = await f2Request(`/f2/payments/${payB.body.id}/allocate`, {
      user: adminB.person,
      method: "POST",
    });
    expect(allocB.status).toBe(200);

    const ibanA = "PT50001800034978380602065";
    const ibanB = "PT50000700000000000000000";
    deps.now = () => new Date("2026-09-10T12:00:00.000Z");
    tenantIdOverride = TENANT_A;
    await f2Request("/f2/bank-connections", {
      user: adminA.person,
      body: {
        accountIban: ibanA,
        consentStatus: BANK_CONSENT_STATUS.authorized,
        consentValidUntil: "2026-09-20T00:00:00.000Z",
        authorizedByMembershipId: adminA.membership.id,
      },
    });
    tenantIdOverride = TENANT_B;
    await f2Request("/f2/bank-connections", {
      user: adminB.person,
      body: {
        accountIban: ibanB,
        consentStatus: BANK_CONSENT_STATUS.authorized,
        consentValidUntil: "2026-09-20T00:00:00.000Z",
        authorizedByMembershipId: adminB.membership.id,
      },
    });

    tenantIdOverride = TENANT_A;
    const listedAHttp = await f2Json<{ connections: Array<{ accountIban: string | null }> }>(
      "/f2/bank-connections",
      { user: adminA.person, method: "GET" },
    );
    expect(listedAHttp.status).toBe(200);
    expect(listedAHttp.body.connections.map((c) => c.accountIban)).toEqual([ibanA]);
    tenantIdOverride = TENANT_B;
    const listedBHttp = await f2Json<{ connections: Array<{ accountIban: string | null }> }>(
      "/f2/bank-connections",
      { user: adminB.person, method: "GET" },
    );
    expect(listedBHttp.status).toBe(200);
    expect(listedBHttp.body.connections.map((c) => c.accountIban)).toEqual([ibanB]);

    tenantIdOverride = TENANT_A;
    await expectDomainCode(
      await f2Request(`/f2/payments/${payB.body.id}/allocate`, {
        user: adminA.person,
        method: "POST",
      }),
      404,
      "not_found",
    );
    await expectDomainCode(
      await f2Request(`/f2/payments/${payB.body.id}/receipt`, {
        user: adminA.person,
        method: "POST",
      }),
      404,
      "not_found",
    );
    await expectDomainCode(
      await f2Request("/f2/payments", {
        user: adminA.person,
        body: {
          fracaoId: seededB.fracao.id,
          amountCents: 1_000,
          paymentMethod: PAYMENT_METHODS.bankTransfer,
        },
      }),
      404,
      "fracao_not_found",
    );

    const movementB = await recordKernelBankMovement(deps, {
      tenantId: TENANT_B,
      amountCents: 5_000,
    });
    tenantIdOverride = TENANT_A;
    const cashA = await f2Json<{ id: string }>("/f2/payments", {
      user: adminA.person,
      body: {
        fracaoId: seededA.fracao.id,
        amountCents: 5_000,
        paymentMethod: PAYMENT_METHODS.cash,
        evidenceUploadId: "ev-cross",
      },
    });
    expect(cashA.status).toBe(201);
    await expectDomainCode(
      await f2Request(`/f2/payments/${cashA.body.id}/verify-cash`, {
        user: adminA.person,
        body: {
          verificationMethod: VERIFICATION_METHOD.bankDeposit,
          bankMovementId: movementB.id,
        },
      }),
      404,
      "bank_movement_not_found",
    );

    const sharedRef = "shared-external-ref-1";
    tenantIdOverride = TENANT_A;
    const ingestA = await f2Json<{
      results: Array<{ paymentId: string; fracaoId: string | null }>;
    }>("/f2/payments/candidates", {
      user: adminA.person,
      body: {
        movements: [
          {
            amountCents: 50_00,
            description: "TRF CRED SEPA+ DE MARIA SILVA",
            externalRef: sharedRef,
            source: CANDIDATE_SOURCES.identityMatrix,
          },
        ],
      },
    });
    tenantIdOverride = TENANT_B;
    const ingestB = await f2Json<{
      results: Array<{ paymentId: string; fracaoId: string | null }>;
    }>("/f2/payments/candidates", {
      user: adminB.person,
      body: {
        movements: [
          {
            amountCents: 50_00,
            description: "TRF CRED SEPA+ DE MARIA SILVA",
            externalRef: sharedRef,
            source: CANDIDATE_SOURCES.identityMatrix,
          },
        ],
      },
    });
    expect(ingestA.status).toBe(201);
    expect(ingestB.status).toBe(201);
    expect(ingestA.body.results[0]!.paymentId).not.toBe(ingestB.body.results[0]!.paymentId);
    expect(ingestA.body.results[0]!.fracaoId).toBe(seededA.fracao.id);
    expect(ingestB.body.results[0]!.fracaoId).toBe(seededB.fracao.id);

    const noticedA = await sweepBankReauthNotices(deps, {
      tenantId: TENANT_A,
      actor: systemAuditActor("job-reauth-tenant-a"),
    });
    expect(noticedA.noticed.some((n) => n.noticed)).toBe(true);
    const noticesB = await sweepBankReauthNotices(deps, {
      tenantId: TENANT_B,
      actor: systemAuditActor("job-reauth-tenant-b"),
    });
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

    tenantIdOverride = TENANT_A;
    const chainA = await f2Json<{ ok: boolean; entries: number }>("/f2/ledger/validate", {
      user: adminA.person,
      method: "POST",
    });
    tenantIdOverride = TENANT_B;
    const chainB = await f2Json<{ ok: boolean; entries: number }>("/f2/ledger/validate", {
      user: adminB.person,
      method: "POST",
    });
    expect(chainA.status).toBe(200);
    expect(chainB.status).toBe(200);
    expect(chainA.body.ok).toBe(true);
    expect(chainB.body.ok).toBe(true);
    expect(chainA.body.entries).toBeGreaterThan(0);
    expect(chainB.body.entries).toBeGreaterThan(0);

    expect(await countForTenant("payments", TENANT_A)).toBeGreaterThan(0);
    expect(await countForTenant("payments", TENANT_B)).toBeGreaterThan(0);
    expect(await countForTenant("ledger_entries", TENANT_A)).toBe(chainA.body.entries);
    expect(await countForTenant("ledger_entries", TENANT_B)).toBe(chainB.body.entries);

    tenantIdOverride = TENANT_A;
    const noticesAOnly = await f2Json<{ issued: string[]; reused: string[] }>(
      "/f2/jobs/monthly-notices",
      { user: adminA.person, body: { force: true } },
    );
    expect(noticesAOnly.status).toBe(200);
    expect(noticesAOnly.body.issued.length + noticesAOnly.body.reused.length).toBe(1);
    expect(await countForTenant("financial_documents", TENANT_B)).toBe(0);
  });
});

describe("F2 adversarial — concorrência allocate + ingest", () => {
  test("allocate + ingest em paralelo: sequences e external_ref únicos, sem double-spend", async () => {
    const { fracao, obligations: obs } = await seedFracaoWithObligations(TENANT_A);
    const admin = await seedActor(TENANT_A, {
      userId: "user-admin-race-adv",
      roleCode: "Admin",
      name: "Admin Race",
      email: "admin-race-adv@test",
    });
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

    const p1 = await f2Json<{ id: string }>("/f2/payments", {
      user: admin.person,
      body: {
        fracaoId: fracao.id,
        amountCents: 10_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    const p2 = await f2Json<{ id: string }>("/f2/payments", {
      user: admin.person,
      body: {
        fracaoId: fracao.id,
        amountCents: 10_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(p1.status).toBe(201);
    expect(p2.status).toBe(201);
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

      const actor = { personId: admin.person.id, userId: admin.person.userId };
      const settled = await Promise.allSettled([
        allocatePayment(depsA, { tenantId: TENANT_A, paymentId: p1.body.id, actor }),
        allocatePayment(depsB, { tenantId: TENANT_A, paymentId: p2.body.id, actor }),
        ingestCandidateMovement(depsA, { tenantId: TENANT_A, movement, actor }),
        ingestCandidateMovement(depsB, { tenantId: TENANT_A, movement, actor }),
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

    const chain = await f2Json<{ ok: boolean }>("/f2/ledger/validate", {
      user: admin.person,
      method: "POST",
    });
    expect(chain.status).toBe(200);
    expect(chain.body.ok).toBe(true);

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
    const created = await f2Json<{ id: string; cashStatus: string }>("/f2/payments", {
      user: admin.person,
      body: {
        fracaoId: fracao.id,
        amountCents: 5_000,
        paymentMethod: PAYMENT_METHODS.cash,
        evidenceUploadId: "ev-adv-cash",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.cashStatus).toBe(CASH_STATUS.registered);
    expect(await openAmountSum(TENANT_A)).toBe(openBefore);
    const allocs = await client.execute(
      `SELECT COUNT(*) AS n FROM allocations WHERE payment_id = ?`,
      [created.body.id],
    );
    expect(Number(allocs.rows[0]!.n)).toBe(0);

    await expectDomainCode(
      await f2Request(`/f2/payments/${created.body.id}/allocate`, {
        user: admin.person,
        method: "POST",
      }),
      409,
      "cash_not_verified",
    );
    expect(await openAmountSum(TENANT_A)).toBe(openBefore);

    await expectDomainCode(
      await f2Request(`/f2/payments/${created.body.id}/verify-cash`, {
        user: admin.person,
        body: { verificationMethod: VERIFICATION_METHOD.secondPerson },
      }),
      403,
      "self_verify_forbidden",
    );

    const verified = await f2Json<{ cashStatus: string }>(
      `/f2/payments/${created.body.id}/verify-cash`,
      {
        user: fiscal.person,
        body: { verificationMethod: VERIFICATION_METHOD.secondPerson },
      },
    );
    expect(verified.status).toBe(200);
    expect(verified.body.cashStatus).toBe(CASH_STATUS.verified);
    expect(await openAmountSum(TENANT_A)).toBe(openBefore);

    await expectDomainCode(
      await f2Request(`/f2/payments/${created.body.id}/deposit-cash`, {
        user: admin.person,
        body: {},
      }),
      400,
      "bank_movement_required",
    );

    const foreign = await recordKernelBankMovement(deps, {
      tenantId: TENANT_B,
      amountCents: 5_000,
    });
    await expectDomainCode(
      await f2Request(`/f2/payments/${created.body.id}/deposit-cash`, {
        user: admin.person,
        body: { bankMovementId: foreign.id },
      }),
      404,
      "bank_movement_not_found",
    );

    const movement = await recordKernelBankMovement(deps, {
      tenantId: TENANT_A,
      amountCents: 5_000,
    });
    const deposited = await f2Json<{ cashStatus: string; bankMovementId: string | null }>(
      `/f2/payments/${created.body.id}/deposit-cash`,
      { user: admin.person, body: { bankMovementId: movement.id } },
    );
    expect(deposited.status).toBe(200);
    expect(deposited.body.cashStatus).toBe(CASH_STATUS.deposited);
    expect(deposited.body.bankMovementId).toBe(movement.id);
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
      actor: systemAuditActor("job-reauth-no-manager"),
    });
    await sweepBankReauthNotices(deps, {
      tenantId: TENANT_A,
      actor: systemAuditActor("job-reauth-no-manager"),
    });
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
    await f2Request("/f2/bank-connections", {
      user: admin.person,
      body: {
        accountIban: iban,
        consentStatus: BANK_CONSENT_STATUS.authorized,
        consentValidUntil: "2026-09-20T00:00:00.000Z",
        authorizedByMembershipId: admin.membership.id,
      },
    });
    const sweep = await f2Json<{ noticed: Array<{ noticed: boolean }> }>(
      "/f2/jobs/reauth-notices",
      { user: admin.person, body: {} },
    );
    expect(sweep.status).toBe(200);
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

    const admin = await seedActor(TENANT_A, {
      userId: "user-admin-id-adv",
      roleCode: "Admin",
      name: "Admin Id",
      email: "admin-id-adv@test",
    });

    const miss = await f2Json<{
      results: Array<{ fracaoId: string | null; allocationStatus: string }>;
    }>("/f2/payments/candidates", {
      user: admin.person,
      body: {
        movements: [
          {
            amountCents: 50_00,
            description: "TRF CRED SEPA+ DE ANA",
            externalRef: "ana-false-1",
            source: CANDIDATE_SOURCES.identityMatrix,
          },
        ],
      },
    });
    expect(miss.status).toBe(201);
    expect(miss.body.results[0]!.fracaoId).toBeNull();
    expect(miss.body.results[0]!.allocationStatus).toBe(ALLOCATION_STATUS.naoAlocadoPendente);

    const hit = await f2Json<{
      results: Array<{ fracaoId: string | null }>;
    }>("/f2/payments/candidates", {
      user: admin.person,
      body: {
        movements: [
          {
            amountCents: 50_00,
            description: "TRF CRED SEPA+ DE MARIANA SILVA",
            externalRef: "mariana-hit-1",
            source: CANDIDATE_SOURCES.identityMatrix,
          },
        ],
      },
    });
    expect(hit.status).toBe(201);
    expect(hit.body.results[0]!.fracaoId).toBe(fracao.id);

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
    const adminB = await seedActor(TENANT_B, {
      userId: "user-admin-hash-b",
      roleCode: "Admin",
      name: "Admin Hash B",
      email: "admin-hash-b@test",
    });

    tenantIdOverride = TENANT_A;
    const payA = await f2Json<{ id: string }>("/f2/payments", {
      user: adminA.person,
      body: {
        fracaoId: seededA.fracao.id,
        amountCents: 20_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    tenantIdOverride = TENANT_B;
    const payB = await f2Json<{ id: string }>("/f2/payments", {
      user: adminB.person,
      body: {
        fracaoId: seededB.fracao.id,
        amountCents: 20_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(payA.status).toBe(201);
    expect(payB.status).toBe(201);
    tenantIdOverride = TENANT_A;
    expect(
      (await f2Request(`/f2/payments/${payA.body.id}/allocate`, { user: adminA.person, method: "POST" }))
        .status,
    ).toBe(200);
    tenantIdOverride = TENANT_B;
    expect(
      (await f2Request(`/f2/payments/${payB.body.id}/allocate`, { user: adminB.person, method: "POST" }))
        .status,
    ).toBe(200);

    tenantIdOverride = TENANT_A;
    expect((await f2Json<{ ok: boolean }>("/f2/ledger/validate", { user: adminA.person, method: "POST" })).body.ok).toBe(true);
    tenantIdOverride = TENANT_B;
    expect((await f2Json<{ ok: boolean }>("/f2/ledger/validate", { user: adminB.person, method: "POST" })).body.ok).toBe(true);

    const tip = await client.execute(
      `SELECT id FROM ledger_entries WHERE tenant_id = ? AND entry_type = 'allocation' LIMIT 1`,
      [TENANT_A],
    );
    await client.execute({
      sql: `UPDATE ledger_entries SET payload_json = ? WHERE id = ?`,
      args: ['{"tampered":true}', String(tip.rows[0]!.id)],
    });

    tenantIdOverride = TENANT_A;
    const broken = await f2Json<{ ok: boolean }>("/f2/ledger/validate", {
      user: adminA.person,
      method: "POST",
    });
    expect(broken.status).toBe(200);
    expect(broken.body.ok).toBe(false);
    tenantIdOverride = TENANT_B;
    expect((await f2Json<{ ok: boolean }>("/f2/ledger/validate", { user: adminB.person, method: "POST" })).body.ok).toBe(true);

    tenantIdOverride = TENANT_A;
    await expectDomainCode(
      await f2Request("/f2/payments", {
        user: adminA.person,
        body: {
          fracaoId: seededA.fracao.id,
          amountCents: 1_000,
          paymentMethod: PAYMENT_METHODS.bankTransfer,
        },
      }),
      409,
      "ledger_chain_broken",
    );
    tenantIdOverride = TENANT_B;
    const stillOk = await f2Request("/f2/payments", {
      user: adminB.person,
      body: {
        fracaoId: seededB.fracao.id,
        amountCents: 1_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(stillOk.status).toBe(201);
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
    await f2Request("/f2/bank-connections", {
      user: admin.person,
      body: {
        accountIban: "PT50001800034978380602065",
        consentStatus: BANK_CONSENT_STATUS.authorized,
        consentValidUntil: "2026-09-20T00:00:00.000Z",
        authorizedByMembershipId: admin.membership.id,
      },
    });
    const firstSweep = await f2Json<{ noticed: Array<{ noticed: boolean }> }>(
      "/f2/jobs/reauth-notices",
      { user: admin.person, body: {} },
    );
    expect(firstSweep.status).toBe(200);
    expect(firstSweep.body.noticed.some((n) => n.noticed)).toBe(true);
    const secondSweep = await f2Json<{ noticed: Array<{ noticed: boolean }> }>(
      "/f2/jobs/reauth-notices",
      { user: admin.person, body: {} },
    );
    expect(secondSweep.status).toBe(200);
    expect(secondSweep.body.noticed.every((n) => n.noticed === false)).toBe(true);

    const reauthJobs = await client.execute(
      `SELECT COUNT(*) AS n FROM outbox_jobs WHERE tenant_id = ? AND job_type = ?`,
      [TENANT_A, OUTBOX_JOB_TYPES.bankReauthNotice],
    );
    expect(Number(reauthJobs.rows[0]!.n)).toBe(1);

    await resetOutboxJobToPending(OUTBOX_JOB_TYPES.bankReauthNotice, TENANT_A);
    await processOutbox(deps);

    const deliveries = await client.execute(
      `SELECT destination FROM notification_deliveries
       WHERE tenant_id = ? AND template = 'bank_reauth_required'`,
      [TENANT_A],
    );
    expect(deliveries.rows.length).toBe(1);
    expect(String(deliveries.rows[0]!.destination)).toBe("admin-outbox@test");

    const payment = await f2Json<{ id: string }>("/f2/payments", {
      user: admin.person,
      body: {
        fracaoId: fracao.id,
        amountCents: 20_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(payment.status).toBe(201);
    expect(
      (await f2Request(`/f2/payments/${payment.body.id}/allocate`, { user: admin.person, method: "POST" }))
        .status,
    ).toBe(200);

    const receiptJobs = await client.execute(
      `SELECT COUNT(*) AS n FROM outbox_jobs WHERE tenant_id = ? AND job_type = ?`,
      [TENANT_A, OUTBOX_JOB_TYPES.issueReceipt],
    );
    expect(Number(receiptJobs.rows[0]!.n)).toBe(1);

    await processOutbox(deps);
    await resetOutboxJobToPending(OUTBOX_JOB_TYPES.issueReceipt, TENANT_A);
    await processOutbox(deps);
    const receiptAgain = await f2Request(`/f2/payments/${payment.body.id}/receipt`, {
      user: admin.person,
      method: "POST",
    });
    expect(receiptAgain.status).toBe(201);

    const receipts = await client.execute(
      `SELECT id FROM financial_documents
       WHERE tenant_id = ? AND doc_type = 'Receipt' AND source_payment_id = ?`,
      [TENANT_A, payment.body.id],
    );
    expect(receipts.rows.length).toBe(1);
  });
});
