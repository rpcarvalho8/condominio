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
import { BUDGET_LINE_KINDS, INGEST_DOCUMENT_KINDS } from "./domain/constitution";
import {
  ALLOCATION_STATUS,
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
  const db = drizzle(client, { schema });
  deps = { db, getTenantId: () => TENANT };
  app = buildApp();
});

beforeEach(async () => {
  currentUser = null;
  for (const table of [
    "financial_documents",
    "allocations",
    "ledger_entries",
    "tenant_ledger_integrity",
    "payments",
    "f2_bank_movements",
    "settlement_policies",
    "accounting_periods",
    "obligations",
    "annual_budget_lines",
    "annual_budgets",
    "constitution_fracoes",
    "extract_lines",
    "ingest_documents",
    "memberships",
    "persons",
    "audit_events",
    "domain_events",
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
    await clientA.execute("PRAGMA busy_timeout=8000");
    await clientB.execute("PRAGMA busy_timeout=8000");
    const depsA: KernelDeps = { db: drizzle(clientA, { schema }), getTenantId: () => TENANT };
    const depsB: KernelDeps = { db: drizzle(clientB, { schema }), getTenantId: () => TENANT };

    const settled = await Promise.allSettled([
      allocatePayment(depsA, { tenantId: TENANT, paymentId: p1.id }),
      allocatePayment(depsB, { tenantId: TENANT, paymentId: p2.id }),
    ]);
    clientA.close();
    clientB.close();

    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

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
  });

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
    await clientA.execute("PRAGMA busy_timeout=8000");
    await clientB.execute("PRAGMA busy_timeout=8000");
    const depsA: KernelDeps = { db: drizzle(clientA, { schema }), getTenantId: () => TENANT };
    const depsB: KernelDeps = { db: drizzle(clientB, { schema }), getTenantId: () => TENANT };

    const settled = await Promise.allSettled([
      allocatePayment(depsA, { tenantId: TENANT, paymentId: payment.id }),
      allocatePayment(depsB, { tenantId: TENANT, paymentId: payment.id }),
    ]);
    clientA.close();
    clientB.close();

    expect(settled.filter((s) => s.status === "fulfilled").length).toBe(2);

    const allocs = await client.execute(
      `SELECT COALESCE(SUM(amount_cents), 0) AS t FROM allocations WHERE payment_id = ?`,
      [payment.id],
    );
    expect(Number(allocs.rows[0]!.t)).toBe(15_000);

    const chain = await validateLedgerChain(deps, { tenantId: TENANT });
    expect(chain.ok).toBe(true);
  });
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
