/**
 * F2 — Financeiro / Ledger (vertical slice).
 * Prova: cash 3 estados; allocate só após verified; hash-chain; recibo com generated_from.
 * Adversarial: concorrência hash-chain, Fiscalizacao verify-cash, bank_deposit com movimento.
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
  issuePaymentNotice,
  issueReceiptForPayment,
  recordKernelBankMovement,
  registerPayment,
  validateLedgerChain,
  verifyCashPayment,
} from "./application/finance/f2-finance";
import {
  ingestCandidateMovement,
  ingestCandidateMovements,
  ingestCandidatesFromCsv,
  MAX_CANDIDATE_CSV_CHARS,
  MAX_CANDIDATE_MOVEMENTS,
} from "./application/finance/f2-candidates";
import {
  BANK_REAUTH_ADMIN_FALLBACK,
  sweepBankReauthNotices,
  upsertBankConnection,
} from "./application/finance/f2-bank-connection";
import {
  generateMonthlyPaymentNotices,
  runF2CalendarSweep,
  sweepReceiptsForAllocatedPayments,
} from "./application/finance/f2-jobs";
import {
  extractFracaoCodeFromDescription,
  extractPayerFromDescription,
  identityNameMatches,
  MIN_BARE_FRACAO_CODE_LENGTH,
} from "./application/finance/f2-identity";
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
import { DomainError } from "./domain/errors";
import { applyDomainKernelSchema } from "./infra/kernel-schema";
import { applyF1ConstitutionSchema } from "./infra/f1-schema";
import { applyF2FinanceSchema } from "./infra/f2-schema";
import type { KernelDeps } from "./infra/kernel-deps";
import { createMembershipRepo } from "./infra/repos/membership-repo";
import { createPersonRepo } from "./infra/repos/person-repo";
import type { KernelAuthUser, KernelVariables } from "./middleware/membership";
import { createF2Routes } from "./routes/f2";

const DB_PATH = path.join(import.meta.dir, "..", "..", ".tmp-test-f2.db");
const DB_URL = `file:${DB_PATH}`;

let client: ReturnType<typeof createClient>;
let deps: KernelDeps;
const TENANT = "tenant-f2";
let currentUser: KernelAuthUser | null = null;
let app: Hono;

async function seedFracaoWithObligations() {
  const doc = await registerIngestDocument(deps, {
    tenantId: TENANT,
    kind: INGEST_DOCUMENT_KINDS.regulamento,
    filename: "regulamento.pdf",
  });
  const { lines } = await extractDocumentLines(deps, {
    tenantId: TENANT,
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
    tenantId: TENANT,
    documentId: doc.id,
    confirmations: lines.map((l) => ({ lineId: l.id })),
  });
  const fracoes = await listConstitutionFracoes(deps, { tenantId: TENANT });
  const budget = await createAnnualBudget(deps, {
    tenantId: TENANT,
    year: 2026,
    title: "Orçamento 2026",
    lines: [
      { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Quota", amountCents: 10_000_00 },
      { kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 1_000_00 },
    ],
  });
  const approved = await approveBudgetAndCreateObligations(deps, {
    tenantId: TENANT,
    budgetId: budget.budget.id,
  });
  return { fracao: fracoes[0]!, obligations: approved.obligations };
}

async function seedActor(opts: {
  userId: string;
  roleCode: string;
  name: string;
  email: string;
}) {
  const personRepo = createPersonRepo(deps.db);
  const membershipRepo = createMembershipRepo(deps.db);
  const person = await personRepo.insert({
    id: crypto.randomUUID(),
    userId: opts.userId,
    name: opts.name,
    email: opts.email,
    createdAt: new Date(),
  });
  await membershipRepo.insert({
    id: crypto.randomUUID(),
    personId: person.id,
    tenantId: TENANT,
    roleCode: opts.roleCode,
    createdAt: new Date(),
  });
  return person;
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
  deps = { db, getTenantId: () => TENANT };
  app = buildApp();
});

beforeEach(async () => {
  currentUser = null;
  deps.now = undefined;
  for (const table of [
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
  ]) {
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

describe("F2 financeiro / ledger", () => {
  test("cash exige evidência e não aloca em registered", async () => {
    const { fracao } = await seedFracaoWithObligations();

    await expect(
      registerPayment(deps, {
        tenantId: TENANT,
        fracaoId: fracao.id,
        amountCents: 5_000,
        paymentMethod: PAYMENT_METHODS.cash,
      }),
    ).rejects.toMatchObject({ code: "cash_evidence_required" });

    const payment = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 5_000,
      paymentMethod: PAYMENT_METHODS.cash,
      evidenceUploadId: "upload-cash-1",
      actor: { personId: "admin-1" },
    });
    expect(payment.cashStatus).toBe(CASH_STATUS.registered);

    await expect(
      allocatePayment(deps, { tenantId: TENANT, paymentId: payment.id }),
    ).rejects.toMatchObject({ code: "cash_not_verified" });
  });

  test("second_person: registante ≠ verificador; allocate + hash-chain + recibo", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-happy",
      roleCode: "Admin",
      name: "Admin",
      email: "admin-happy@test",
    });
    const fiscal = await seedActor({
      userId: "user-fiscal-happy",
      roleCode: "Fiscalizacao",
      name: "Fiscal",
      email: "fiscal-happy@test",
    });

    const payment = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 50_000,
      paymentMethod: PAYMENT_METHODS.cash,
      evidenceUploadId: "upload-cash-2",
      actor: { personId: admin.id },
    });

    await expect(
      verifyCashPayment(deps, {
        tenantId: TENANT,
        paymentId: payment.id,
        verificationMethod: VERIFICATION_METHOD.secondPerson,
        actor: { personId: admin.id },
      }),
    ).rejects.toMatchObject({ code: "self_verify_forbidden" });

    const verified = await verifyCashPayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
      verificationMethod: VERIFICATION_METHOD.secondPerson,
      actor: { personId: fiscal.id },
    });
    expect(verified.cashStatus).toBe(CASH_STATUS.verified);

    const movement = await recordKernelBankMovement(deps, {
      tenantId: TENANT,
      amountCents: 50_000,
      description: "depósito cash",
    });
    const deposited = await depositCashPayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
      bankMovementId: movement.id,
      actor: { personId: admin.id },
    });
    expect(deposited.cashStatus).toBe(CASH_STATUS.deposited);
    expect(deposited.bankMovementId).toBe(movement.id);

    const result = await allocatePayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
      actor: { personId: admin.id },
    });
    expect(result.idempotent).toBe(false);
    expect(result.allocations.length).toBeGreaterThan(0);
    expect(result.payment.allocationStatus).toBe(ALLOCATION_STATUS.totalmenteAlocado);

    const chain = await validateLedgerChain(deps, { tenantId: TENANT });
    expect(chain.ok).toBe(true);
    expect(chain.entries).toBeGreaterThanOrEqual(2); // genesis + ≥1 allocation

    const receipt = await issueReceiptForPayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
    });
    expect(receipt.docType).toBe("Receipt");
    const generatedFrom = JSON.parse(receipt.generatedFromJson) as {
      paymentId: string;
      allocationIds: string[];
    };
    expect(generatedFrom.paymentId).toBe(payment.id);
    expect(generatedFrom.allocationIds.length).toBe(result.allocations.length);

    const again = await allocatePayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
    });
    expect(again.idempotent).toBe(true);

    const receiptAgain = await issueReceiptForPayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
    });
    expect(receiptAgain.id).toBe(receipt.id);
  });

  test("transferência aloca directamente e cadeia detecta adulteração", async () => {
    const { fracao } = await seedFracaoWithObligations();

    const payment = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 20_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
      actor: { personId: "admin-1" },
    });
    expect(payment.cashStatus).toBeNull();

    const result = await allocatePayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
    });
    expect(result.allocations.length).toBeGreaterThan(0);

    const ok = await validateLedgerChain(deps, { tenantId: TENANT });
    expect(ok.ok).toBe(true);

    const tip = await client.execute(
      `SELECT id, payload_json FROM ledger_entries WHERE tenant_id = ? AND entry_type = 'allocation' LIMIT 1`,
      [TENANT],
    );
    const row = tip.rows[0]!;
    await client.execute({
      sql: `UPDATE ledger_entries SET payload_json = ? WHERE id = ?`,
      args: ['{"tampered":true}', String(row.id)],
    });

    const broken = await validateLedgerChain(deps, { tenantId: TENANT });
    expect(broken.ok).toBe(false);

    await expect(
      registerPayment(deps, {
        tenantId: TENANT,
        fracaoId: fracao.id,
        amountCents: 1_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      }),
    ).rejects.toMatchObject({ code: "ledger_chain_broken" });
  });

  test("recibo vazio é rejeitado", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const payment = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 1_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
    });
    await expect(
      issueReceiptForPayment(deps, { tenantId: TENANT, paymentId: payment.id }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});

describe("F2 ADR-028 cash / Fiscalizacao / bank_deposit", () => {
  test("sem Fiscalizacao no tenant só bank_deposit é permitido", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-nofiscal",
      roleCode: "Admin",
      name: "Admin Solo",
      email: "admin-nofiscal@test",
    });
    const payment = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 8_000,
      paymentMethod: PAYMENT_METHODS.cash,
      evidenceUploadId: "ev-nofiscal",
      actor: { personId: admin.id },
    });

    await expect(
      verifyCashPayment(deps, {
        tenantId: TENANT,
        paymentId: payment.id,
        verificationMethod: VERIFICATION_METHOD.secondPerson,
        actor: { personId: "someone-else" },
      }),
    ).rejects.toMatchObject({ code: "fiscalizacao_required" });

    await expect(
      verifyCashPayment(deps, {
        tenantId: TENANT,
        paymentId: payment.id,
        verificationMethod: VERIFICATION_METHOD.bankDeposit,
        actor: { personId: admin.id },
      }),
    ).rejects.toMatchObject({ code: "bank_movement_required" });

    const foreign = await recordKernelBankMovement(deps, {
      tenantId: "other-tenant",
      amountCents: 8_000,
    });
    await expect(
      verifyCashPayment(deps, {
        tenantId: TENANT,
        paymentId: payment.id,
        verificationMethod: VERIFICATION_METHOD.bankDeposit,
        bankMovementId: foreign.id,
        actor: { personId: admin.id },
      }),
    ).rejects.toMatchObject({ code: "bank_movement_not_found" });

    const tiny = await recordKernelBankMovement(deps, {
      tenantId: TENANT,
      amountCents: 100,
    });
    await expect(
      verifyCashPayment(deps, {
        tenantId: TENANT,
        paymentId: payment.id,
        verificationMethod: VERIFICATION_METHOD.bankDeposit,
        bankMovementId: tiny.id,
        actor: { personId: admin.id },
      }),
    ).rejects.toMatchObject({ code: "bank_movement_amount_mismatch" });

    const movement = await recordKernelBankMovement(deps, {
      tenantId: TENANT,
      amountCents: 8_000,
    });
    const verified = await verifyCashPayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
      verificationMethod: VERIFICATION_METHOD.bankDeposit,
      bankMovementId: movement.id,
      actor: { personId: admin.id },
    });
    expect(verified.cashStatus).toBe(CASH_STATUS.verified);
    expect(verified.verificationMethod).toBe(VERIFICATION_METHOD.bankDeposit);
    expect(verified.bankMovementId).toBe(movement.id);

    const deposited = await depositCashPayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
      actor: { personId: admin.id },
    });
    expect(deposited.cashStatus).toBe(CASH_STATUS.deposited);
  });

  test("deposit sem movimento é rejeitado", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-nodep",
      roleCode: "Admin",
      name: "Admin",
      email: "admin-nodep@test",
    });
    const fiscal = await seedActor({
      userId: "user-fiscal-nodep",
      roleCode: "Fiscalizacao",
      name: "Fiscal",
      email: "fiscal-nodep@test",
    });
    const payment = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 3_000,
      paymentMethod: PAYMENT_METHODS.cash,
      evidenceUploadId: "ev-nodep",
      actor: { personId: admin.id },
    });
    await verifyCashPayment(deps, {
      tenantId: TENANT,
      paymentId: payment.id,
      verificationMethod: VERIFICATION_METHOD.secondPerson,
      actor: { personId: fiscal.id },
    });
    await expect(
      depositCashPayment(deps, {
        tenantId: TENANT,
        paymentId: payment.id,
        actor: { personId: admin.id },
      }),
    ).rejects.toMatchObject({ code: "bank_movement_required" });
  });
});

describe("F2 ADR-029 hash-chain concurrency", () => {
  test("duas alocações concorrentes: sequences únicas, cadeia íntegra, sem open_amount negativo", async () => {
    const { fracao, obligations: obs } = await seedFracaoWithObligations();
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
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 10_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
    });
    const p2 = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 10_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
    });

    const clientA = createClient({ url: DB_URL });
    const clientB = createClient({ url: DB_URL });
    try {
      await clientA.execute("PRAGMA busy_timeout=250");
      await clientB.execute("PRAGMA busy_timeout=250");
      const depsA: KernelDeps = { db: drizzle(clientA, { schema }), getTenantId: () => TENANT };
      const depsB: KernelDeps = { db: drizzle(clientB, { schema }), getTenantId: () => TENANT };

      const settled = await Promise.allSettled([
        allocatePayment(depsA, { tenantId: TENANT, paymentId: p1.id }),
        allocatePayment(depsB, { tenantId: TENANT, paymentId: p2.id }),
      ]);

      const fulfilled = settled.filter((s) => s.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    } finally {
      clientA.close();
      clientB.close();
    }

    const seq = await client.execute(
      `SELECT sequence FROM ledger_entries WHERE tenant_id = ? ORDER BY sequence`,
      [TENANT],
    );
    const sequences = seq.rows.map((r) => Number(r.sequence));
    expect(new Set(sequences).size).toBe(sequences.length);

    const chain = await validateLedgerChain(deps, { tenantId: TENANT });
    expect(chain.ok).toBe(true);

    const open = await client.execute(
      `SELECT open_amount_cents FROM obligations WHERE id = ?`,
      [keep.id],
    );
    const openCents = Number(open.rows[0]!.open_amount_cents);
    expect(openCents).toBeGreaterThanOrEqual(0);
    expect(openCents).toBe(0);

    const allocSum = await client.execute(
      `SELECT COALESCE(SUM(amount_cents), 0) AS t FROM allocations WHERE obligation_id = ?`,
      [keep.id],
    );
    expect(Number(allocSum.rows[0]!.t)).toBe(10_000);
  }, 20_000);

  test("mesmo payment alocado duas vezes em paralelo não duplica", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const payment = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 15_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
    });

    const clientA = createClient({ url: DB_URL });
    const clientB = createClient({ url: DB_URL });
    try {
      await clientA.execute("PRAGMA busy_timeout=250");
      await clientB.execute("PRAGMA busy_timeout=250");
      const depsA: KernelDeps = { db: drizzle(clientA, { schema }), getTenantId: () => TENANT };
      const depsB: KernelDeps = { db: drizzle(clientB, { schema }), getTenantId: () => TENANT };

      const settled = await Promise.allSettled([
        allocatePayment(depsA, { tenantId: TENANT, paymentId: payment.id }),
        allocatePayment(depsB, { tenantId: TENANT, paymentId: payment.id }),
      ]);
      expect(settled.filter((s) => s.status === "fulfilled").length).toBe(2);
    } finally {
      clientA.close();
      clientB.close();
    }

    const allocs = await client.execute(
      `SELECT COALESCE(SUM(amount_cents), 0) AS t FROM allocations WHERE payment_id = ?`,
      [payment.id],
    );
    expect(Number(allocs.rows[0]!.t)).toBe(15_000);

    const chain = await validateLedgerChain(deps, { tenantId: TENANT });
    expect(chain.ok).toBe(true);
  }, 20_000);
});

describe("F2 HTTP Fiscalizacao vs gestor", () => {
  test("Fiscalizacao verifica cash; não aloca; admin não se auto-confirma", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-http",
      roleCode: "Admin",
      name: "Admin HTTP",
      email: "admin-http@test",
    });
    const fiscal = await seedActor({
      userId: "user-fiscal-http",
      roleCode: "Fiscalizacao",
      name: "Fiscal HTTP",
      email: "fiscal-http@test",
    });

    currentUser = { id: admin.userId!, email: "admin-http@test" };
    const created = await app.request("/f2/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fracaoId: fracao.id,
        amountCents: 4_000,
        paymentMethod: PAYMENT_METHODS.cash,
        evidenceUploadId: "ev-http",
      }),
    });
    expect(created.status).toBe(201);
    const payment = (await created.json()) as { id: string };

    currentUser = { id: admin.userId! };
    const selfVerify = await app.request(`/f2/payments/${payment.id}/verify-cash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verificationMethod: VERIFICATION_METHOD.secondPerson }),
    });
    expect(selfVerify.status).toBe(403);

    currentUser = { id: fiscal.userId! };
    const fiscalVerify = await app.request(`/f2/payments/${payment.id}/verify-cash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verificationMethod: VERIFICATION_METHOD.secondPerson }),
    });
    expect(fiscalVerify.status).toBe(200);
    const verified = (await fiscalVerify.json()) as { cashStatus: string };
    expect(verified.cashStatus).toBe(CASH_STATUS.verified);

    const fiscalAlloc = await app.request(`/f2/payments/${payment.id}/allocate`, {
      method: "POST",
    });
    expect(fiscalAlloc.status).toBe(403);

    const fiscalRegister = await app.request("/f2/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fracaoId: fracao.id,
        amountCents: 1_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      }),
    });
    expect(fiscalRegister.status).toBe(403);
  });

  test("Owner não acede a verify-cash", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-owner",
      roleCode: "Admin",
      name: "Admin",
      email: "admin-owner@test",
    });
    await seedActor({
      userId: "user-fiscal-owner",
      roleCode: "Fiscalizacao",
      name: "Fiscal",
      email: "fiscal-owner@test",
    });
    const owner = await seedActor({
      userId: "user-owner",
      roleCode: "Owner",
      name: "Owner",
      email: "owner@test",
    });

    currentUser = { id: admin.userId! };
    const created = await app.request("/f2/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fracaoId: fracao.id,
        amountCents: 2_000,
        paymentMethod: PAYMENT_METHODS.cash,
        evidenceUploadId: "ev-owner",
      }),
    });
    const payment = (await created.json()) as { id: string };

    currentUser = { id: owner.userId! };
    const res = await app.request(`/f2/payments/${payment.id}/verify-cash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verificationMethod: VERIFICATION_METHOD.secondPerson }),
    });
    expect(res.status).toBe(403);
  });
});

describe("F2 PaymentNotice e Recibo", () => {
  test("aviso valida tenant, fração e montante das obligations", async () => {
    const { fracao, obligations: obs } = await seedFracaoWithObligations();
    const sum = obs.reduce((s, o) => s + o.amountCents, 0);

    const ok = await issuePaymentNotice(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: sum,
      periodLabel: "2026-01",
      obligationIds: obs.map((o) => o.id),
    });
    expect(ok.docType).toBe("PaymentNotice");

    await expect(
      issuePaymentNotice(deps, {
        tenantId: TENANT,
        fracaoId: fracao.id,
        amountCents: 1,
        periodLabel: "2026-01",
        obligationIds: obs.map((o) => o.id),
      }),
    ).rejects.toMatchObject({ code: "notice_amount_mismatch" });

    await expect(
      issuePaymentNotice(deps, {
        tenantId: TENANT,
        fracaoId: fracao.id,
        amountCents: sum,
        periodLabel: "2026-01",
        obligationIds: [crypto.randomUUID()],
      }),
    ).rejects.toMatchObject({ code: "obligation_not_found" });

    const now = Math.floor(Date.now() / 1000);
    const otherFracaoId = crypto.randomUUID();
    await client.execute({
      sql: `INSERT INTO constitution_fracoes (id, tenant_id, codigo, tipo, permilagem, status, created_at, confirmed_at)
            VALUES (?, ?, 'B', 'fracao', 0, 'confirmed', ?, ?)`,
      args: [otherFracaoId, TENANT, now, now],
    });
    await expect(
      issuePaymentNotice(deps, {
        tenantId: TENANT,
        fracaoId: otherFracaoId,
        amountCents: sum,
        periodLabel: "2026-01",
        obligationIds: obs.map((o) => o.id),
      }),
    ).rejects.toMatchObject({ code: "obligation_fracao_mismatch" });
  });
});

async function seedConfirmedOwner(fracaoCodigo: string, personName: string) {
  await deps.db.insert(ownerContactDrafts).values({
    id: crypto.randomUUID(),
    tenantId: TENANT,
    fracaoCodigo,
    personName,
    status: "confirmed",
    sourceExcerpt: `${personName} — ${fracaoCodigo}`,
    createdAt: new Date(),
  });
}

describe("F2 BankConnection aviso proactivo de reautorização", () => {
  test("consentimento a expirar em 14 dias gera aviso idempotente; destino é email do admin, não IBAN", async () => {
    const admin = await seedActor({
      userId: "user-admin-reauth",
      roleCode: "Admin",
      name: "Admin Reauth",
      email: "admin-reauth@test",
    });
    const iban = "PT50001800034978380602065";
    const far = await upsertBankConnection(deps, {
      tenantId: TENANT,
      accountIban: iban,
      consentStatus: BANK_CONSENT_STATUS.authorized,
      consentValidUntil: "2027-01-01T00:00:00.000Z",
      authorizedByMembershipId: (
        await client.execute(`SELECT id FROM memberships WHERE person_id = ?`, [admin.id])
      ).rows[0]!.id as string,
    });
    expect(far.reauthorizationRequired).toBe(0);
    expect(far.authorizedByMembershipId).toBeTruthy();

    const skipped = await sweepBankReauthNotices(deps, { tenantId: TENANT });
    expect(skipped.noticed.filter((n) => n.noticed).length).toBe(0);

    deps.now = () => new Date("2026-09-10T12:00:00.000Z");
    const due = await upsertBankConnection(deps, {
      tenantId: TENANT,
      accountIban: iban,
      consentStatus: BANK_CONSENT_STATUS.authorized,
      consentValidUntil: "2026-09-20T00:00:00.000Z",
    });
    expect(due.reauthorizationRequired).toBe(1);
    expect(due.consentStatus).toBe(BANK_CONSENT_STATUS.reauthorizationRequired);

    const first = await sweepBankReauthNotices(deps, { tenantId: TENANT });
    expect(first.noticed.some((n) => n.noticed)).toBe(true);

    const drain = await processOutbox(deps);
    expect(drain.completed).toBeGreaterThanOrEqual(1);

    const deliveries = await client.execute(
      `SELECT template, status, destination FROM notification_deliveries WHERE tenant_id = ?`,
      [TENANT],
    );
    expect(deliveries.rows.some((r) => r.template === "bank_reauth_required")).toBe(true);
    const dest = String(deliveries.rows.find((r) => r.template === "bank_reauth_required")!.destination);
    expect(dest).toBe("admin-reauth@test");
    expect(dest).not.toBe(iban);
    expect(dest.startsWith("PT")).toBe(false);
    expect(deliveries.rows.find((r) => r.template === "bank_reauth_required")!.status).toBe(
      "attempted",
    );

    const second = await sweepBankReauthNotices(deps, { tenantId: TENANT });
    expect(second.noticed.every((n) => n.noticed === false)).toBe(true);

    const audits = await client.execute(
      `SELECT type FROM audit_events WHERE tenant_id = ? AND type = 'bank_connection.reauthorization_notice'`,
      [TENANT],
    );
    expect(audits.rows.length).toBe(1);
  });

  test("sem gestor no tenant o aviso não usa IBAN como destino de email", async () => {
    const iban = "PT50001800034978380602065";
    deps.now = () => new Date("2026-09-10T12:00:00.000Z");
    await upsertBankConnection(deps, {
      tenantId: TENANT,
      accountIban: iban,
      consentStatus: BANK_CONSENT_STATUS.authorized,
      consentValidUntil: "2026-09-20T00:00:00.000Z",
    });
    await sweepBankReauthNotices(deps, { tenantId: TENANT });
    await processOutbox(deps);
    const deliveries = await client.execute(
      `SELECT destination, status FROM notification_deliveries WHERE tenant_id = ? AND template = 'bank_reauth_required'`,
      [TENANT],
    );
    expect(deliveries.rows.length).toBe(1);
    expect(String(deliveries.rows[0]!.destination)).toBe(BANK_REAUTH_ADMIN_FALLBACK);
    expect(String(deliveries.rows[0]!.destination)).toContain("@");
    expect(String(deliveries.rows[0]!.destination)).not.toBe(iban);
    expect(String(deliveries.rows[0]!.destination).startsWith("PT")).toBe(false);
    expect(String(deliveries.rows[0]!.status)).toBe("skipped");
  });

  test("authorizedByMembershipId tem de existir neste tenant", async () => {
    await expect(
      upsertBankConnection(deps, {
        tenantId: TENANT,
        accountIban: "PT50001800034978380602065",
        authorizedByMembershipId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "membership_not_found" });

    const otherId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await client.execute({
      sql: `INSERT INTO persons (id, name, email, created_at, updated_at) VALUES (?, 'X', 'other-tenant@test', ?, ?)`,
      args: ["person-other-tenant", now, now],
    });
    await client.execute({
      sql: `INSERT INTO memberships (id, person_id, tenant_id, role_code, status, created_at) VALUES (?, ?, 'other-tenant', 'Admin', 'active', ?)`,
      args: [otherId, "person-other-tenant", now],
    });
    await expect(
      upsertBankConnection(deps, {
        tenantId: TENANT,
        authorizedByMembershipId: otherId,
      }),
    ).rejects.toMatchObject({ code: "membership_not_found" });

    const owner = await seedActor({
      userId: "user-owner-authz",
      roleCode: "Owner",
      name: "Owner Authz",
      email: "owner-authz@test",
    });
    const ownerMem = await client.execute(`SELECT id FROM memberships WHERE person_id = ?`, [
      owner.id,
    ]);
    await expect(
      upsertBankConnection(deps, {
        tenantId: TENANT,
        authorizedByMembershipId: String(ownerMem.rows[0]!.id),
      }),
    ).rejects.toMatchObject({ code: "authorizer_role_forbidden", httpStatus: 403 });
  });
});

describe("F2 Payments candidatos (CSV / identity-matrix / reconciliação)", () => {
  test("CSV + nome confirmado cria Payment identificado sem Allocation e sem Quota.pago", async () => {
    const { fracao } = await seedFracaoWithObligations();
    await seedConfirmedOwner("A", "Maria Silva");
    await client.execute({
      sql: `INSERT INTO quotas (id, fracao_id, tipo, mes, ano, valor, pago) VALUES (?, ?, 'condominio', 9, 2026, 50, 0)`,
      args: ["quota-fonte-1", fracao.id],
    });

    const csv = [
      "Conta condomínio",
      "Seq;Data Operação;Data Valor;Mês;Ano;Tipo;Descritivo;Montante;Saldo",
      "csv-1;01-09-2026;01-09-2026;9;2026;Entrada;TRF CRED SEPA+ DE MARIA SILVA;50,00;1000,00",
    ].join("\n");

    const ingested = await ingestCandidatesFromCsv(deps, { tenantId: TENANT, csvText: csv });
    expect(ingested.created).toBe(1);
    const row = ingested.results[0]!;
    expect(row.fracaoId).toBe(fracao.id);
    expect(row.allocationStatus).toBe(ALLOCATION_STATUS.identificado);
    expect(row.created).toBe(true);

    const again = await ingestCandidatesFromCsv(deps, { tenantId: TENANT, csvText: csv });
    expect(again.created).toBe(0);
    expect(again.results[0]!.paymentId).toBe(row.paymentId);

    const allocs = await client.execute(`SELECT COUNT(*) AS n FROM allocations`);
    expect(Number(allocs.rows[0]!.n)).toBe(0);

    const pago = await client.execute(`SELECT pago FROM quotas WHERE id = 'quota-fonte-1'`);
    expect(Number(pago.rows[0]!.pago)).toBe(0);

    const unmatched = await ingestCandidateMovements(deps, {
      tenantId: TENANT,
      movements: [
        {
          amountCents: 12_00,
          description: "TRF CRED SEPA+ DE DESCONHECIDO XPTO",
          externalRef: "unk-1",
          source: CANDIDATE_SOURCES.identityMatrix,
        },
      ],
    });
    expect(unmatched.results[0]!.fracaoId).toBeNull();
    expect(unmatched.results[0]!.allocationStatus).toBe(ALLOCATION_STATUS.naoAlocadoPendente);

    const pagoAfter = await client.execute(`SELECT pago FROM quotas WHERE id = 'quota-fonte-1'`);
    expect(Number(pagoAfter.rows[0]!.pago)).toBe(0);
  });

  test("ANA não identifica MARIANA por substring no descritivo", async () => {
    const { fracao } = await seedFracaoWithObligations();
    await seedConfirmedOwner("A", "Mariana Silva");
    const miss = await ingestCandidateMovements(deps, {
      tenantId: TENANT,
      movements: [
        {
          amountCents: 50_00,
          description: "TRF CRED SEPA+ DE ANA",
          externalRef: "ana-sub-1",
          source: CANDIDATE_SOURCES.identityMatrix,
        },
      ],
    });
    expect(miss.results[0]!.fracaoId).toBeNull();
    expect(miss.results[0]!.allocationStatus).toBe(ALLOCATION_STATUS.naoAlocadoPendente);

    const hit = await ingestCandidateMovements(deps, {
      tenantId: TENANT,
      movements: [
        {
          amountCents: 50_00,
          description: "TRF CRED SEPA+ DE MARIANA SILVA",
          externalRef: "mariana-1",
          source: CANDIDATE_SOURCES.identityMatrix,
        },
      ],
    });
    expect(hit.results[0]!.fracaoId).toBe(fracao.id);
    expect(hit.results[0]!.allocationStatus).toBe(ALLOCATION_STATUS.identificado);
  });

  test("HTTP candidatos por identity-matrix / reconciliação não aloca", async () => {
    const { fracao } = await seedFracaoWithObligations();
    await seedConfirmedOwner("A", "Joao Costa");
    const admin = await seedActor({
      userId: "user-admin-cand",
      roleCode: "Admin",
      name: "Admin Cand",
      email: "admin-cand@test",
    });
    currentUser = { id: admin.userId!, email: "admin-cand@test" };

    const res = await app.request("/f2/payments/candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        movements: [
          {
            amountCents: 4300,
            description: "TRF CRED SEPA+ DE JOAO COSTA FRAÇÃO A",
            externalRef: "rec-1",
            source: CANDIDATE_SOURCES.reconciliation,
          },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      created: number;
      results: Array<{ fracaoId: string | null; allocationStatus: string }>;
    };
    expect(body.created).toBe(1);
    expect(body.results[0]!.fracaoId).toBe(fracao.id);
    expect(body.results[0]!.allocationStatus).toBe(ALLOCATION_STATUS.identificado);

    const allocs = await client.execute(`SELECT COUNT(*) AS n FROM allocations`);
    expect(Number(allocs.rows[0]!.n)).toBe(0);
  });

  test("índice único (tenant_id, external_ref) e ingest concorrente são idempotentes", async () => {
    await seedFracaoWithObligations();
    const idx = await client.execute(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'payments_tenant_external_ref_uq'`,
    );
    expect(idx.rows.length).toBe(1);
    expect(String(idx.rows[0]!.sql)).toContain("external_ref");

    const movement = {
      amountCents: 12_00,
      description: "TRF CRED SEPA+ DE DESCONHECIDO RACE",
      externalRef: "dup-race-1",
      source: CANDIDATE_SOURCES.reconciliation,
    };
    const [a, b] = await Promise.all([
      ingestCandidateMovement(deps, { tenantId: TENANT, movement }),
      ingestCandidateMovement(deps, { tenantId: TENANT, movement }),
    ]);
    expect(a.paymentId).toBe(b.paymentId);
    expect(a.created || b.created).toBe(true);
    expect(a.created && b.created).toBe(false);

    const paymentsCount = await client.execute(
      `SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ? AND external_ref = ?`,
      [TENANT, "dup-race-1"],
    );
    expect(Number(paymentsCount.rows[0]!.n)).toBe(1);

    const movementsCount = await client.execute(
      `SELECT COUNT(*) AS n FROM f2_bank_movements WHERE tenant_id = ? AND external_ref = ?`,
      [TENANT, "dup-race-1"],
    );
    expect(Number(movementsCount.rows[0]!.n)).toBe(1);

    const third = await ingestCandidateMovement(deps, { tenantId: TENANT, movement });
    expect(third.created).toBe(false);
    expect(third.paymentId).toBe(a.paymentId);

    const now = Math.floor(Date.now() / 1000);
    await expect(
      client.execute({
        sql: `INSERT INTO payments (id, tenant_id, amount_cents, received_at, payment_method, allocation_status, external_ref, created_at, updated_at)
              VALUES (?, ?, 100, ?, 'bank_transfer', 'nao_alocado_pendente', ?, ?, ?)`,
        args: [crypto.randomUUID(), TENANT, now, "dup-race-1", now, now],
      }),
    ).rejects.toThrow(/UNIQUE/i);
  });

  test("POST /payments/candidates rejeita csvText e movements[] acima do limite", async () => {
    const admin = await seedActor({
      userId: "user-admin-cap",
      roleCode: "Admin",
      name: "Admin Cap",
      email: "admin-cap@test",
    });
    currentUser = { id: admin.userId!, email: "admin-cap@test" };

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
    const tooManyBody = (await tooMany.json()) as { message: string };
    expect(tooManyBody.message).toContain("movements[]");

    const tooBigCsv = await app.request("/f2/payments/candidates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csvText: "x".repeat(MAX_CANDIDATE_CSV_CHARS + 1) }),
    });
    expect(tooBigCsv.status).toBe(400);
    const csvBody = (await tooBigCsv.json()) as { message: string };
    expect(csvBody.message).toContain("csvText");
  });
});

describe("F2 identity — limiar de código de fração", () => {
  test(`código curto (< ${MIN_BARE_FRACAO_CODE_LENGTH}) só casa com prefixo FRACAO; códigos longos casam por palavra`, () => {
    expect(MIN_BARE_FRACAO_CODE_LENGTH).toBe(3);
    expect(extractFracaoCodeFromDescription("TRF CRED SEPA+ DE MARIA SILVA", ["A", "DE"])).toBeNull();
    expect(extractFracaoCodeFromDescription("pagamento DE quota", ["DE"])).toBeNull();
    expect(extractFracaoCodeFromDescription("FRACAO A", ["A"])).toBe("A");
    expect(extractFracaoCodeFromDescription("pagamento fracção DE extra", ["DE"])).toBe("DE");
    expect(extractFracaoCodeFromDescription("referencia 12B no descritivo", ["12B"])).toBe("12B");
    expect(extractFracaoCodeFromDescription("FRACAO 12B", ["12B"])).toBe("12B");
  });

  test("nome ANA não casa com MARIANA/JOANA (substring); igualdade/tokens sim", () => {
    expect(identityNameMatches("ANA", "MARIANA")).toBe(false);
    expect(identityNameMatches("ANA", "Mariana Silva")).toBe(false);
    expect(identityNameMatches("MARIANA", "ANA")).toBe(false);
    expect(identityNameMatches("ANA", "JOANA")).toBe(false);
    expect(identityNameMatches("JOANA", "ANA")).toBe(false);
    expect(identityNameMatches("ANA", "JOANA SILVA")).toBe(false);
    expect(identityNameMatches("Mariana Silva", "MARIANA SILVA")).toBe(true);
    expect(identityNameMatches("MARIA SILVA", "Maria Silva Santos")).toBe(true);
    expect(identityNameMatches("JOAO COSTA", "Joao")).toBe(false);
    expect(extractPayerFromDescription("TRF CRED SEPA+ DE JOAO COSTA FRAÇÃO A")).toBe("JOAO COSTA");
    expect(extractPayerFromDescription("TRF CRED SEPA+ DE MARIA SILVA")).toBe("MARIA SILVA");
  });
});

describe("F2 jobs avisos dia 1 e recibos na Allocation", () => {
  test("avisos só no dia 1; retry é idempotente", async () => {
    await seedFracaoWithObligations();
    deps.now = () => new Date("2026-09-02T10:00:00.000Z");
    const skipped = await generateMonthlyPaymentNotices(deps, { tenantId: TENANT });
    expect(skipped.skipped).toBe(true);
    expect(skipped.reason).toBe("not_day_1");

    deps.now = () => new Date("2026-09-01T10:00:00.000Z");
    const first = await generateMonthlyPaymentNotices(deps, { tenantId: TENANT });
    expect(first.skipped).toBe(false);
    expect(first.issued.length).toBe(1);

    const second = await generateMonthlyPaymentNotices(deps, { tenantId: TENANT });
    expect(second.issued.length).toBe(0);
    expect(second.reused.length).toBe(1);
    expect(second.reused[0]).toBe(first.issued[0]);
  });

  test("aviso de débito usa openAmountCents restante, não amountCents original", async () => {
    const { fracao, obligations: obs } = await seedFracaoWithObligations();
    const originalCents = obs.reduce((s, o) => s + o.amountCents, 0);
    expect(originalCents).toBeGreaterThan(20_000);

    const payment = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 20_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
    });
    await allocatePayment(deps, { tenantId: TENANT, paymentId: payment.id });

    const open = await client.execute(
      `SELECT SUM(open_amount_cents) AS n FROM obligations WHERE tenant_id = ? AND status = 'open' AND open_amount_cents > 0`,
      [TENANT],
    );
    const remaining = Number(open.rows[0]!.n);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBe(originalCents - 20_000);

    deps.now = () => new Date("2026-09-01T10:00:00.000Z");
    const notices = await generateMonthlyPaymentNotices(deps, { tenantId: TENANT });
    expect(notices.skipped).toBe(false);
    expect(notices.issued.length).toBe(1);

    const docs = await client.execute(
      `SELECT amount_cents FROM financial_documents WHERE id = ?`,
      [notices.issued[0]!],
    );
    expect(Number(docs.rows[0]!.amount_cents)).toBe(remaining);
    expect(Number(docs.rows[0]!.amount_cents)).not.toBe(originalCents);
  });

  test("Allocation enfileira recibo; sweep e processOutbox emitem com generated_from", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const payment = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 20_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
    });
    const allocated = await allocatePayment(deps, { tenantId: TENANT, paymentId: payment.id });
    expect(allocated.allocations.length).toBeGreaterThan(0);

    const pending = await client.execute(
      `SELECT job_type, status FROM outbox_jobs WHERE tenant_id = ? AND job_type = 'f2.issue_receipt'`,
      [TENANT],
    );
    expect(pending.rows.length).toBe(1);
    expect(pending.rows[0]!.status).toBe("pending");

    const drain = await processOutbox(deps);
    expect(drain.completed).toBeGreaterThanOrEqual(1);

    const docs = await client.execute(
      `SELECT doc_type, generated_from_json, source_payment_id FROM financial_documents WHERE tenant_id = ? AND doc_type = 'Receipt'`,
      [TENANT],
    );
    expect(docs.rows.length).toBe(1);
    expect(String(docs.rows[0]!.source_payment_id)).toBe(payment.id);
    const generated = JSON.parse(String(docs.rows[0]!.generated_from_json)) as {
      paymentId: string;
      allocationIds: string[];
    };
    expect(generated.paymentId).toBe(payment.id);
    expect(generated.allocationIds.length).toBe(allocated.allocations.length);

    const sweep = await sweepReceiptsForAllocatedPayments(deps, { tenantId: TENANT });
    expect(sweep.reused.length).toBe(1);
    expect(sweep.issued.length).toBe(0);
  });

  test("calendar-sweep HTTP no dia 1 emite aviso e aviso de reauth", async () => {
    await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-jobs",
      roleCode: "Admin",
      name: "Admin Jobs",
      email: "admin-jobs@test",
    });
    currentUser = { id: admin.userId!, email: "admin-jobs@test" };
    deps.now = () => new Date("2026-09-01T08:00:00.000Z");

    await upsertBankConnection(deps, {
      tenantId: TENANT,
      accountIban: "PT50001800034978380602065",
      consentStatus: BANK_CONSENT_STATUS.authorized,
      consentValidUntil: "2026-09-05T00:00:00.000Z",
    });

    const res = await app.request("/f2/jobs/calendar-sweep", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notices: { skipped: boolean; issued: string[] };
      reauth: { noticed: Array<{ noticed: boolean }> };
    };
    expect(body.notices.skipped).toBe(false);
    expect(body.notices.issued.length).toBe(1);
    expect(body.reauth.noticed.some((n) => n.noticed)).toBe(true);
  });
});

describe("F2 HTTP 403 — Owner e Fiscalizacao nas rotas de gestor", () => {
  const managerRoutes: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [
    { path: "/f2/payments/candidates", method: "POST", body: { movements: [{ amountCents: 100 }] } },
    {
      path: "/f2/bank-connections",
      method: "POST",
      body: { accountIban: "PT50001800034978380602065" },
    },
    { path: "/f2/bank-connections", method: "GET" },
    { path: "/f2/jobs/reauth-notices", method: "POST", body: {} },
    { path: "/f2/jobs/monthly-notices", method: "POST", body: {} },
    { path: "/f2/jobs/receipt-sweep", method: "POST", body: {} },
    { path: "/f2/jobs/calendar-sweep", method: "POST", body: {} },
  ];

  test("Owner e Fiscalizacao recebem 403", async () => {
    const owner = await seedActor({
      userId: "user-owner-mgr",
      roleCode: "Owner",
      name: "Owner Mgr",
      email: "owner-mgr@test",
    });
    const fiscal = await seedActor({
      userId: "user-fiscal-mgr",
      roleCode: "Fiscalizacao",
      name: "Fiscal Mgr",
      email: "fiscal-mgr@test",
    });

    for (const actor of [owner, fiscal]) {
      currentUser = { id: actor.userId!, email: actor.email };
      for (const route of managerRoutes) {
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

  test("sem membership → 403 nas rotas novas", async () => {
    const person = await createPersonRepo(deps.db).insert({
      id: crypto.randomUUID(),
      userId: "user-no-membership",
      name: "Sem Membership",
      email: "no-membership@test",
      createdAt: new Date(),
    });
    currentUser = { id: person.userId!, email: "no-membership@test" };

    for (const route of managerRoutes) {
      const res = await app.request(route.path, {
        method: route.method,
        headers: route.body ? { "content-type": "application/json" } : undefined,
        body: route.body ? JSON.stringify(route.body) : undefined,
      });
      expect({
        path: route.path,
        method: route.method,
        status: res.status,
      }).toEqual({
        path: route.path,
        method: route.method,
        status: 403,
      });
    }
  });
});
