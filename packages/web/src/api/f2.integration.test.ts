/**
 * F2 — Financeiro / Ledger (vertical slice).
 * Astra A5/A6/A7: prova contra handlers/use cases reais (`createF2Routes` + Membership HTTP).
 * A6: Payment sem Allocation, parcial, multi-allocation, reversal append-only, duplicado, recibo.
 * A7: AuditEvent.actor_person_id = Person da Membership activa; sem Membership falha fechado.
 * Dublês só para Enable Banking (ASPSP). Sem réplica da lógica de negócio no teste.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { getTableConfig } from "drizzle-orm/sqlite-core";
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
  isUniqueConstraintError,
  issueReceiptForPayment,
  listPayments,
  openAccountingPeriod,
  recordKernelBankMovement,
  registerPayment,
} from "./application/finance/f2-finance";
import { reconstructFracaoBalance } from "./application/finance/f2-ledger-balance";
import {
  ingestCandidateMovement,
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
import {
  completeBankConsent,
  decodeConsentState,
  startBankConsent,
  syncBankConnection,
} from "./application/finance/f2-bank-sync";
import {
  mapEnableBankingTransaction,
  type EnableBankingClient,
  type EnableBankingTransaction,
} from "./application/finance/enable-banking-adapter";
import {
  extractFracaoCodeFromDescription,
  extractPayerFromDescription,
  identityNameMatches,
  MIN_BARE_FRACAO_CODE_LENGTH,
} from "./application/finance/f2-identity";
import { processOutbox } from "./application/jobs/process-outbox";
import { ownerContactDrafts } from "./database/schema";
import { BUDGET_LINE_KINDS, INGEST_DOCUMENT_KINDS } from "./domain/constitution";
import { DomainError } from "./domain/errors";
import {
  ALLOCATION_STATUS,
  BANK_CONSENT_STATUS,
  CANDIDATE_SOURCES,
  CASH_STATUS,
  LEDGER_ENTRY_TYPES,
  PAYMENT_METHODS,
  VERIFICATION_METHOD,
} from "./domain/finance";
import { applyDomainKernelSchema } from "./infra/kernel-schema";
import { applyF1ConstitutionSchema } from "./infra/f1-schema";
import { applyF2FinanceSchema } from "./infra/f2-schema";
import type { KernelDeps } from "./infra/kernel-deps";
import { createMembershipRepo } from "./infra/repos/membership-repo";
import { createPersonRepo } from "./infra/repos/person-repo";
import type { KernelAuthUser, KernelVariables } from "./middleware/membership";
import { createF2Routes } from "./routes/f2";
import {
  AUDIT_SOURCE_F2,
  AUDIT_SOURCE_F2_JOB,
  F2_ACTOR_REQUIRED_CODE,
  systemAuditActor,
} from "./domain/audit";
import { createAuditEventRepo } from "./infra/repos/audit-event-repo";

const DB_PATH = path.join(import.meta.dir, "..", "..", ".tmp-test-f2.db");
const DB_URL = `file:${DB_PATH}`;

let client: ReturnType<typeof createClient>;
let deps: KernelDeps;
const TENANT = "tenant-f2";
let currentUser: KernelAuthUser | null = null;
let app: Hono;

async function seedFracaoWithObligations(opts?: {
  year?: number;
  lines?: Array<{ kind: string; label: string; amountCents: number }>;
}) {
  const year = opts?.year ?? 2026;
  const budgetLines = opts?.lines ?? [
    { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Quota", amountCents: 10_000_00 },
    { kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 1_000_00 },
  ];
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
    year,
    title: `Orçamento ${year}`,
    lines: budgetLines,
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
  tenantId?: string;
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
    tenantId: opts.tenantId ?? TENANT,
    roleCode: opts.roleCode,
    createdAt: new Date(),
  });
  return person;
}

function membershipAuditActor(
  person: { id: string; userId?: string | null },
  requestId?: string | null,
) {
  return {
    personId: person.id,
    userId: person.userId ?? null,
    requestId: requestId ?? null,
    source: AUDIT_SOURCE_F2,
  };
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

function authUser(person: SeededActor): KernelAuthUser {
  return { id: person.userId!, email: person.email ?? undefined };
}

async function membershipIdFor(personId: string): Promise<string> {
  const row = await client.execute(`SELECT id FROM memberships WHERE person_id = ?`, [personId]);
  return String(row.rows[0]!.id);
}

/** HTTP real via `createF2Routes` + Membership (padrão A4/A5). */
async function f2Request(
  path: string,
  init?: {
    method?: string;
    body?: unknown;
    user?: SeededActor | KernelAuthUser | null;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  if (init && "user" in init) {
    const u = init.user;
    currentUser = !u ? null : "userId" in u ? authUser(u as SeededActor) : (u as KernelAuthUser);
  }
  const method = init?.method ?? (init?.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { ...(init?.headers ?? {}) };
  if (init?.body !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }
  return app.request(path, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function f2Json<T>(
  path: string,
  init?: {
    method?: string;
    body?: unknown;
    user?: SeededActor | KernelAuthUser | null;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: T }> {
  const res = await f2Request(path, init);
  return { status: res.status, body: (await res.json()) as T };
}

async function expectDomainCode(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { code?: string; message?: string };
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
  deps = { db, getTenantId: () => TENANT };
  app = buildApp();
});

beforeEach(async () => {
  currentUser = null;
  deps.now = undefined;
  deps.enableBanking = undefined;
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
    const admin = await seedActor({
      userId: "user-admin-evidence",
      roleCode: "Admin",
      name: "Admin",
      email: "admin-evidence@test",
    });

    await expectDomainCode(
      await f2Request("/f2/payments", {
        user: admin,
        body: {
          fracaoId: fracao.id,
          amountCents: 5_000,
          paymentMethod: PAYMENT_METHODS.cash,
        },
      }),
      400,
      "cash_evidence_required",
    );

    const created = await f2Json<{
      id: string;
      cashStatus: string;
    }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 5_000,
        paymentMethod: PAYMENT_METHODS.cash,
        evidenceUploadId: "upload-cash-1",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.cashStatus).toBe(CASH_STATUS.registered);

    await expectDomainCode(
      await f2Request(`/f2/payments/${created.body.id}/allocate`, { method: "POST" }),
      409,
      "cash_not_verified",
    );
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

    const created = await f2Json<{
      id: string;
      cashStatus: string;
      registeredByPersonId: string | null;
    }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 50_000,
        paymentMethod: PAYMENT_METHODS.cash,
        evidenceUploadId: "upload-cash-2",
      },
    });
    expect(created.status).toBe(201);
    const paymentId = created.body.id;

    await expectDomainCode(
      await f2Request(`/f2/payments/${paymentId}/verify-cash`, {
        user: admin,
        body: { verificationMethod: VERIFICATION_METHOD.secondPerson },
      }),
      403,
      "self_verify_forbidden",
    );

    const verified = await f2Json<{
      cashStatus: string;
      verifiedByPersonId: string | null;
      registeredByPersonId: string | null;
    }>(`/f2/payments/${paymentId}/verify-cash`, {
      user: fiscal,
      body: { verificationMethod: VERIFICATION_METHOD.secondPerson },
    });
    expect(verified.status).toBe(200);
    expect(verified.body.cashStatus).toBe(CASH_STATUS.verified);
    expect(verified.body.verifiedByPersonId).toBe(fiscal.id);
    expect(verified.body.verifiedByPersonId).not.toBe(verified.body.registeredByPersonId);

    const movement = await recordKernelBankMovement(deps, {
      tenantId: TENANT,
      amountCents: 50_000,
      description: "depósito cash",
    });
    const deposited = await f2Json<{ cashStatus: string; bankMovementId: string | null }>(
      `/f2/payments/${paymentId}/deposit-cash`,
      { user: admin, body: { bankMovementId: movement.id } },
    );
    expect(deposited.status).toBe(200);
    expect(deposited.body.cashStatus).toBe(CASH_STATUS.deposited);
    expect(deposited.body.bankMovementId).toBe(movement.id);

    const result = await f2Json<{
      idempotent: boolean;
      allocations: unknown[];
      payment: { allocationStatus: string };
    }>(`/f2/payments/${paymentId}/allocate`, { user: admin, method: "POST" });
    expect(result.status).toBe(200);
    expect(result.body.idempotent).toBe(false);
    expect(result.body.allocations.length).toBeGreaterThan(0);
    expect(result.body.payment.allocationStatus).toBe(ALLOCATION_STATUS.totalmenteAlocado);

    const chain = await f2Json<{ ok: boolean; entries: number }>("/f2/ledger/validate", {
      user: admin,
      method: "POST",
    });
    expect(chain.status).toBe(200);
    expect(chain.body.ok).toBe(true);
    expect(chain.body.entries).toBeGreaterThanOrEqual(2); // genesis + ≥1 allocation

    const receipt = await f2Json<{
      id: string;
      docType: string;
      generatedFromJson: string;
    }>(`/f2/payments/${paymentId}/receipt`, { user: admin, method: "POST" });
    expect(receipt.status).toBe(201);
    expect(receipt.body.docType).toBe("Receipt");
    const generatedFrom = JSON.parse(receipt.body.generatedFromJson) as {
      paymentId: string;
      allocationIds: string[];
    };
    expect(generatedFrom.paymentId).toBe(paymentId);
    expect(generatedFrom.allocationIds.length).toBe(result.body.allocations.length);

    const again = await f2Json<{ idempotent: boolean }>(`/f2/payments/${paymentId}/allocate`, {
      user: admin,
      method: "POST",
    });
    expect(again.status).toBe(200);
    expect(again.body.idempotent).toBe(true);

    const receiptAgain = await f2Json<{ id: string }>(`/f2/payments/${paymentId}/receipt`, {
      user: admin,
      method: "POST",
    });
    expect(receiptAgain.status).toBe(201);
    expect(receiptAgain.body.id).toBe(receipt.body.id);
  });

  test("transferência aloca directamente e cadeia detecta adulteração", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-tamper",
      roleCode: "Admin",
      name: "Admin Tamper",
      email: "admin-tamper@test",
    });

    const created = await f2Json<{ id: string; cashStatus: string | null }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 20_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.cashStatus).toBeNull();

    const result = await f2Json<{ allocations: unknown[] }>(
      `/f2/payments/${created.body.id}/allocate`,
      { user: admin, method: "POST" },
    );
    expect(result.status).toBe(200);
    expect(result.body.allocations.length).toBeGreaterThan(0);

    const ok = await f2Json<{ ok: boolean }>("/f2/ledger/validate", {
      user: admin,
      method: "POST",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    const tip = await client.execute(
      `SELECT id, payload_json FROM ledger_entries WHERE tenant_id = ? AND entry_type = 'allocation' LIMIT 1`,
      [TENANT],
    );
    const row = tip.rows[0]!;
    await client.execute({
      sql: `UPDATE ledger_entries SET payload_json = ? WHERE id = ?`,
      args: ['{"tampered":true}', String(row.id)],
    });

    const broken = await f2Json<{ ok: boolean }>("/f2/ledger/validate", {
      user: admin,
      method: "POST",
    });
    expect(broken.status).toBe(200);
    expect(broken.body.ok).toBe(false);

    await expectDomainCode(
      await f2Request("/f2/payments", {
        user: admin,
        body: {
          fracaoId: fracao.id,
          amountCents: 1_000,
          paymentMethod: PAYMENT_METHODS.bankTransfer,
        },
      }),
      409,
      "ledger_chain_broken",
    );
  });

  test("recibo vazio é rejeitado", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-empty-receipt",
      roleCode: "Admin",
      name: "Admin",
      email: "admin-empty-receipt@test",
    });
    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 1_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(created.status).toBe(201);
    await expectDomainCode(
      await f2Request(`/f2/payments/${created.body.id}/receipt`, { method: "POST" }),
      409,
      "empty_receipt",
    );
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
    const otherAdmin = await seedActor({
      userId: "user-admin-nofiscal-2",
      roleCode: "Admin",
      name: "Admin Outro",
      email: "admin-nofiscal-2@test",
    });
    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 8_000,
        paymentMethod: PAYMENT_METHODS.cash,
        evidenceUploadId: "ev-nofiscal",
      },
    });
    expect(created.status).toBe(201);
    const paymentId = created.body.id;

    await expectDomainCode(
      await f2Request(`/f2/payments/${paymentId}/verify-cash`, {
        user: otherAdmin,
        body: { verificationMethod: VERIFICATION_METHOD.secondPerson },
      }),
      403,
      "fiscalizacao_required",
    );

    await expectDomainCode(
      await f2Request(`/f2/payments/${paymentId}/verify-cash`, {
        user: admin,
        body: { verificationMethod: VERIFICATION_METHOD.bankDeposit },
      }),
      400,
      "bank_movement_required",
    );

    const foreign = await recordKernelBankMovement(deps, {
      tenantId: "other-tenant",
      amountCents: 8_000,
    });
    await expectDomainCode(
      await f2Request(`/f2/payments/${paymentId}/verify-cash`, {
        user: admin,
        body: {
          verificationMethod: VERIFICATION_METHOD.bankDeposit,
          bankMovementId: foreign.id,
        },
      }),
      404,
      "bank_movement_not_found",
    );

    const tiny = await recordKernelBankMovement(deps, {
      tenantId: TENANT,
      amountCents: 100,
    });
    await expectDomainCode(
      await f2Request(`/f2/payments/${paymentId}/verify-cash`, {
        user: admin,
        body: {
          verificationMethod: VERIFICATION_METHOD.bankDeposit,
          bankMovementId: tiny.id,
        },
      }),
      400,
      "bank_movement_amount_mismatch",
    );

    const movement = await recordKernelBankMovement(deps, {
      tenantId: TENANT,
      amountCents: 8_000,
    });
    const verified = await f2Json<{
      cashStatus: string;
      verificationMethod: string | null;
      bankMovementId: string | null;
    }>(`/f2/payments/${paymentId}/verify-cash`, {
      user: admin,
      body: {
        verificationMethod: VERIFICATION_METHOD.bankDeposit,
        bankMovementId: movement.id,
      },
    });
    expect(verified.status).toBe(200);
    expect(verified.body.cashStatus).toBe(CASH_STATUS.verified);
    expect(verified.body.verificationMethod).toBe(VERIFICATION_METHOD.bankDeposit);
    expect(verified.body.bankMovementId).toBe(movement.id);

    const deposited = await f2Json<{ cashStatus: string }>(`/f2/payments/${paymentId}/deposit-cash`, {
      user: admin,
      body: {},
    });
    expect(deposited.status).toBe(200);
    expect(deposited.body.cashStatus).toBe(CASH_STATUS.deposited);
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
    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 3_000,
        paymentMethod: PAYMENT_METHODS.cash,
        evidenceUploadId: "ev-nodep",
      },
    });
    expect(created.status).toBe(201);
    const verify = await f2Request(`/f2/payments/${created.body.id}/verify-cash`, {
      user: fiscal,
      body: { verificationMethod: VERIFICATION_METHOD.secondPerson },
    });
    expect(verify.status).toBe(200);
    await expectDomainCode(
      await f2Request(`/f2/payments/${created.body.id}/deposit-cash`, {
        user: admin,
        body: {},
      }),
      400,
      "bank_movement_required",
    );
  });
});

describe("F2 ADR-029 hash-chain concurrency", () => {
  test("duas alocações concorrentes: sequences únicas, cadeia íntegra, sem open_amount negativo", async () => {
    const { fracao, obligations: obs } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-race",
      roleCode: "Admin",
      name: "Admin Race",
      email: "admin-race@test",
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
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 10_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    const p2 = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 10_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(p1.status).toBe(201);
    expect(p2.status).toBe(201);

    const clientA = createClient({ url: DB_URL });
    const clientB = createClient({ url: DB_URL });
    try {
      await clientA.execute("PRAGMA busy_timeout=250");
      await clientB.execute("PRAGMA busy_timeout=250");
      const depsA: KernelDeps = { db: drizzle(clientA, { schema }), getTenantId: () => TENANT };
      const depsB: KernelDeps = { db: drizzle(clientB, { schema }), getTenantId: () => TENANT };

      const actor = { personId: admin.id, userId: admin.userId };
      const settled = await Promise.allSettled([
        allocatePayment(depsA, { tenantId: TENANT, paymentId: p1.body.id, actor }),
        allocatePayment(depsB, { tenantId: TENANT, paymentId: p2.body.id, actor }),
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

    const chain = await f2Json<{ ok: boolean }>("/f2/ledger/validate", {
      user: admin,
      method: "POST",
    });
    expect(chain.status).toBe(200);
    expect(chain.body.ok).toBe(true);

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
    const admin = await seedActor({
      userId: "user-admin-idemp-race",
      roleCode: "Admin",
      name: "Admin",
      email: "admin-idemp-race@test",
    });
    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 15_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(created.status).toBe(201);
    const paymentId = created.body.id;

    const clientA = createClient({ url: DB_URL });
    const clientB = createClient({ url: DB_URL });
    try {
      await clientA.execute("PRAGMA busy_timeout=250");
      await clientB.execute("PRAGMA busy_timeout=250");
      const depsA: KernelDeps = { db: drizzle(clientA, { schema }), getTenantId: () => TENANT };
      const depsB: KernelDeps = { db: drizzle(clientB, { schema }), getTenantId: () => TENANT };

      const actor = { personId: admin.id, userId: admin.userId };
      const settled = await Promise.allSettled([
        allocatePayment(depsA, { tenantId: TENANT, paymentId, actor }),
        allocatePayment(depsB, { tenantId: TENANT, paymentId, actor }),
      ]);
      expect(settled.filter((s) => s.status === "fulfilled").length).toBe(2);
    } finally {
      clientA.close();
      clientB.close();
    }

    const allocs = await client.execute(
      `SELECT COALESCE(SUM(amount_cents), 0) AS t FROM allocations WHERE payment_id = ?`,
      [paymentId],
    );
    expect(Number(allocs.rows[0]!.t)).toBe(15_000);

    const chain = await f2Json<{ ok: boolean }>("/f2/ledger/validate", {
      user: admin,
      method: "POST",
    });
    expect(chain.status).toBe(200);
    expect(chain.body.ok).toBe(true);
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
    const payment = (await created.json()) as {
      id: string;
      cashStatus: string;
      verificationMethod: string | null;
      registeredByPersonId: string | null;
      verifiedByPersonId: string | null;
    };
    expect(payment.cashStatus).toBe(CASH_STATUS.registered);
    expect(payment.verificationMethod).toBeNull();
    expect(payment.registeredByPersonId).toBe(admin.id);
    expect(payment.verifiedByPersonId).toBeNull();

    currentUser = { id: admin.userId! };
    const selfVerify = await app.request(`/f2/payments/${payment.id}/verify-cash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verificationMethod: VERIFICATION_METHOD.secondPerson }),
    });
    expect(selfVerify.status).toBe(403);
    const selfBody = (await selfVerify.json()) as { message: string; code?: string };
    expect(selfBody.code).toBe("self_verify_forbidden");
    expect(selfBody.message).toMatch(/ADR-028/);

    currentUser = { id: fiscal.userId! };
    const fiscalVerify = await app.request(`/f2/payments/${payment.id}/verify-cash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verificationMethod: VERIFICATION_METHOD.secondPerson }),
    });
    expect(fiscalVerify.status).toBe(200);
    const verified = (await fiscalVerify.json()) as {
      cashStatus: string;
      verificationMethod: string | null;
      registeredByPersonId: string | null;
      verifiedByPersonId: string | null;
    };
    expect(verified.cashStatus).toBe(CASH_STATUS.verified);
    expect(verified.verificationMethod).toBe(VERIFICATION_METHOD.secondPerson);
    expect(verified.registeredByPersonId).toBe(admin.id);
    expect(verified.verifiedByPersonId).toBe(fiscal.id);
    expect(verified.verifiedByPersonId).not.toBe(verified.registeredByPersonId);

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

describe("F2 Astra A4 — HTTP cash segregation (ADR-028)", () => {
  test("mesma Membership: second_person recusado; bank_deposit com MovimentoBancario do tenant → deposited", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-a4",
      roleCode: "Admin",
      name: "Admin A4",
      email: "admin-a4@test",
    });
    const fiscal = await seedActor({
      userId: "user-fiscal-a4",
      roleCode: "Fiscalizacao",
      name: "Fiscal A4",
      email: "fiscal-a4@test",
    });

    const membershipRepo = createMembershipRepo(deps.db);
    const adminMemberships = await membershipRepo.findActiveForPersonTenant(admin.id, TENANT);
    const fiscalMemberships = await membershipRepo.findActiveForPersonTenant(fiscal.id, TENANT);
    expect(adminMemberships).toHaveLength(1);
    expect(fiscalMemberships).toHaveLength(1);
    expect(adminMemberships[0]!.id).not.toBe(fiscalMemberships[0]!.id);
    expect(admin.id).not.toBe(fiscal.id);
    expect(adminMemberships[0]!.roleCode).toBe("Admin");
    expect(fiscalMemberships[0]!.roleCode).toBe("Fiscalizacao");

    currentUser = { id: admin.userId!, email: "admin-a4@test" };
    const created = await app.request("/f2/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fracaoId: fracao.id,
        amountCents: 6_000,
        paymentMethod: PAYMENT_METHODS.cash,
        evidenceUploadId: "ev-a4-cash",
      }),
    });
    expect(created.status).toBe(201);
    const payment = (await created.json()) as {
      id: string;
      cashStatus: string;
      verificationMethod: string | null;
      registeredByPersonId: string | null;
      verifiedByPersonId: string | null;
      bankMovementId: string | null;
    };
    expect(payment.cashStatus).toBe(CASH_STATUS.registered);
    expect(payment.verificationMethod).toBeNull();
    expect(payment.registeredByPersonId).toBe(admin.id);
    expect(payment.verifiedByPersonId).toBeNull();
    expect(payment.bankMovementId).toBeNull();

    const selfVerify = await app.request(`/f2/payments/${payment.id}/verify-cash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verificationMethod: VERIFICATION_METHOD.secondPerson }),
    });
    expect(selfVerify.status).toBe(403);
    const selfBody = (await selfVerify.json()) as { message: string; code?: string };
    expect(selfBody.code).toBe("self_verify_forbidden");
    expect(selfBody.message).toMatch(/não pode verificar/);

    const stillRegistered = await client.execute(
      `SELECT cash_status, verification_method, verified_by_person_id, bank_movement_id
       FROM payments WHERE id = ?`,
      [payment.id],
    );
    expect(String(stillRegistered.rows[0]!.cash_status)).toBe(CASH_STATUS.registered);
    expect(stillRegistered.rows[0]!.verification_method).toBeNull();
    expect(stillRegistered.rows[0]!.verified_by_person_id).toBeNull();
    expect(stillRegistered.rows[0]!.bank_movement_id).toBeNull();

    const noMovement = await app.request(`/f2/payments/${payment.id}/verify-cash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verificationMethod: VERIFICATION_METHOD.bankDeposit }),
    });
    expect(noMovement.status).toBe(400);
    expect(((await noMovement.json()) as { code?: string }).code).toBe("bank_movement_required");

    const foreign = await recordKernelBankMovement(deps, {
      tenantId: "other-tenant-a4",
      amountCents: 6_000,
    });
    const foreignVerify = await app.request(`/f2/payments/${payment.id}/verify-cash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verificationMethod: VERIFICATION_METHOD.bankDeposit,
        bankMovementId: foreign.id,
      }),
    });
    expect(foreignVerify.status).toBe(404);
    expect(((await foreignVerify.json()) as { code?: string }).code).toBe("bank_movement_not_found");

    const movement = await recordKernelBankMovement(deps, {
      tenantId: TENANT,
      amountCents: 6_000,
      description: "depósito cash A4",
    });
    expect(movement.tenantId).toBe(TENANT);

    const verified = await app.request(`/f2/payments/${payment.id}/verify-cash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verificationMethod: VERIFICATION_METHOD.bankDeposit,
        bankMovementId: movement.id,
      }),
    });
    expect(verified.status).toBe(200);
    const verifiedBody = (await verified.json()) as {
      cashStatus: string;
      verificationMethod: string | null;
      registeredByPersonId: string | null;
      verifiedByPersonId: string | null;
      bankMovementId: string | null;
    };
    expect(verifiedBody.cashStatus).toBe(CASH_STATUS.verified);
    expect(verifiedBody.verificationMethod).toBe(VERIFICATION_METHOD.bankDeposit);
    expect(verifiedBody.registeredByPersonId).toBe(admin.id);
    expect(verifiedBody.verifiedByPersonId).toBe(admin.id);
    expect(verifiedBody.bankMovementId).toBe(movement.id);

    const deposited = await app.request(`/f2/payments/${payment.id}/deposit-cash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(deposited.status).toBe(200);
    const depositedBody = (await deposited.json()) as {
      cashStatus: string;
      verificationMethod: string | null;
      bankMovementId: string | null;
      depositedAt: unknown;
    };
    expect(depositedBody.cashStatus).toBe(CASH_STATUS.deposited);
    expect(depositedBody.verificationMethod).toBe(VERIFICATION_METHOD.bankDeposit);
    expect(depositedBody.bankMovementId).toBe(movement.id);
    expect(depositedBody.depositedAt).toBeTruthy();

    const persisted = await client.execute(
      `SELECT cash_status, verification_method, registered_by_person_id, verified_by_person_id,
              bank_movement_id, deposited_at FROM payments WHERE id = ?`,
      [payment.id],
    );
    const row = persisted.rows[0]!;
    expect(String(row.cash_status)).toBe(CASH_STATUS.deposited);
    expect(String(row.verification_method)).toBe(VERIFICATION_METHOD.bankDeposit);
    expect(String(row.registered_by_person_id)).toBe(admin.id);
    expect(String(row.verified_by_person_id)).toBe(admin.id);
    expect(String(row.bank_movement_id)).toBe(movement.id);
    expect(row.deposited_at).toBeTruthy();

    currentUser = { id: fiscal.userId!, email: "fiscal-a4@test" };
    const fiscalLate = await app.request(`/f2/payments/${payment.id}/verify-cash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verificationMethod: VERIFICATION_METHOD.secondPerson }),
    });
    expect(fiscalLate.status).toBe(409);
    expect(((await fiscalLate.json()) as { code?: string }).code).toBe("invalid_cash_state");
  });
});

describe("F2 PaymentNotice e Recibo", () => {
  test("aviso valida tenant, fração e montante das obligations", async () => {
    const { fracao, obligations: obs } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-notice",
      roleCode: "Admin",
      name: "Admin Notice",
      email: "admin-notice@test",
    });
    const sum = obs.reduce((s, o) => s + o.amountCents, 0);
    const obligationIds = obs.map((o) => o.id);

    const ok = await f2Json<{ docType: string }>("/f2/documents/payment-notice", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: sum,
        periodLabel: "2026-01",
        obligationIds,
      },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.docType).toBe("PaymentNotice");

    await expectDomainCode(
      await f2Request("/f2/documents/payment-notice", {
        user: admin,
        body: {
          fracaoId: fracao.id,
          amountCents: 1,
          periodLabel: "2026-01",
          obligationIds,
        },
      }),
      400,
      "notice_amount_mismatch",
    );

    await expectDomainCode(
      await f2Request("/f2/documents/payment-notice", {
        user: admin,
        body: {
          fracaoId: fracao.id,
          amountCents: sum,
          periodLabel: "2026-01",
          obligationIds: [crypto.randomUUID()],
        },
      }),
      404,
      "obligation_not_found",
    );

    const now = Math.floor(Date.now() / 1000);
    const otherFracaoId = crypto.randomUUID();
    await client.execute({
      sql: `INSERT INTO constitution_fracoes (id, tenant_id, codigo, tipo, permilagem, status, created_at, confirmed_at)
            VALUES (?, ?, 'B', 'fracao', 0, 'confirmed', ?, ?)`,
      args: [otherFracaoId, TENANT, now, now],
    });
    await expectDomainCode(
      await f2Request("/f2/documents/payment-notice", {
        user: admin,
        body: {
          fracaoId: otherFracaoId,
          amountCents: sum,
          periodLabel: "2026-01",
          obligationIds,
        },
      }),
      400,
      "obligation_fracao_mismatch",
    );
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
    const membershipId = await membershipIdFor(admin.id);
    const far = await f2Json<{
      reauthorizationRequired: boolean;
      authorizedByMembershipId: string | null;
    }>("/f2/bank-connections", {
      user: admin,
      body: {
        accountIban: iban,
        consentStatus: BANK_CONSENT_STATUS.authorized,
        consentValidUntil: "2027-01-01T00:00:00.000Z",
        authorizedByMembershipId: membershipId,
      },
    });
    expect(far.status).toBe(201);
    expect(far.body.reauthorizationRequired).toBe(false);
    expect(far.body.authorizedByMembershipId).toBeTruthy();

    const skipped = await f2Json<{ noticed: Array<{ noticed: boolean }> }>(
      "/f2/jobs/reauth-notices",
      { user: admin, body: {} },
    );
    expect(skipped.status).toBe(200);
    expect(skipped.body.noticed.filter((n) => n.noticed).length).toBe(0);

    deps.now = () => new Date("2026-09-10T12:00:00.000Z");
    const due = await f2Json<{
      reauthorizationRequired: boolean;
      consentStatus: string;
    }>("/f2/bank-connections", {
      user: admin,
      body: {
        accountIban: iban,
        consentStatus: BANK_CONSENT_STATUS.authorized,
        consentValidUntil: "2026-09-20T00:00:00.000Z",
      },
    });
    expect(due.status).toBe(201);
    expect(due.body.reauthorizationRequired).toBe(true);
    expect(due.body.consentStatus).toBe(BANK_CONSENT_STATUS.reauthorizationRequired);

    const first = await f2Json<{ noticed: Array<{ noticed: boolean }> }>(
      "/f2/jobs/reauth-notices",
      { user: admin, body: {} },
    );
    expect(first.status).toBe(200);
    expect(first.body.noticed.some((n) => n.noticed)).toBe(true);

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

    const second = await f2Json<{ noticed: Array<{ noticed: boolean }> }>(
      "/f2/jobs/reauth-notices",
      { user: admin, body: {} },
    );
    expect(second.status).toBe(200);
    expect(second.body.noticed.every((n) => n.noticed === false)).toBe(true);

    const audits = await client.execute(
      `SELECT type FROM audit_events WHERE tenant_id = ? AND type = 'bank_connection.reauthorization_notice'`,
      [TENANT],
    );
    expect(audits.rows.length).toBe(1);
  });

  test("job de reauth (f2.job) sem gestor: aviso não usa IBAN como destino de email", async () => {
    const iban = "PT50001800034978380602065";
    deps.now = () => new Date("2026-09-10T12:00:00.000Z");
    const setupAdmin = await seedActor({
      userId: "user-admin-reauth-setup",
      roleCode: "Admin",
      name: "Admin Reauth Setup",
      email: "admin-reauth-setup@test",
    });
    await upsertBankConnection(deps, {
      tenantId: TENANT,
      accountIban: iban,
      consentStatus: BANK_CONSENT_STATUS.authorized,
      consentValidUntil: "2026-09-20T00:00:00.000Z",
      actor: membershipAuditActor(setupAdmin, "human-reauth-setup"),
    });
    const membershipRepo = createMembershipRepo(deps.db);
    const [membership] = await membershipRepo.findActiveForPersonTenant(setupAdmin.id, TENANT);
    await membershipRepo.revoke({ id: membership!.id, revokedAt: new Date() });
    const sweep = await sweepBankReauthNotices(deps, {
      tenantId: TENANT,
      actor: systemAuditActor("job-reauth-no-manager"),
    });
    expect(sweep.noticed.some((n) => n.noticed)).toBe(true);
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
    expect(isResolvedAdminMailbox(BANK_REAUTH_ADMIN_FALLBACK)).toBe(false);
    expect(isResolvedAdminMailbox(String(deliveries.rows[0]!.destination))).toBe(false);

    const res = await f2Request("/f2/jobs/reauth-notices", {
      user: null,
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(401);
  });

  test("authorizedByMembershipId tem de existir neste tenant", async () => {
    const admin = await seedActor({
      userId: "user-admin-authz",
      roleCode: "Admin",
      name: "Admin Authz",
      email: "admin-authz@test",
    });
    await expectDomainCode(
      await f2Request("/f2/bank-connections", {
        user: admin,
        body: {
          accountIban: "PT50001800034978380602065",
          authorizedByMembershipId: crypto.randomUUID(),
        },
      }),
      400,
      "membership_not_found",
    );

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
    await expectDomainCode(
      await f2Request("/f2/bank-connections", {
        user: admin,
        body: { authorizedByMembershipId: otherId },
      }),
      400,
      "membership_not_found",
    );

    const owner = await seedActor({
      userId: "user-owner-authz",
      roleCode: "Owner",
      name: "Owner Authz",
      email: "owner-authz@test",
    });
    const ownerMem = await membershipIdFor(owner.id);
    await expectDomainCode(
      await f2Request("/f2/bank-connections", {
        user: admin,
        body: { authorizedByMembershipId: ownerMem },
      }),
      403,
      "authorizer_role_forbidden",
    );
  });
});

describe("F2 Payments candidatos (CSV / identity-matrix / reconciliação)", () => {
  test("CSV + nome confirmado cria Payment identificado sem Allocation e sem Quota.pago", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-csv",
      roleCode: "Admin",
      name: "Admin CSV",
      email: "admin-csv@test",
    });
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

    const ingested = await f2Json<{
      created: number;
      results: Array<{
        fracaoId: string | null;
        allocationStatus: string;
        created: boolean;
        paymentId: string;
      }>;
    }>("/f2/payments/candidates", { user: admin, body: { csvText: csv } });
    expect(ingested.status).toBe(201);
    expect(ingested.body.created).toBe(1);
    const row = ingested.body.results[0]!;
    expect(row.fracaoId).toBe(fracao.id);
    expect(row.allocationStatus).toBe(ALLOCATION_STATUS.identificado);
    expect(row.created).toBe(true);

    const again = await f2Json<{
      created: number;
      results: Array<{ paymentId: string }>;
    }>("/f2/payments/candidates", { user: admin, body: { csvText: csv } });
    expect(again.status).toBe(201);
    expect(again.body.created).toBe(0);
    expect(again.body.results[0]!.paymentId).toBe(row.paymentId);

    const allocs = await client.execute(`SELECT COUNT(*) AS n FROM allocations`);
    expect(Number(allocs.rows[0]!.n)).toBe(0);

    const pago = await client.execute(`SELECT pago FROM quotas WHERE id = 'quota-fonte-1'`);
    expect(Number(pago.rows[0]!.pago)).toBe(0);

    const unmatched = await f2Json<{
      results: Array<{ fracaoId: string | null; allocationStatus: string }>;
    }>("/f2/payments/candidates", {
      user: admin,
      body: {
        movements: [
          {
            amountCents: 12_00,
            description: "TRF CRED SEPA+ DE DESCONHECIDO XPTO",
            externalRef: "unk-1",
            source: CANDIDATE_SOURCES.identityMatrix,
          },
        ],
      },
    });
    expect(unmatched.status).toBe(201);
    expect(unmatched.body.results[0]!.fracaoId).toBeNull();
    expect(unmatched.body.results[0]!.allocationStatus).toBe(ALLOCATION_STATUS.naoAlocadoPendente);

    const pagoAfter = await client.execute(`SELECT pago FROM quotas WHERE id = 'quota-fonte-1'`);
    expect(Number(pagoAfter.rows[0]!.pago)).toBe(0);
  });

  test("ANA não identifica MARIANA por substring no descritivo", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-ana",
      roleCode: "Admin",
      name: "Admin Ana",
      email: "admin-ana@test",
    });
    await seedConfirmedOwner("A", "Mariana Silva");
    const miss = await f2Json<{
      results: Array<{ fracaoId: string | null; allocationStatus: string }>;
    }>("/f2/payments/candidates", {
      user: admin,
      body: {
        movements: [
          {
            amountCents: 50_00,
            description: "TRF CRED SEPA+ DE ANA",
            externalRef: "ana-sub-1",
            source: CANDIDATE_SOURCES.identityMatrix,
          },
        ],
      },
    });
    expect(miss.status).toBe(201);
    expect(miss.body.results[0]!.fracaoId).toBeNull();
    expect(miss.body.results[0]!.allocationStatus).toBe(ALLOCATION_STATUS.naoAlocadoPendente);

    const hit = await f2Json<{
      results: Array<{ fracaoId: string | null; allocationStatus: string }>;
    }>("/f2/payments/candidates", {
      user: admin,
      body: {
        movements: [
          {
            amountCents: 50_00,
            description: "TRF CRED SEPA+ DE MARIANA SILVA",
            externalRef: "mariana-1",
            source: CANDIDATE_SOURCES.identityMatrix,
          },
        ],
      },
    });
    expect(hit.status).toBe(201);
    expect(hit.body.results[0]!.fracaoId).toBe(fracao.id);
    expect(hit.body.results[0]!.allocationStatus).toBe(ALLOCATION_STATUS.identificado);
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
    const admin = await seedActor({
      userId: "user-admin-ingest-race",
      roleCode: "Admin",
      name: "Admin Ingest Race",
      email: "admin-ingest-race@test",
    });
    const actor = { personId: admin.id, userId: admin.userId };
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
      ingestCandidateMovement(deps, { tenantId: TENANT, movement, actor }),
      ingestCandidateMovement(deps, { tenantId: TENANT, movement, actor }),
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

    const third = await ingestCandidateMovement(deps, { tenantId: TENANT, movement, actor });
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
    const admin = await seedActor({
      userId: "user-admin-day1",
      roleCode: "Admin",
      name: "Admin Day1",
      email: "admin-day1@test",
    });
    deps.now = () => new Date("2026-09-02T10:00:00.000Z");
    const skipped = await f2Json<{ skipped: boolean; reason?: string }>(
      "/f2/jobs/monthly-notices",
      { user: admin, body: {} },
    );
    expect(skipped.status).toBe(200);
    expect(skipped.body.skipped).toBe(true);
    expect(skipped.body.reason).toBe("not_day_1");

    deps.now = () => new Date("2026-09-01T10:00:00.000Z");
    const first = await f2Json<{ skipped: boolean; issued: string[] }>(
      "/f2/jobs/monthly-notices",
      { user: admin, body: {} },
    );
    expect(first.status).toBe(200);
    expect(first.body.skipped).toBe(false);
    expect(first.body.issued.length).toBe(1);

    const second = await f2Json<{ issued: string[]; reused: string[] }>(
      "/f2/jobs/monthly-notices",
      { user: admin, body: {} },
    );
    expect(second.status).toBe(200);
    expect(second.body.issued.length).toBe(0);
    expect(second.body.reused.length).toBe(1);
    expect(second.body.reused[0]).toBe(first.body.issued[0]);
  });

  test("aviso de débito usa openAmountCents restante, não amountCents original", async () => {
    const { fracao, obligations: obs } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-open",
      roleCode: "Admin",
      name: "Admin Open",
      email: "admin-open@test",
    });
    const originalCents = obs.reduce((s, o) => s + o.amountCents, 0);
    expect(originalCents).toBeGreaterThan(20_000);

    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 20_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(created.status).toBe(201);
    const allocated = await f2Request(`/f2/payments/${created.body.id}/allocate`, {
      user: admin,
      method: "POST",
    });
    expect(allocated.status).toBe(200);

    const open = await client.execute(
      `SELECT SUM(open_amount_cents) AS n FROM obligations WHERE tenant_id = ? AND status = 'open' AND open_amount_cents > 0`,
      [TENANT],
    );
    const remaining = Number(open.rows[0]!.n);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBe(originalCents - 20_000);

    deps.now = () => new Date("2026-09-01T10:00:00.000Z");
    const notices = await f2Json<{ skipped: boolean; issued: string[] }>(
      "/f2/jobs/monthly-notices",
      { user: admin, body: {} },
    );
    expect(notices.status).toBe(200);
    expect(notices.body.skipped).toBe(false);
    expect(notices.body.issued.length).toBe(1);

    const docs = await client.execute(
      `SELECT amount_cents FROM financial_documents WHERE id = ?`,
      [notices.body.issued[0]!],
    );
    expect(Number(docs.rows[0]!.amount_cents)).toBe(remaining);
    expect(Number(docs.rows[0]!.amount_cents)).not.toBe(originalCents);
  });

  test("Allocation enfileira recibo; sweep e processOutbox emitem com generated_from", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-receipt",
      roleCode: "Admin",
      name: "Admin Receipt",
      email: "admin-receipt@test",
    });
    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 20_000,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(created.status).toBe(201);
    const allocated = await f2Json<{ allocations: unknown[] }>(
      `/f2/payments/${created.body.id}/allocate`,
      { user: admin, method: "POST" },
    );
    expect(allocated.status).toBe(200);
    expect(allocated.body.allocations.length).toBeGreaterThan(0);

    const pending = await client.execute(
      `SELECT job_type, status FROM outbox_jobs WHERE tenant_id = ? AND job_type = 'f2.issue_receipt'`,
      [TENANT],
    );
    expect(pending.rows.length).toBe(1);
    expect(pending.rows[0]!.status).toBe("pending");

    const sweep = await f2Json<{ reused: string[]; issued: string[] }>("/f2/jobs/receipt-sweep", {
      user: admin,
      body: {},
    });
    expect(sweep.status).toBe(200);
    expect(sweep.body.issued.length).toBe(1);
    expect(sweep.body.reused.length).toBe(0);

    const docs = await client.execute(
      `SELECT doc_type, generated_from_json, source_payment_id FROM financial_documents WHERE tenant_id = ? AND doc_type = 'Receipt'`,
      [TENANT],
    );
    expect(docs.rows.length).toBe(1);
    expect(String(docs.rows[0]!.source_payment_id)).toBe(created.body.id);
    const generated = JSON.parse(String(docs.rows[0]!.generated_from_json)) as {
      paymentId: string;
      allocationIds: string[];
    };
    expect(generated.paymentId).toBe(created.body.id);
    expect(generated.allocationIds.length).toBe(allocated.body.allocations.length);

    const sweepAgain = await f2Json<{ reused: string[]; issued: string[] }>(
      "/f2/jobs/receipt-sweep",
      { user: admin, body: {} },
    );
    expect(sweepAgain.status).toBe(200);
    expect(sweepAgain.body.reused.length).toBe(1);
    expect(sweepAgain.body.issued.length).toBe(0);

    await processOutbox(deps);
    const docsAfterOutbox = await client.execute(
      `SELECT COUNT(*) AS n FROM financial_documents WHERE tenant_id = ? AND doc_type = 'Receipt'`,
      [TENANT],
    );
    expect(Number(docsAfterOutbox.rows[0]!.n)).toBe(1);
  });

  test("calendar-sweep HTTP no dia 1 emite aviso e aviso de reauth", async () => {
    await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-jobs",
      roleCode: "Admin",
      name: "Admin Jobs",
      email: "admin-jobs@test",
    });
    deps.now = () => new Date("2026-09-01T08:00:00.000Z");

    await f2Request("/f2/bank-connections", {
      user: admin,
      body: {
        accountIban: "PT50001800034978380602065",
        consentStatus: BANK_CONSENT_STATUS.authorized,
        consentValidUntil: "2026-09-05T00:00:00.000Z",
      },
    });

    const res = await f2Request("/f2/jobs/calendar-sweep", {
      user: admin,
      body: {},
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

function mockEnableBanking(opts?: {
  transactions?: EnableBankingTransaction[];
  failList?: Error;
  failExchange?: Error;
  iban?: string;
}): EnableBankingClient {
  const iban = opts?.iban ?? "PT50001800034978380602065";
  return {
    isConfigured: () => true,
    createAuthSession: async ({ state }) => ({
      url: `https://eb.test/auth?state=${encodeURIComponent(state)}`,
      authorizationId: "auth-1",
    }),
    exchangeCode: async () => {
      if (opts?.failExchange) throw opts.failExchange;
      return {
        sessionId: "sess-condo-1",
        accounts: [{ uid: "acc-condo", iban, currency: "EUR" }],
        accessValidUntil: "2026-12-10T00:00:00.000Z",
      };
    },
    listTransactions: async () => {
      if (opts?.failList) throw opts.failList;
      return (
        opts?.transactions ?? [
          {
            transactionId: "eb-credit-1",
            amountCents: 50_00,
            bookedAt: new Date("2026-09-01T00:00:00.000Z"),
            description: "TRF CRED SEPA+ DE MARIA SILVA",
            debtorName: "MARIA SILVA",
            counterpartyIban: "PT50000201231234567890154",
            creditDebit: "CRDT" as const,
          },
          {
            transactionId: "eb-debit-1",
            amountCents: -12_00,
            bookedAt: new Date("2026-09-02T00:00:00.000Z"),
            description: "COMISSAO MANUTENCAO",
            debtorName: null,
            counterpartyIban: null,
            creditDebit: "DBIT" as const,
          },
        ]
      );
    },
    revokeSession: async () => {},
  };
}

describe("F2 Enable Banking PSD2", () => {
  test("consentimento ASPSP + sync cria movimentos e Payments candidatos sem Quota.pago", async () => {
    const { fracao } = await seedFracaoWithObligations();
    await seedConfirmedOwner("A", "Maria Silva");
    await client.execute({
      sql: `INSERT INTO quotas (id, fracao_id, tipo, mes, ano, valor, pago) VALUES (?, ?, 'condominio', 9, 2026, 50, 0)`,
      args: ["quota-psd2-1", fracao.id],
    });
    const admin = await seedActor({
      userId: "user-admin-psd2",
      roleCode: "Admin",
      name: "Admin PSD2",
      email: "admin-psd2@test",
    });
    deps.enableBanking = mockEnableBanking();

    const started = await f2Json<{ authorizationUrl: string }>("/f2/bank-connections/authorize", {
      user: admin,
      body: {
        aspsp: "Mock ASPSP",
        accountIban: "PT50001800034978380602065",
        scopes: ["accounts", "transactions"],
      },
    });
    expect(started.status).toBe(201);
    expect(started.body.authorizationUrl).toContain("https://eb.test/auth");
    const state = new URL(started.body.authorizationUrl).searchParams.get("state");
    expect(decodeConsentState(state)?.tenantId).toBe(TENANT);

    const authorized = await f2Request(
      `/f2/bank/callback?code=ok-code&state=${encodeURIComponent(state!)}`,
      { method: "GET" },
    );
    expect(authorized.status).toBe(302);
    expect(authorized.headers.get("location")).toContain("/f2/banking?bank_connected=1");

    const [row] = await listBankConnections(deps, TENANT);
    expect(row!.consentStatus).toBe(BANK_CONSENT_STATUS.authorized);
    expect(row!.accountIban).toBe("PT50001800034978380602065");
    expect(row!.sessionId).toBe("sess-condo-1");
    expect(row!.accountUid).toBe("acc-condo");
    expect(row!.authorizedByMembershipId).toBe(await membershipIdFor(admin.id));

    const synced = await f2Json<{ skipped: boolean; created: number; credits: number; debits: number }>(
      "/f2/bank-connections/sync",
      { user: admin, body: {} },
    );
    expect(synced.status).toBe(200);
    expect(synced.body.skipped).toBe(false);
    expect(synced.body.created).toBe(2);
    expect(synced.body.credits).toBe(1);
    expect(synced.body.debits).toBe(1);

    const again = await f2Json<{ created: number; reused: number }>("/f2/bank-connections/sync", {
      user: admin,
      body: {},
    });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(0);
    expect(again.body.reused).toBe(2);

    const payments = await client.execute(
      `SELECT allocation_status, candidate_source, fracao_id FROM payments WHERE tenant_id = ? AND external_ref = 'eb:eb-credit-1'`,
      [TENANT],
    );
    expect(payments.rows.length).toBe(1);
    expect(String(payments.rows[0]!.allocation_status)).toBe(ALLOCATION_STATUS.identificado);
    expect(String(payments.rows[0]!.candidate_source)).toBe(CANDIDATE_SOURCES.enableBanking);
    expect(String(payments.rows[0]!.fracao_id)).toBe(fracao.id);

    const movs = await client.execute(
      `SELECT external_ref, amount_cents FROM f2_bank_movements WHERE tenant_id = ? ORDER BY external_ref`,
      [TENANT],
    );
    expect(movs.rows.map((r) => r.external_ref)).toEqual(["eb:eb-credit-1", "eb:eb-debit-1"]);

    const pago = await client.execute(`SELECT pago FROM quotas WHERE id = 'quota-psd2-1'`);
    expect(Number(pago.rows[0]!.pago)).toBe(0);

    const allocs = await client.execute(`SELECT COUNT(*) AS n FROM allocations`);
    expect(Number(allocs.rows[0]!.n)).toBe(0);

    const listed = await f2Json<{
      connections: Array<{
        sessionId?: string;
        authState?: string;
        csvFallback: boolean;
        lastError: string | null;
      }>;
    }>("/f2/bank-connections", { user: admin, method: "GET" });
    expect(listed.status).toBe(200);
    expect(listed.body.connections[0]!.sessionId).toBeUndefined();
    expect(listed.body.connections[0]!.authState).toBeUndefined();
    expect(listed.body.connections[0]!.csvFallback).toBe(false);
    expect(listed.body.connections[0]!.lastError).toBeNull();
  });

  test("reauth real e aviso proactivo coexistem; destination nunca é IBAN", async () => {
    const admin = await seedActor({
      userId: "user-admin-reauth-psd2",
      roleCode: "Admin",
      name: "Admin Reauth PSD2",
      email: "admin-reauth-psd2@test",
    });
    const iban = "PT50001800034978380602065";
    deps.enableBanking = mockEnableBanking({ iban });
    deps.now = () => new Date("2026-09-10T12:00:00.000Z");

    const started = await f2Json<{ authorizationUrl: string }>("/f2/bank-connections/authorize", {
      user: admin,
      body: { accountIban: iban },
    });
    expect(started.status).toBe(201);
    const state = new URL(started.body.authorizationUrl).searchParams.get("state");
    const cb = await f2Request(`/f2/bank/callback?code=ok-code&state=${encodeURIComponent(state!)}`, {
      method: "GET",
    });
    expect(cb.status).toBe(302);

    await f2Request("/f2/bank-connections", {
      user: admin,
      body: {
        consentStatus: BANK_CONSENT_STATUS.authorized,
        consentValidUntil: "2026-09-20T00:00:00.000Z",
      },
    });
    const notice = await f2Json<{ noticed: Array<{ noticed: boolean }> }>(
      "/f2/jobs/reauth-notices",
      { user: admin, body: {} },
    );
    expect(notice.status).toBe(200);
    expect(notice.body.noticed.some((n) => n.noticed)).toBe(true);

    const reauth = await f2Json<{ reauthorize?: boolean; authorizationUrl: string }>(
      "/f2/bank-connections/reauthorize",
      { user: admin, body: {} },
    );
    expect(reauth.status).toBe(200);
    expect(reauth.body.reauthorize).toBe(true);
    const [pending] = await listBankConnections(deps, TENANT);
    expect(pending!.reauthorizationRequired).toBe(1);
    expect(pending!.sessionId).toBe("sess-condo-1");

    const reauthState = new URL(reauth.body.authorizationUrl).searchParams.get("state");
    const afterCb = await f2Request(
      `/f2/bank/callback?code=ok-code-2&state=${encodeURIComponent(reauthState!)}`,
      { method: "GET" },
    );
    expect(afterCb.status).toBe(302);
    const [after] = await listBankConnections(deps, TENANT);
    expect(after!.consentStatus).toBe(BANK_CONSENT_STATUS.authorized);
    expect(after!.reauthorizationRequired).toBe(0);

    const deliveries = await client.execute(
      `SELECT destination, status FROM notification_deliveries WHERE tenant_id = ? AND template = 'bank_reauth_required'`,
      [TENANT],
    );
    expect(deliveries.rows.length).toBe(1);
    expect(String(deliveries.rows[0]!.destination)).toBe("admin-reauth-psd2@test");
    expect(String(deliveries.rows[0]!.destination)).not.toBe(iban);
    expect(String(deliveries.rows[0]!.destination).startsWith("PT")).toBe(false);
  });

  test("falha do provider fica em last_error sanitizado e cai para CSV", async () => {
    const { fracao } = await seedFracaoWithObligations();
    await seedConfirmedOwner("A", "Maria Silva");
    await client.execute({
      sql: `INSERT INTO quotas (id, fracao_id, tipo, mes, ano, valor, pago) VALUES (?, ?, 'condominio', 9, 2026, 50, 0)`,
      args: ["quota-psd2-err", fracao.id],
    });
    const admin = await seedActor({
      userId: "user-admin-psd2-err",
      roleCode: "Admin",
      name: "Admin PSD2 Err",
      email: "admin-psd2-err@test",
    });
    deps.enableBanking = mockEnableBanking({
      failList: new Error(
        "Enable Banking API 401: Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.signature",
      ),
    });
    const started = await f2Json<{ authorizationUrl: string }>("/f2/bank-connections/authorize", {
      user: admin,
      body: { accountIban: "PT50001800034978380602065" },
    });
    expect(started.status).toBe(201);
    const state = new URL(started.body.authorizationUrl).searchParams.get("state");
    await f2Request(`/f2/bank/callback?code=ok-code&state=${encodeURIComponent(state!)}`, {
      method: "GET",
    });

    const failed = await f2Json<{ skipped: boolean; fallback?: string; lastError?: string }>(
      "/f2/bank-connections/sync",
      { user: admin, body: {} },
    );
    expect(failed.status).toBe(200);
    expect(failed.body.skipped).toBe(true);
    expect(failed.body.fallback).toBe("csv");
    expect(String(failed.body.lastError)).not.toContain("eyJ");
    expect(String(failed.body.lastError)).not.toContain("Bearer ");

    const [row] = await listBankConnections(deps, TENANT);
    expect(row!.lastError).toBeTruthy();
    expect(String(row!.lastError)).not.toContain("eyJ");
    expect(row!.reauthorizationRequired).toBe(1);

    const csv = [
      "Conta condomínio",
      "Seq;Data Operação;Data Valor;Mês;Ano;Tipo;Descritivo;Montante;Saldo",
      "csv-psd2;01-09-2026;01-09-2026;9;2026;Entrada;TRF CRED SEPA+ DE MARIA SILVA;50,00;1000,00",
    ].join("\n");
    const ingested = await f2Json<{ created: number }>("/f2/payments/candidates", {
      user: admin,
      body: { csvText: csv },
    });
    expect(ingested.status).toBe(201);
    expect(ingested.body.created).toBe(1);
    const pago = await client.execute(`SELECT pago FROM quotas WHERE id = 'quota-psd2-err'`);
    expect(Number(pago.rows[0]!.pago)).toBe(0);
  });

  test("job de sync é idempotente via outbox e isola tenants", async () => {
    await seedFracaoWithObligations();
    await seedConfirmedOwner("A", "Maria Silva");
    const admin = await seedActor({
      userId: "user-admin-sync-job",
      roleCode: "Admin",
      name: "Admin Sync",
      email: "admin-sync-job@test",
    });
    deps.enableBanking = mockEnableBanking();
    const started = await f2Json<{ authorizationUrl: string }>("/f2/bank-connections/authorize", {
      user: admin,
      body: { accountIban: "PT50001800034978380602065" },
    });
    const state = new URL(started.body.authorizationUrl).searchParams.get("state");
    await f2Request(`/f2/bank/callback?code=ok-code&state=${encodeURIComponent(state!)}`, {
      method: "GET",
    });

    const first = await f2Json<{ created: boolean; job: { id: string } }>("/f2/jobs/bank-sync", {
      user: admin,
      body: {},
    });
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(true);
    const second = await f2Json<{ created: boolean; job: { id: string } }>("/f2/jobs/bank-sync", {
      user: admin,
      body: {},
    });
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.job.id).toBe(first.body.job.id);

    const credits = await client.execute(
      `SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ? AND candidate_source = ?`,
      [TENANT, CANDIDATE_SOURCES.enableBanking],
    );
    expect(Number(credits.rows[0]!.n)).toBe(1);

    await client.execute(`UPDATE outbox_jobs SET status = 'pending', processed_at = NULL WHERE id = ?`, [
      first.body.job.id,
    ]);
    await processOutbox(deps);
    const creditsAgain = await client.execute(
      `SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ? AND candidate_source = ?`,
      [TENANT, CANDIDATE_SOURCES.enableBanking],
    );
    expect(Number(creditsAgain.rows[0]!.n)).toBe(1);

    const otherTenant = "tenant-f2-other";
    const otherDeps = { ...deps, getTenantId: () => otherTenant };
    otherDeps.enableBanking = mockEnableBanking();
    const otherAdmin = await seedActor({
      userId: "user-admin-sync-other",
      roleCode: "Admin",
      name: "Admin Sync Other",
      email: "admin-sync-other@test",
      tenantId: otherTenant,
    });
    const otherStart = await startBankConsent(otherDeps, {
      tenantId: otherTenant,
      accountIban: "PT50001800034978380602065",
      actor: membershipAuditActor(otherAdmin, "a7-tenant-isolation"),
    });
    const otherState = new URL(otherStart.authorizationUrl).searchParams.get("state");
    await completeBankConsent(otherDeps, { code: "ok-other", state: otherState });
    await syncBankConnection(otherDeps, {
      tenantId: otherTenant,
      actor: membershipAuditActor(otherAdmin, "a7-tenant-isolation"),
    });

    const aOnly = await client.execute(
      `SELECT COUNT(*) AS n FROM f2_bank_movements WHERE tenant_id = ?`,
      [TENANT],
    );
    const bOnly = await client.execute(
      `SELECT COUNT(*) AS n FROM f2_bank_movements WHERE tenant_id = ?`,
      [otherTenant],
    );
    expect(Number(aOnly.rows[0]!.n)).toBeGreaterThan(0);
    expect(Number(bOnly.rows[0]!.n)).toBeGreaterThan(0);
    const leaked = await client.execute(
      `SELECT COUNT(*) AS n FROM f2_bank_movements WHERE tenant_id = ? AND id IN (SELECT id FROM f2_bank_movements WHERE tenant_id = ?)`,
      [TENANT, otherTenant],
    );
    expect(Number(leaked.rows[0]!.n)).toBe(0);

    const listedA = await listBankConnections(deps, TENANT);
    const listedB = await listBankConnections(otherDeps, otherTenant);
    expect(listedA.every((r) => r.tenantId === TENANT)).toBe(true);
    expect(listedB.every((r) => r.tenantId === otherTenant)).toBe(true);
  });

  test("HTTP authorize/sync e callback exercitam o caminho feliz", async () => {
    await seedFracaoWithObligations();
    await seedConfirmedOwner("A", "Maria Silva");
    const admin = await seedActor({
      userId: "user-admin-http-psd2",
      roleCode: "Admin",
      name: "Admin HTTP",
      email: "admin-http-psd2@test",
    });
    currentUser = { id: admin.userId!, email: "admin-http-psd2@test" };
    deps.enableBanking = mockEnableBanking();

    const authRes = await app.request("/f2/bank-connections/authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        aspsp: "Mock ASPSP",
        accountIban: "PT50001800034978380602065",
      }),
    });
    expect(authRes.status).toBe(201);
    const authBody = (await authRes.json()) as { authorizationUrl: string };
    const state = new URL(authBody.authorizationUrl).searchParams.get("state");

    const cb = await app.request(`/f2/bank/callback?code=ok-code&state=${encodeURIComponent(state!)}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toContain("/f2/banking?bank_connected=1");

    const syncRes = await app.request("/f2/bank-connections/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(syncRes.status).toBe(200);
    const syncBody = (await syncRes.json()) as { created: number; skipped: boolean };
    expect(syncBody.skipped).toBe(false);
    expect(syncBody.created).toBeGreaterThan(0);
  });

  test("authorize sem IBAN do condomínio → 400", async () => {
    const admin = await seedActor({
      userId: "user-admin-iban-required",
      roleCode: "Admin",
      name: "Admin IBAN",
      email: "admin-iban-required@test",
    });
    currentUser = { id: admin.userId!, email: "admin-iban-required@test" };
    deps.enableBanking = mockEnableBanking();

    const authRes = await app.request("/f2/bank-connections/authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aspsp: "Mock ASPSP" }),
    });
    expect(authRes.status).toBe(400);
    const body = (await authRes.json()) as { message: string };
    expect(body.message).toMatch(/IBAN/);

    await expectDomainCode(
      await f2Request("/f2/bank-connections/authorize", {
        user: admin,
        body: { aspsp: "Mock ASPSP" },
      }),
      400,
      "bank_account_iban_required",
    );
    const rows = await listBankConnections(deps, TENANT);
    expect(rows.length).toBe(0);

    await f2Request("/f2/bank-connections", {
      user: admin,
      body: { accountIban: "PT50001800034978380602065" },
    });
    const reused = await app.request("/f2/bank-connections/authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aspsp: "Mock ASPSP" }),
    });
    expect(reused.status).toBe(201);
  });

  test("callback com IBAN preferido ausente da sessão falha e não persiste sessão", async () => {
    const admin = await seedActor({
      userId: "user-admin-iban-mismatch",
      roleCode: "Admin",
      name: "Admin Mismatch",
      email: "admin-iban-mismatch@test",
    });
    deps.enableBanking = mockEnableBanking({ iban: "PT50000201231234567890154" });
    const started = await f2Json<{ authorizationUrl: string }>("/f2/bank-connections/authorize", {
      user: admin,
      body: { accountIban: "PT50001800034978380602065" },
    });
    expect(started.status).toBe(201);
    const state = new URL(started.body.authorizationUrl).searchParams.get("state");
    const cb = await f2Request(`/f2/bank/callback?code=ok-code&state=${encodeURIComponent(state!)}`, {
      method: "GET",
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/f2/banking?bank_error=account_mismatch");
    const [row] = await listBankConnections(deps, TENANT);
    expect(row!.sessionId).toBeNull();
    expect(row!.accountUid).toBeNull();
    expect(row!.consentStatus).toBe(BANK_CONSENT_STATUS.reauthorizationRequired);
    expect(row!.lastError).toBeTruthy();
    expect(String(row!.lastError)).toMatch(/IBAN/i);
  });

  test("callback sem IBAN preferido falha fechado e não persiste sessão", async () => {
    const admin = await seedActor({
      userId: "user-admin-iban-cleared",
      roleCode: "Admin",
      name: "Admin Cleared",
      email: "admin-iban-cleared@test",
    });
    deps.enableBanking = mockEnableBanking();
    const started = await f2Json<{ authorizationUrl: string }>("/f2/bank-connections/authorize", {
      user: admin,
      body: { accountIban: "PT50001800034978380602065" },
    });
    expect(started.status).toBe(201);
    await f2Request("/f2/bank-connections", { user: admin, body: { accountIban: null } });
    const state = new URL(started.body.authorizationUrl).searchParams.get("state");
    const cb = await f2Request(`/f2/bank/callback?code=ok-code&state=${encodeURIComponent(state!)}`, {
      method: "GET",
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/f2/banking?bank_error=account_iban_required");
    const [row] = await listBankConnections(deps, TENANT);
    expect(row!.sessionId).toBeNull();
    expect(row!.accountUid).toBeNull();
    expect(row!.accountIban).toBeNull();
  });

  test("sync/mapping remove o IBAN do condomínio da contraparte", async () => {
    const condoIban = "PT50003501234567890123451";
    const payerIban = "PT50000201231234567890154";
    let seenOwnIbans: Array<string | null | undefined> | undefined;
    deps.enableBanking = {
      ...mockEnableBanking({ iban: condoIban }),
      listTransactions: async (input) => {
        seenOwnIbans = input.ownIbans;
        const fromRaw = mapEnableBankingTransaction(
          {
            transaction_id: "eb-own-map",
            credit_debit_indicator: "CRDT",
            booking_date: "2026-09-01",
            remittance_information: ["TRF CRED"],
            transaction_amount: { amount: "40.00", currency: "EUR" },
            debtor: { name: "CONTA PROPRIA" },
            debtor_account: { iban: condoIban },
          },
          { ownIbans: input.ownIbans },
        );
        return [
          fromRaw!,
          {
            transactionId: "eb-own-leak",
            amountCents: 30_00,
            bookedAt: new Date("2026-09-03T00:00:00.000Z"),
            description: "TRF CRED",
            debtorName: "PAGADOR",
            counterpartyIban: condoIban,
            creditDebit: "CRDT",
          },
          {
            transactionId: "eb-payer",
            amountCents: 25_00,
            bookedAt: new Date("2026-09-04T00:00:00.000Z"),
            description: "TRF CRED SEPA+ DE MARIA SILVA",
            debtorName: "MARIA SILVA",
            counterpartyIban: payerIban,
            creditDebit: "CRDT",
          },
        ];
      },
    };

    const admin = await seedActor({
      userId: "user-admin-own-iban",
      roleCode: "Admin",
      name: "Admin Own",
      email: "admin-own-iban@test",
    });
    const started = await f2Json<{ authorizationUrl: string }>("/f2/bank-connections/authorize", {
      user: admin,
      body: { accountIban: condoIban },
    });
    expect(started.status).toBe(201);
    const state = new URL(started.body.authorizationUrl).searchParams.get("state");
    await f2Request(`/f2/bank/callback?code=ok-code&state=${encodeURIComponent(state!)}`, {
      method: "GET",
    });

    const synced = await f2Json<{ skipped: boolean; created: number }>(
      "/f2/bank-connections/sync",
      { user: admin, body: {} },
    );
    expect(synced.status).toBe(200);
    expect(synced.body.skipped).toBe(false);
    expect(synced.body.created).toBe(3);
    expect(seenOwnIbans).toContain(condoIban);

    const movs = await client.execute(
      `SELECT external_ref, counterparty_iban FROM f2_bank_movements WHERE tenant_id = ?`,
      [TENANT],
    );
    const byRef = Object.fromEntries(
      movs.rows.map((r) => [String(r.external_ref), r.counterparty_iban]),
    );
    expect(byRef["eb:eb-own-map"]).toBeNull();
    expect(byRef["eb:eb-own-leak"]).toBeNull();
    expect(byRef["eb:eb-payer"]).toBe(payerIban);
  });

  test("callback OAuth usa código estável na URL e detalhe só em last_error", async () => {
    const admin = await seedActor({
      userId: "user-admin-oauth-code",
      roleCode: "Admin",
      name: "Admin OAuth",
      email: "admin-oauth-code@test",
    });
    deps.enableBanking = mockEnableBanking({ iban: "PT50000201231234567890154" });
    const started = await f2Json<{ authorizationUrl: string }>("/f2/bank-connections/authorize", {
      user: admin,
      body: { accountIban: "PT50001800034978380602065" },
    });
    expect(started.status).toBe(201);
    const state = new URL(started.body.authorizationUrl).searchParams.get("state");
    const providerMessage = "access_denied: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig detalhe-sensivel";

    const denied = await app.request(
      `/f2/bank/callback?error=${encodeURIComponent(providerMessage)}&state=${encodeURIComponent(state!)}`,
    );
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toBe("/f2/banking?bank_error=consent_denied");
    expect(denied.headers.get("location")).not.toContain("access_denied");
    expect(denied.headers.get("location")).not.toContain("eyJ");
    expect(denied.headers.get("location")).not.toContain("detalhe-sensivel");
    expect(denied.headers.get("location")).not.toContain(encodeURIComponent(providerMessage));

    const [afterDenied] = await listBankConnections(deps, TENANT);
    expect(afterDenied!.lastError).toBeTruthy();
    expect(String(afterDenied!.lastError)).not.toContain("eyJ");
    expect(afterDenied!.sessionId).toBeNull();

    const mismatch = await app.request(
      `/f2/bank/callback?code=ok-code&state=${encodeURIComponent(state!)}`,
    );
    expect(mismatch.status).toBe(302);
    expect(mismatch.headers.get("location")).toBe("/f2/banking?bank_error=account_mismatch");
    expect(mismatch.headers.get("location")).not.toMatch(/Nenhuma|corresponde|detalhe/i);

    const [afterMismatch] = await listBankConnections(deps, TENANT);
    expect(afterMismatch!.sessionId).toBeNull();
    expect(afterMismatch!.lastError).toBeTruthy();
  });
});

describe("F2 Astra A6 — casos financeiros (handlers reais)", () => {
  test("1. Payment sem Allocation existe, é reportável e não bloqueia fecho / avisos / outro pagamento", async () => {
    const { fracao, obligations: obs } = await seedFracaoWithObligations({
      lines: [{ kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 100_00 }],
    });
    const admin = await seedActor({
      userId: "user-admin-a6-1",
      roleCode: "Admin",
      name: "Admin A6-1",
      email: "admin-a6-1@test",
    });

    const created = await f2Json<{
      id: string;
      allocationStatus: string;
      amountCents: number;
    }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 60_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.allocationStatus).toBe(ALLOCATION_STATUS.naoAlocadoPendente);

    const listed = await f2Json<{
      payments: Array<{
        id: string;
        allocationStatus: string;
        allocationCount: number;
        allocatedCents: number;
      }>;
    }>("/f2/payments", { user: admin });
    expect(listed.status).toBe(200);
    const reported = listed.body.payments.find((p) => p.id === created.body.id);
    expect(reported).toBeDefined();
    expect(reported!.allocationStatus).toBe(ALLOCATION_STATUS.naoAlocadoPendente);
    expect(reported!.allocationCount).toBe(0);
    expect(reported!.allocatedCents).toBe(0);

    await expectDomainCode(
      await f2Request(`/f2/payments/${created.body.id}/receipt`, { user: admin, method: "POST" }),
      409,
      "empty_receipt",
    );

    const opened = await f2Json<{ status: string }>("/f2/periods/open", {
      user: admin,
      body: { year: 2026, month: 9 },
    });
    expect(opened.status).toBe(201);
    const closed = await f2Json<{ period: { status: string }; idempotent: boolean }>(
      "/f2/periods/close",
      { user: admin, body: { year: 2026, month: 9 } },
    );
    expect(closed.status).toBe(200);
    expect(closed.body.period.status).toBe("closed");

    const notice = await f2Json<{ amountCents: number; docType: string }>(
      "/f2/documents/payment-notice",
      {
        user: admin,
        body: {
          fracaoId: fracao.id,
          amountCents: obs.reduce((s, o) => s + o.openAmountCents, 0),
          periodLabel: "2026-09-a6-1",
          obligationIds: obs.map((o) => o.id),
        },
      },
    );
    expect(notice.status).toBe(201);
    expect(notice.body.amountCents).toBe(100_00);

    const other = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 40_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(other.status).toBe(201);
    const otherAlloc = await f2Json<{
      payment: { allocationStatus: string };
      allocations: Array<{ amountCents: number }>;
    }>(`/f2/payments/${other.body.id}/allocate`, { user: admin, method: "POST" });
    expect(otherAlloc.status).toBe(200);
    expect(otherAlloc.body.allocations.reduce((s, a) => s + a.amountCents, 0)).toBe(40_00);

    const stillUnalloc = await client.execute(
      `SELECT COUNT(*) AS n FROM allocations WHERE payment_id = ?`,
      [created.body.id],
    );
    expect(Number(stillUnalloc.rows[0]!.n)).toBe(0);

    const listedAgain = await f2Json<{
      payments: Array<{ id: string; allocationStatus: string }>;
    }>("/f2/payments", { user: admin });
    expect(
      listedAgain.body.payments.find((p) => p.id === created.body.id)!.allocationStatus,
    ).toBe(ALLOCATION_STATUS.naoAlocadoPendente);
  });

  test("2. Allocation parcial — Obligation 100, Payment 60, em aberto 40", async () => {
    const { fracao, obligations: obs } = await seedFracaoWithObligations({
      lines: [{ kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 100_00 }],
    });
    const admin = await seedActor({
      userId: "user-admin-a6-2",
      roleCode: "Admin",
      name: "Admin A6-2",
      email: "admin-a6-2@test",
    });
    expect(obs).toHaveLength(1);
    expect(obs[0]!.amountCents).toBe(100_00);

    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 60_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(created.status).toBe(201);

    const result = await f2Json<{
      payment: { allocationStatus: string; amountCents: number };
      allocations: Array<{ amountCents: number; obligationId: string }>;
    }>(`/f2/payments/${created.body.id}/allocate`, { user: admin, method: "POST" });
    expect(result.status).toBe(200);
    // Payment 60 fica totalmente alocado (o pagamento esgota-se); a Obligation 100 fica com 40 em aberto.
    expect(result.body.payment.allocationStatus).toBe(ALLOCATION_STATUS.totalmenteAlocado);
    expect(result.body.allocations).toHaveLength(1);
    expect(result.body.allocations[0]!.amountCents).toBe(60_00);

    const open = await client.execute(`SELECT open_amount_cents, status FROM obligations WHERE id = ?`, [
      obs[0]!.id,
    ]);
    expect(Number(open.rows[0]!.open_amount_cents)).toBe(40_00);
    expect(String(open.rows[0]!.status)).toBe("open");

    const balance = await reconstructFracaoBalance(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
    });
    expect(balance.source).toBe("ledger");
    expect(balance.originalCents).toBe(100_00);
    expect(balance.allocatedCents).toBe(60_00);
    expect(balance.openCents).toBe(40_00);

    const listed = await f2Json<{
      payments: Array<{ id: string; allocationStatus: string; allocatedCents: number }>;
    }>("/f2/payments", { user: admin });
    const row = listed.body.payments.find((p) => p.id === created.body.id)!;
    expect(row.allocationStatus).toBe(ALLOCATION_STATUS.totalmenteAlocado);
    expect(row.allocatedCents).toBe(60_00);
  });

  test("3. Várias Allocations no mesmo Payment — soma bate e nada se perde", async () => {
    const { fracao, obligations: obs } = await seedFracaoWithObligations({
      lines: [
        { kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 40_00 },
        { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Quota", amountCents: 60_00 },
      ],
    });
    const admin = await seedActor({
      userId: "user-admin-a6-3",
      roleCode: "Admin",
      name: "Admin A6-3",
      email: "admin-a6-3@test",
    });
    expect(obs.map((o) => o.amountCents).sort((a, b) => a - b)).toEqual([40_00, 60_00]);

    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 100_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(created.status).toBe(201);

    const result = await f2Json<{
      payment: { allocationStatus: string };
      allocations: Array<{ amountCents: number; obligationId: string }>;
    }>(`/f2/payments/${created.body.id}/allocate`, { user: admin, method: "POST" });
    expect(result.status).toBe(200);
    expect(result.body.allocations).toHaveLength(2);
    const sum = result.body.allocations.reduce((s, a) => s + a.amountCents, 0);
    expect(sum).toBe(100_00);
    expect(result.body.payment.allocationStatus).toBe(ALLOCATION_STATUS.totalmenteAlocado);

    const byOb = new Map(result.body.allocations.map((a) => [a.obligationId, a.amountCents]));
    for (const ob of obs) {
      expect(byOb.get(ob.id)).toBe(ob.amountCents);
    }

    const open = await client.execute(
      `SELECT COALESCE(SUM(open_amount_cents), 0) AS n FROM obligations WHERE tenant_id = ?`,
      [TENANT],
    );
    expect(Number(open.rows[0]!.n)).toBe(0);

    const ledgerSum = await client.execute(
      `SELECT COALESCE(SUM(amount_cents), 0) AS n FROM ledger_entries
       WHERE tenant_id = ? AND entry_type = 'allocation' AND payment_id = ?`,
      [TENANT, created.body.id],
    );
    expect(Number(ledgerSum.rows[0]!.n)).toBe(100_00);

    const balance = await reconstructFracaoBalance(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
    });
    expect(balance.allocatedCents).toBe(100_00);
    expect(balance.openCents).toBe(0);
  });

  test("4. Reversal é ajuste append-only; Allocation original e hash-chain intactas", async () => {
    const { fracao, obligations: obs } = await seedFracaoWithObligations({
      lines: [{ kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 100_00 }],
    });
    const admin = await seedActor({
      userId: "user-admin-a6-4",
      roleCode: "Admin",
      name: "Admin A6-4",
      email: "admin-a6-4@test",
    });

    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 100_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    const allocated = await f2Json<{
      allocations: Array<{ id: string; amountCents: number; ledgerEntryId: string | null }>;
      payment: { allocationStatus: string };
    }>(`/f2/payments/${created.body.id}/allocate`, { user: admin, method: "POST" });
    expect(allocated.status).toBe(200);
    expect(allocated.body.payment.allocationStatus).toBe(ALLOCATION_STATUS.totalmenteAlocado);
    const original = allocated.body.allocations[0]!;

    const beforeLedger = await client.execute(
      `SELECT id, sequence, payload_json, entry_hash, previous_hash, entry_type
       FROM ledger_entries WHERE id = ?`,
      [original.ledgerEntryId],
    );
    const beforeAlloc = await client.execute(
      `SELECT id, amount_cents, obligation_id, payment_id, reverses_allocation_id
       FROM allocations WHERE id = ?`,
      [original.id],
    );

    const reversed = await f2Json<{
      idempotent: boolean;
      payment: { allocationStatus: string };
      original: { id: string; amountCents: number };
      reversal: { id: string; amountCents: number; reversesAllocationId: string | null };
      ledgerEntry: { id: string; entryType: string; direction: string | null; sequence: number };
    }>(`/f2/payments/${created.body.id}/allocations/${original.id}/reverse`, {
      user: admin,
      body: { reason: "estorno teste A6" },
    });
    expect(reversed.status).toBe(200);
    expect(reversed.body.idempotent).toBe(false);
    expect(reversed.body.original.id).toBe(original.id);
    expect(reversed.body.original.amountCents).toBe(100_00);
    expect(reversed.body.reversal.amountCents).toBe(-100_00);
    expect(reversed.body.reversal.reversesAllocationId).toBe(original.id);
    expect(reversed.body.ledgerEntry.entryType).toBe(LEDGER_ENTRY_TYPES.adjustment);
    expect(reversed.body.ledgerEntry.direction).toBe("debit");
    expect(reversed.body.payment.allocationStatus).toBe(ALLOCATION_STATUS.naoAlocadoPendente);

    const afterLedger = await client.execute(
      `SELECT id, sequence, payload_json, entry_hash, previous_hash, entry_type
       FROM ledger_entries WHERE id = ?`,
      [original.ledgerEntryId],
    );
    expect(afterLedger.rows[0]).toEqual(beforeLedger.rows[0]);

    const afterAlloc = await client.execute(
      `SELECT id, amount_cents, obligation_id, payment_id, reverses_allocation_id
       FROM allocations WHERE id = ?`,
      [original.id],
    );
    expect(afterAlloc.rows[0]).toEqual(beforeAlloc.rows[0]);
    expect(Number(afterAlloc.rows[0]!.amount_cents)).toBe(100_00);

    const adjCount = await client.execute(
      `SELECT COUNT(*) AS n FROM ledger_entries WHERE tenant_id = ? AND entry_type = 'adjustment'`,
      [TENANT],
    );
    expect(Number(adjCount.rows[0]!.n)).toBe(1);

    const chain = await f2Json<{ ok: boolean; entries: number }>("/f2/ledger/validate", {
      user: admin,
      method: "POST",
    });
    expect(chain.status).toBe(200);
    expect(chain.body.ok).toBe(true);
    expect(chain.body.entries).toBeGreaterThanOrEqual(3); // genesis + allocation + adjustment

    const open = await client.execute(`SELECT open_amount_cents, status FROM obligations WHERE id = ?`, [
      obs[0]!.id,
    ]);
    expect(Number(open.rows[0]!.open_amount_cents)).toBe(100_00);
    expect(String(open.rows[0]!.status)).toBe("open");

    const balance = await reconstructFracaoBalance(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
    });
    expect(balance.allocatedCents).toBe(100_00);
    expect(balance.adjustmentCents).toBe(-100_00);
    expect(balance.openCents).toBe(100_00);

    const again = await f2Json<{ idempotent: boolean; reversal: { id: string } }>(
      `/f2/payments/${created.body.id}/allocations/${original.id}/reverse`,
      { user: admin, body: { reason: "retry" } },
    );
    expect(again.status).toBe(200);
    expect(again.body.idempotent).toBe(true);
    expect(again.body.reversal.id).toBe(reversed.body.reversal.id);

    await expectDomainCode(
      await f2Request(
        `/f2/payments/${created.body.id}/allocations/${reversed.body.reversal.id}/reverse`,
        { user: admin, body: {} },
      ),
      409,
      "not_reversible",
    );
  });

  test("5. Mesmo movimento bancário processado duas vezes não duplica Allocation", async () => {
    const { fracao } = await seedFracaoWithObligations({
      lines: [{ kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 100_00 }],
    });
    await seedConfirmedOwner("A", "Maria Silva");
    const admin = await seedActor({
      userId: "user-admin-a6-5",
      roleCode: "Admin",
      name: "Admin A6-5",
      email: "admin-a6-5@test",
    });

    const movement = {
      amountCents: 100_00,
      description: "TRF CRED SEPA+ DE MARIA SILVA",
      externalRef: "a6-dup-mov-1",
      source: CANDIDATE_SOURCES.reconciliation,
    };

    const first = await f2Json<{
      created: number;
      results: Array<{ paymentId: string; created: boolean; allocationStatus: string }>;
    }>("/f2/payments/candidates", { user: admin, body: { movements: [movement] } });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(1);
    const paymentId = first.body.results[0]!.paymentId;
    expect(first.body.results[0]!.allocationStatus).toBe(ALLOCATION_STATUS.identificado);

    const allocated = await f2Json<{
      allocations: unknown[];
      payment: { allocationStatus: string };
    }>(`/f2/payments/${paymentId}/allocate`, { user: admin, method: "POST" });
    expect(allocated.status).toBe(200);
    expect(allocated.body.payment.allocationStatus).toBe(ALLOCATION_STATUS.totalmenteAlocado);
    const allocsAfterFirst = await client.execute(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS t FROM allocations WHERE payment_id = ?`,
      [paymentId],
    );
    expect(Number(allocsAfterFirst.rows[0]!.n)).toBe(1);
    expect(Number(allocsAfterFirst.rows[0]!.t)).toBe(100_00);

    const second = await f2Json<{
      created: number;
      results: Array<{ paymentId: string; created: boolean }>;
    }>("/f2/payments/candidates", { user: admin, body: { movements: [movement] } });
    expect(second.status).toBe(201);
    expect(second.body.created).toBe(0);
    expect(second.body.results[0]!.paymentId).toBe(paymentId);
    expect(second.body.results[0]!.created).toBe(false);

    const againAlloc = await f2Json<{ idempotent: boolean; allocations: unknown[] }>(
      `/f2/payments/${paymentId}/allocate`,
      { user: admin, method: "POST" },
    );
    expect(againAlloc.status).toBe(200);
    expect(againAlloc.body.idempotent).toBe(true);

    const allocsAfterSecond = await client.execute(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS t FROM allocations WHERE payment_id = ?`,
      [paymentId],
    );
    expect(Number(allocsAfterSecond.rows[0]!.n)).toBe(1);
    expect(Number(allocsAfterSecond.rows[0]!.t)).toBe(100_00);

    const paymentsCount = await client.execute(
      `SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ? AND external_ref = ?`,
      [TENANT, "a6-dup-mov-1"],
    );
    expect(Number(paymentsCount.rows[0]!.n)).toBe(1);

    const [payRow] = (
      await client.execute(`SELECT bank_movement_id FROM payments WHERE id = ?`, [paymentId])
    ).rows;
    const dupRegister = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 100_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
        bankMovementId: String(payRow!.bank_movement_id),
      },
    });
    expect(dupRegister.status).toBe(201);
    expect(dupRegister.body.id).toBe(paymentId);
  });

  test("UNIQUE no mesmo bank_movement_id ou external_ref com amountCents diferente falha fechado", async () => {
    const { fracao } = await seedFracaoWithObligations({
      lines: [{ kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 100_00 }],
    });
    const admin = await seedActor({
      userId: "user-admin-a6-unique-amount",
      roleCode: "Admin",
      name: "Admin A6 unique amount",
      email: "admin-a6-unique-amount@test",
    });
    const bankMovementId = crypto.randomUUID();

    const first = await f2Json<{ id: string; amountCents: number }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 100_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
        bankMovementId,
      },
    });
    expect(first.status).toBe(201);
    expect(first.body.amountCents).toBe(100_00);

    const sameAmount = await f2Json<{ id: string; amountCents: number }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 100_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
        bankMovementId,
      },
    });
    expect(sameAmount.status).toBe(201);
    expect(sameAmount.body.id).toBe(first.body.id);
    expect(sameAmount.body.amountCents).toBe(100_00);

    await expectDomainCode(
      await f2Request("/f2/payments", {
        user: admin,
        body: {
          fracaoId: fracao.id,
          amountCents: 60_00,
          paymentMethod: PAYMENT_METHODS.bankTransfer,
          bankMovementId,
        },
      }),
      409,
      "payment_amount_mismatch",
    );

    const byMovement = await client.execute(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS t FROM payments WHERE bank_movement_id = ?`,
      [bankMovementId],
    );
    expect(Number(byMovement.rows[0]!.n)).toBe(1);
    expect(Number(byMovement.rows[0]!.t)).toBe(100_00);

    const externalRef = "a6-unique-amount-ext";
    const extFirst = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 80_00,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
      externalRef,
      actor: { personId: admin.id, userId: admin.userId },
    });
    expect(extFirst.amountCents).toBe(80_00);

    const extSame = await registerPayment(deps, {
      tenantId: TENANT,
      fracaoId: fracao.id,
      amountCents: 80_00,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
      externalRef,
      actor: { personId: admin.id, userId: admin.userId },
    });
    expect(extSame.id).toBe(extFirst.id);

    try {
      await registerPayment(deps, {
        tenantId: TENANT,
        fracaoId: fracao.id,
        amountCents: 40_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
        externalRef,
        actor: { personId: admin.id, userId: admin.userId },
      });
      throw new Error("expected payment_amount_mismatch");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("payment_amount_mismatch");
      expect((err as DomainError).httpStatus).toBe(409);
    }

    const byRef = await client.execute(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS t FROM payments WHERE tenant_id = ? AND external_ref = ?`,
      [TENANT, externalRef],
    );
    expect(Number(byRef.rows[0]!.n)).toBe(1);
    expect(Number(byRef.rows[0]!.t)).toBe(80_00);
  });

  test("6. Recibo antes da Allocation é recusado; depois só mostra Allocations que existem", async () => {
    const { fracao } = await seedFracaoWithObligations({
      lines: [{ kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 100_00 }],
    });
    await seedConfirmedOwner("A", "Joao Costa");
    const admin = await seedActor({
      userId: "user-admin-a6-6",
      roleCode: "Admin",
      name: "Admin A6-6",
      email: "admin-a6-6@test",
    });

    const candidate = await f2Json<{
      results: Array<{ paymentId: string; allocationStatus: string }>;
    }>("/f2/payments/candidates", {
      user: admin,
      body: {
        movements: [
          {
            amountCents: 100_00,
            description: "TRF CRED SEPA+ DE JOAO COSTA",
            externalRef: "a6-receipt-1",
            source: CANDIDATE_SOURCES.identityMatrix,
          },
        ],
      },
    });
    expect(candidate.status).toBe(201);
    const paymentId = candidate.body.results[0]!.paymentId;
    expect(candidate.body.results[0]!.allocationStatus).toBe(ALLOCATION_STATUS.identificado);

    await expectDomainCode(
      await f2Request(`/f2/payments/${paymentId}/receipt`, { user: admin, method: "POST" }),
      409,
      "empty_receipt",
    );
    const docsBefore = await client.execute(
      `SELECT COUNT(*) AS n FROM financial_documents WHERE source_payment_id = ? AND doc_type = 'Receipt'`,
      [paymentId],
    );
    expect(Number(docsBefore.rows[0]!.n)).toBe(0);

    const allocated = await f2Json<{
      allocations: Array<{ id: string; amountCents: number }>;
    }>(`/f2/payments/${paymentId}/allocate`, { user: admin, method: "POST" });
    expect(allocated.status).toBe(200);
    const allocationIds = allocated.body.allocations.map((a) => a.id);
    expect(allocationIds.length).toBe(1);

    const receipt = await f2Json<{
      id: string;
      docType: string;
      amountCents: number;
      generatedFromJson: string;
    }>(`/f2/payments/${paymentId}/receipt`, { user: admin, method: "POST" });
    expect(receipt.status).toBe(201);
    expect(receipt.body.docType).toBe("Receipt");
    expect(receipt.body.amountCents).toBe(100_00);
    const generatedFrom = JSON.parse(receipt.body.generatedFromJson) as {
      paymentId: string;
      allocationIds: string[];
      allocatedCents: number;
    };
    expect(generatedFrom.paymentId).toBe(paymentId);
    expect(generatedFrom.allocationIds).toEqual(allocationIds);
    expect(generatedFrom.allocatedCents).toBe(100_00);
    for (const id of generatedFrom.allocationIds) {
      const row = await client.execute(`SELECT id FROM allocations WHERE id = ?`, [id]);
      expect(row.rows.length).toBe(1);
    }

    const phantom = crypto.randomUUID();
    expect(generatedFrom.allocationIds).not.toContain(phantom);

    const receiptAgain = await f2Json<{ id: string; generatedFromJson: string; amountCents: number }>(
      `/f2/payments/${paymentId}/receipt`,
      { user: admin, method: "POST" },
    );
    expect(receiptAgain.status).toBe(201);
    expect(receiptAgain.body.id).toBe(receipt.body.id);
    expect(receiptAgain.body.generatedFromJson).toBe(receipt.body.generatedFromJson);
    expect(receiptAgain.body.amountCents).toBe(receipt.body.amountCents);
  });

  test("recibo após reversal parcial omite a Allocation revertida e o montante bate", async () => {
    const { fracao } = await seedFracaoWithObligations({
      lines: [
        { kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 40_00 },
        { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Quota", amountCents: 60_00 },
      ],
    });
    const admin = await seedActor({
      userId: "user-admin-a6-receipt-reversal",
      roleCode: "Admin",
      name: "Admin A6 receipt reversal",
      email: "admin-a6-receipt-reversal@test",
    });

    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 100_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(created.status).toBe(201);

    const allocated = await f2Json<{
      allocations: Array<{ id: string; amountCents: number }>;
    }>(`/f2/payments/${created.body.id}/allocate`, { user: admin, method: "POST" });
    expect(allocated.status).toBe(200);
    expect(allocated.body.allocations).toHaveLength(2);
    const reversedAlloc = allocated.body.allocations.find((a) => a.amountCents === 40_00)!;
    const remainingAlloc = allocated.body.allocations.find((a) => a.amountCents === 60_00)!;
    expect(reversedAlloc).toBeDefined();
    expect(remainingAlloc).toBeDefined();

    const reversed = await f2Json<{
      reversal: { id: string; amountCents: number; reversesAllocationId: string | null };
    }>(`/f2/payments/${created.body.id}/allocations/${reversedAlloc.id}/reverse`, {
      user: admin,
      body: { reason: "estorno parcial A6" },
    });
    expect(reversed.status).toBe(200);
    expect(reversed.body.reversal.reversesAllocationId).toBe(reversedAlloc.id);
    expect(reversed.body.reversal.amountCents).toBe(-40_00);

    const receipt = await f2Json<{
      id: string;
      docType: string;
      amountCents: number;
      generatedFromJson: string;
    }>(`/f2/payments/${created.body.id}/receipt`, { user: admin, method: "POST" });
    expect(receipt.status).toBe(201);
    expect(receipt.body.docType).toBe("Receipt");
    const generatedFrom = JSON.parse(receipt.body.generatedFromJson) as {
      paymentId: string;
      allocationIds: string[];
      allocatedCents: number;
    };
    expect(generatedFrom.paymentId).toBe(created.body.id);
    expect(generatedFrom.allocationIds).not.toContain(reversedAlloc.id);
    expect(generatedFrom.allocationIds).not.toContain(reversed.body.reversal.id);
    expect(generatedFrom.allocationIds).toEqual([remainingAlloc.id]);
    expect(receipt.body.amountCents).toBe(60_00);
    expect(generatedFrom.allocatedCents).toBe(60_00);
    expect(receipt.body.amountCents).toBe(remainingAlloc.amountCents);
    expect(receipt.body.amountCents).toBe(
      generatedFrom.allocationIds.reduce((sum, id) => {
        const row = allocated.body.allocations.find((a) => a.id === id);
        return sum + (row?.amountCents ?? 0);
      }, 0),
    );

    const originalStillPositive = await client.execute(
      `SELECT amount_cents FROM allocations WHERE id = ?`,
      [reversedAlloc.id],
    );
    expect(Number(originalStillPositive.rows[0]!.amount_cents)).toBe(40_00);

    const receiptAgain = await f2Json<{ id: string; generatedFromJson: string; amountCents: number }>(
      `/f2/payments/${created.body.id}/receipt`,
      { user: admin, method: "POST" },
    );
    expect(receiptAgain.status).toBe(201);
    expect(receiptAgain.body.id).toBe(receipt.body.id);
    expect(receiptAgain.body.generatedFromJson).toBe(receipt.body.generatedFromJson);
    expect(receiptAgain.body.amountCents).toBe(receipt.body.amountCents);

    const reverseRemaining = await f2Json<{ idempotent: boolean }>(
      `/f2/payments/${created.body.id}/allocations/${remainingAlloc.id}/reverse`,
      { user: admin, body: { reason: "não reescreve recibo já emitido" } },
    );
    expect(reverseRemaining.status).toBe(200);

    const afterFullReversal = await f2Json<{
      id: string;
      generatedFromJson: string;
      amountCents: number;
    }>(`/f2/payments/${created.body.id}/receipt`, { user: admin, method: "POST" });
    expect(afterFullReversal.status).toBe(201);
    expect(afterFullReversal.body.id).toBe(receipt.body.id);
    expect(afterFullReversal.body.generatedFromJson).toBe(receipt.body.generatedFromJson);
    expect(afterFullReversal.body.amountCents).toBe(60_00);
  });

  test("recibo só lê Allocations do tenant do Payment", async () => {
    const { fracao } = await seedFracaoWithObligations({
      lines: [{ kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 100_00 }],
    });
    const admin = await seedActor({
      userId: "user-admin-a6-receipt-tenant",
      roleCode: "Admin",
      name: "Admin A6 receipt tenant",
      email: "admin-a6-receipt-tenant@test",
    });
    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 100_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(created.status).toBe(201);
    const allocated = await f2Json<{ allocations: Array<{ id: string; amountCents: number }> }>(
      `/f2/payments/${created.body.id}/allocate`,
      { user: admin, method: "POST" },
    );
    expect(allocated.status).toBe(200);
    expect(allocated.body.allocations).toHaveLength(1);
    const liveId = allocated.body.allocations[0]!.id;
    const foreignId = crypto.randomUUID();
    await client.execute(
      `INSERT INTO allocations (id, tenant_id, payment_id, obligation_id, amount_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [foreignId, "tenant-foreign-receipt", created.body.id, crypto.randomUUID(), 12_34, Date.now()],
    );

    const receipt = await issueReceiptForPayment(deps, {
      tenantId: TENANT,
      paymentId: created.body.id,
      actor: { personId: admin.id, userId: admin.userId },
    });
    const generatedFrom = JSON.parse(receipt.generatedFromJson) as {
      allocationIds: string[];
      allocatedCents: number;
    };
    expect(generatedFrom.allocationIds).toEqual([liveId]);
    expect(generatedFrom.allocationIds).not.toContain(foreignId);
    expect(receipt.amountCents).toBe(100_00);
    expect(generatedFrom.allocatedCents).toBe(100_00);
  });

  test("UNIQUE Payment sem linha reutilizável falha 409 conflict, não 500", async () => {
    const { fracao } = await seedFracaoWithObligations({
      lines: [{ kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 100_00 }],
    });
    const admin = await seedActor({
      userId: "user-admin-a6-unique-orphan",
      roleCode: "Admin",
      name: "Admin A6 unique orphan",
      email: "admin-a6-unique-orphan@test",
    });
    await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS payments_test_orphan_evidence_uq
      ON payments (tenant_id, evidence_upload_id)
      WHERE evidence_upload_id IS NOT NULL
    `);
    const evidenceUploadId = "orphan-unique-evidence";
    try {
      const first = await registerPayment(deps, {
        tenantId: TENANT,
        fracaoId: fracao.id,
        amountCents: 50_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
        evidenceUploadId,
        actor: { personId: admin.id, userId: admin.userId },
      });
      expect(first.id).toBeTruthy();

      try {
        await registerPayment(deps, {
          tenantId: TENANT,
          fracaoId: fracao.id,
          amountCents: 50_00,
          paymentMethod: PAYMENT_METHODS.bankTransfer,
          evidenceUploadId,
          actor: { personId: admin.id, userId: admin.userId },
        });
        throw new Error("expected conflict");
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe("conflict");
        expect((err as DomainError).httpStatus).toBe(409);
        expect((err as DomainError).code).not.toBe("payment_amount_mismatch");
      }

      await expectDomainCode(
        await f2Request("/f2/payments", {
          user: admin,
          body: {
            fracaoId: fracao.id,
            amountCents: 50_00,
            paymentMethod: PAYMENT_METHODS.bankTransfer,
            evidenceUploadId,
          },
        }),
        409,
        "conflict",
      );
    } finally {
      await client.execute(`DROP INDEX IF EXISTS payments_test_orphan_evidence_uq`);
    }

    const count = await client.execute(
      `SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ? AND evidence_upload_id = ?`,
      [TENANT, evidenceUploadId],
    );
    expect(Number(count.rows[0]!.n)).toBe(1);
  });

  test("Drizzle declara payments_tenant_bank_movement_uq alinhado ao DDL", () => {
    const { indexes } = getTableConfig(schema.payments);
    const uq = indexes.find((i) => i.config.name === "payments_tenant_bank_movement_uq");
    expect(uq).toBeDefined();
    expect(uq!.config.unique).toBe(true);
    const cols = uq!.config.columns.map((c) => ("name" in c ? String(c.name) : String(c)));
    expect(cols).toEqual(["tenant_id", "bank_movement_id"]);
  });

  test("isUniqueConstraintError só UNIQUE/PK, não FK nem CHECK", () => {
    expect(
      isUniqueConstraintError({
        message: "Failed query",
        cause: {
          code: "SQLITE_CONSTRAINT_UNIQUE",
          message: "UNIQUE constraint failed: payments.tenant_id, payments.bank_movement_id",
        },
      }),
    ).toBe(true);
    expect(
      isUniqueConstraintError({
        code: "SQLITE_CONSTRAINT_PRIMARYKEY",
        message: "PRIMARY KEY constraint failed: payments.id",
      }),
    ).toBe(true);
    expect(
      isUniqueConstraintError({
        code: "SQLITE_CONSTRAINT_FOREIGNKEY",
        message: "FOREIGN KEY constraint failed",
      }),
    ).toBe(false);
    expect(
      isUniqueConstraintError({
        code: "SQLITE_CONSTRAINT_CHECK",
        message: "CHECK constraint failed: amount_cents",
      }),
    ).toBe(false);
    expect(
      isUniqueConstraintError({
        code: "constraint",
        message: "constraint failed",
      }),
    ).toBe(false);
    expect(
      isUniqueConstraintError({
        code: "SQLITE_CONSTRAINT",
        message: "FOREIGN KEY constraint failed",
      }),
    ).toBe(false);
  });

  test("listPayments.allocationCount após reversal só conta Allocations em vigor", async () => {
    const { fracao } = await seedFracaoWithObligations({
      lines: [
        { kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 40_00 },
        { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Quota", amountCents: 60_00 },
      ],
    });
    const admin = await seedActor({
      userId: "user-admin-a6-list-live",
      roleCode: "Admin",
      name: "Admin A6 list live",
      email: "admin-a6-list-live@test",
    });
    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 100_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    const allocated = await f2Json<{
      allocations: Array<{ id: string; amountCents: number }>;
    }>(`/f2/payments/${created.body.id}/allocate`, { user: admin, method: "POST" });
    expect(allocated.body.allocations).toHaveLength(2);

    const listedBefore = await f2Json<{
      payments: Array<{ id: string; allocationCount: number; allocatedCents: number }>;
    }>("/f2/payments", { user: admin });
    const before = listedBefore.body.payments.find((p) => p.id === created.body.id)!;
    expect(before.allocationCount).toBe(2);
    expect(before.allocatedCents).toBe(100_00);

    const fcr = allocated.body.allocations.find((a) => a.amountCents === 40_00)!;
    const reversed = await f2Json<{ reversal: { id: string } }>(
      `/f2/payments/${created.body.id}/allocations/${fcr.id}/reverse`,
      { user: admin, body: { reason: "live count" } },
    );
    expect(reversed.status).toBe(200);

    const rawCount = await client.execute(
      `SELECT COUNT(*) AS n FROM allocations WHERE payment_id = ?`,
      [created.body.id],
    );
    expect(Number(rawCount.rows[0]!.n)).toBe(3);

    const listed = await f2Json<{
      payments: Array<{ id: string; allocationCount: number; allocatedCents: number }>;
    }>("/f2/payments", { user: admin });
    const row = listed.body.payments.find((p) => p.id === created.body.id)!;
    expect(row.allocationCount).toBe(1);
    expect(row.allocatedCents).toBe(60_00);

    const viaUseCase = await listPayments(deps, { tenantId: TENANT });
    expect(viaUseCase.find((p) => p.id === created.body.id)!.allocationCount).toBe(1);

    const quota = allocated.body.allocations.find((a) => a.amountCents === 60_00)!;
    await f2Json(`/f2/payments/${created.body.id}/allocations/${quota.id}/reverse`, {
      user: admin,
      body: { reason: "net zero" },
    });
    const afterAll = await f2Json<{
      payments: Array<{ id: string; allocationCount: number; allocatedCents: number }>;
    }>("/f2/payments", { user: admin });
    const netZero = afterAll.body.payments.find((p) => p.id === created.body.id)!;
    expect(netZero.allocationCount).toBe(0);
    expect(netZero.allocatedCents).toBe(0);
    const rawAfter = await client.execute(
      `SELECT COUNT(*) AS n FROM allocations WHERE payment_id = ?`,
      [created.body.id],
    );
    expect(Number(rawAfter.rows[0]!.n)).toBe(4);
  });

  test("allocations_reverses_allocation_uq é único por tenant", async () => {
    const { indexes } = getTableConfig(schema.allocations);
    const uq = indexes.find((i) => i.config.name === "allocations_reverses_allocation_uq");
    expect(uq).toBeDefined();
    expect(uq!.config.unique).toBe(true);
    const cols = uq!.config.columns.map((c) => ("name" in c ? String(c.name) : String(c)));
    expect(cols).toEqual(["tenant_id", "reverses_allocation_id"]);

    const ddl = await client.execute(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'allocations_reverses_allocation_uq'`,
    );
    const sqlText = String(ddl.rows[0]!.sql);
    expect(sqlText).toMatch(/tenant_id/i);
    expect(sqlText).toMatch(/reverses_allocation_id/i);
    expect(sqlText).not.toMatch(/ON allocations \(reverses_allocation_id\)/i);

    const { fracao } = await seedFracaoWithObligations({
      lines: [{ kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 100_00 }],
    });
    const admin = await seedActor({
      userId: "user-admin-a6-rev-uq",
      roleCode: "Admin",
      name: "Admin A6 rev uq",
      email: "admin-a6-rev-uq@test",
    });
    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 100_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    const allocated = await f2Json<{ allocations: Array<{ id: string; obligationId: string }> }>(
      `/f2/payments/${created.body.id}/allocate`,
      { user: admin, method: "POST" },
    );
    const originalId = allocated.body.allocations[0]!.id;
    const obligationId = allocated.body.allocations[0]!.obligationId;
    const reversed = await f2Json<{ reversal: { id: string } }>(
      `/f2/payments/${created.body.id}/allocations/${originalId}/reverse`,
      { user: admin, body: { reason: "primeiro" } },
    );
    expect(reversed.status).toBe(200);

    let secondInsertFailed = false;
    try {
      await client.execute(
        `INSERT INTO allocations (id, tenant_id, payment_id, obligation_id, amount_cents, reverses_allocation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          TENANT,
          created.body.id,
          obligationId,
          -100_00,
          originalId,
          Date.now(),
        ],
      );
    } catch (err) {
      secondInsertFailed = true;
      expect(isUniqueConstraintError(err)).toBe(true);
    }
    expect(secondInsertFailed).toBe(true);

    const sameTenant = await client.execute(
      `SELECT COUNT(*) AS n FROM allocations WHERE tenant_id = ? AND reverses_allocation_id = ?`,
      [TENANT, originalId],
    );
    expect(Number(sameTenant.rows[0]!.n)).toBe(1);
  });
});

describe("F2 HTTP 403 — Owner e Fiscalizacao nas rotas de gestor", () => {
  const managerRoutes: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [
    { path: "/f2/payments", method: "POST", body: { amountCents: 100, paymentMethod: "bank_transfer" } },
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
        const body = (await res.json()) as { message?: string; code?: string };
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
        expect(body).toEqual({ message: "Acesso negado" });
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
      const body = (await res.json()) as { message?: string; code?: string };
      expect({
        path: route.path,
        method: route.method,
        status: res.status,
      }).toEqual({
        path: route.path,
        method: route.method,
        status: 403,
      });
      if (route.method === "GET") {
        expect(body).toEqual({ message: "Acesso negado" });
      } else {
        expect(body.code).toBe(F2_ACTOR_REQUIRED_CODE);
      }
    }
  });
});

describe("F2 Astra A7 — AuditEvent identity (Membership → actor_person_id)", () => {
  test("Membership HTTP persiste actor_person_id, source, request_id; before/after/reason quando o percurso já os tem", async () => {
    const { fracao, obligations: obs } = await seedFracaoWithObligations({
      lines: [{ kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 100_00 }],
    });
    const admin = await seedActor({
      userId: "user-admin-a7",
      roleCode: "Admin",
      name: "Admin A7",
      email: "admin-a7@test",
    });
    const requestId = "req-a7-identity";
    const headers = { "x-request-id": requestId };

    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      headers,
      body: {
        fracaoId: fracao.id,
        amountCents: 100_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(created.status).toBe(201);

    const notice = await f2Json<{ id: string }>("/f2/documents/payment-notice", {
      user: admin,
      headers,
      body: {
        fracaoId: fracao.id,
        amountCents: obs.reduce((s, o) => s + o.openAmountCents, 0),
        periodLabel: "2026-09-a7",
        obligationIds: obs.map((o) => o.id),
      },
    });
    expect(notice.status).toBe(201);

    const allocated = await f2Json<{ allocations: Array<{ id: string }> }>(
      `/f2/payments/${created.body.id}/allocate`,
      { user: admin, method: "POST", headers },
    );
    expect(allocated.status).toBe(200);
    const allocationId = allocated.body.allocations[0]!.id;

    const reversed = await f2Json<{ reversal: { id: string } }>(
      `/f2/payments/${created.body.id}/allocations/${allocationId}/reverse`,
      { user: admin, headers, body: { reason: "correcção A7" } },
    );
    expect(reversed.status).toBe(200);

    const reallocated = await f2Request(`/f2/payments/${created.body.id}/allocate`, {
      user: admin,
      method: "POST",
      headers,
    });
    expect(reallocated.status).toBe(200);

    const receipt = await f2Json<{ id: string }>(`/f2/payments/${created.body.id}/receipt`, {
      user: admin,
      method: "POST",
      headers,
    });
    expect(receipt.status).toBe(201);

    const opened = await f2Json<{ id: string }>("/f2/periods/open", {
      user: admin,
      headers,
      body: { year: 2026, month: 11 },
    });
    expect(opened.status).toBe(201);
    const closed = await f2Json<{ period: { status: string } }>("/f2/periods/close", {
      user: admin,
      headers,
      body: { year: 2026, month: 11 },
    });
    expect(closed.status).toBe(200);
    expect(closed.body.period.status).toBe("closed");

    const audit = createAuditEventRepo(deps.db);
    const events = await audit.listByTenant(TENANT);
    const byType = (type: string) => events.filter((e) => e.type === type);
    const registered = byType("payment.registered");
    expect(registered).toHaveLength(1);
    expect(registered[0]!.actorPersonId).toBe(admin.id);
    expect(registered[0]!.actorUserId).toBe(admin.userId);
    expect(registered[0]!.source).toBe(AUDIT_SOURCE_F2);
    expect(registered[0]!.requestId).toBe(requestId);
    expect(registered[0]!.tenantId).toBe(TENANT);
    expect(registered[0]!.after).toMatchObject({ amountCents: 100_00 });

    const allocatedEv = byType("payment.allocated");
    expect(allocatedEv.length).toBeGreaterThanOrEqual(1);
    expect(allocatedEv.every((e) => e.actorPersonId === admin.id && e.source === AUDIT_SOURCE_F2)).toBe(
      true,
    );
    expect(allocatedEv[0]!.before).toMatchObject({ allocationStatus: expect.any(String) });

    const reversedEv = byType("payment.allocation_reversed");
    expect(reversedEv).toHaveLength(1);
    expect(reversedEv[0]!.actorPersonId).toBe(admin.id);
    expect(reversedEv[0]!.reason).toBe("correcção A7");
    expect(reversedEv[0]!.before).toMatchObject({ allocationId, amountCents: 100_00 });
    expect(reversedEv[0]!.requestId).toBe(requestId);

    const openedEv = byType("accounting_period.opened");
    expect(openedEv).toHaveLength(1);
    expect(openedEv[0]!.actorPersonId).toBe(admin.id);
    expect(openedEv[0]!.source).toBe(AUDIT_SOURCE_F2);
    expect(openedEv[0]!.requestId).toBe(requestId);
    expect(openedEv[0]!.after).toMatchObject({ year: 2026, month: 11, status: "open" });

    const closedEv = byType("accounting_period.closed");
    expect(closedEv).toHaveLength(1);
    expect(closedEv[0]!.actorPersonId).toBe(admin.id);
    expect(closedEv[0]!.before).toMatchObject({ status: "open" });
    expect(closedEv[0]!.source).toBe(AUDIT_SOURCE_F2);

    const receiptEv = events.filter(
      (e) => e.type === "financial_document.issued" && e.entityId === receipt.body.id,
    );
    expect(receiptEv).toHaveLength(1);
    expect(receiptEv[0]!.actorPersonId).toBe(admin.id);
    expect(receiptEv[0]!.requestId).toBe(requestId);
    const noticeEv = events.filter(
      (e) => e.type === "financial_document.issued" && e.entityId === notice.body.id,
    );
    expect(noticeEv).toHaveLength(1);
    expect(noticeEv[0]!.actorPersonId).toBe(admin.id);

    const otherTenant = await audit.listByTenant("tenant-f2-other");
    expect(otherTenant).toHaveLength(0);
  });

  test("verify-cash e deposit-cash gravam actor_person_id da Membership verificadora / gestora", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-a7-cash",
      roleCode: "Admin",
      name: "Admin A7 cash",
      email: "admin-a7-cash@test",
    });
    const fiscal = await seedActor({
      userId: "user-fiscal-a7-cash",
      roleCode: "Fiscalizacao",
      name: "Fiscal A7",
      email: "fiscal-a7-cash@test",
    });
    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 5_000,
        paymentMethod: PAYMENT_METHODS.cash,
        evidenceUploadId: "ev-a7-cash",
      },
    });
    expect(created.status).toBe(201);

    const verified = await f2Json<{ cashStatus: string }>(`/f2/payments/${created.body.id}/verify-cash`, {
      user: fiscal,
      body: { verificationMethod: VERIFICATION_METHOD.secondPerson },
    });
    expect(verified.status).toBe(200);

    const movement = await recordKernelBankMovement(deps, {
      tenantId: TENANT,
      amountCents: 5_000,
    });
    const deposited = await f2Json<{ cashStatus: string }>(
      `/f2/payments/${created.body.id}/deposit-cash`,
      { user: admin, body: { bankMovementId: movement.id } },
    );
    expect(deposited.status).toBe(200);

    const events = await createAuditEventRepo(deps.db).listByTenant(TENANT);
    const verifiedEv = events.find((e) => e.type === "payment.cash_verified");
    expect(verifiedEv?.actorPersonId).toBe(fiscal.id);
    expect(verifiedEv?.before).toMatchObject({ cashStatus: CASH_STATUS.registered });
    expect(verifiedEv?.after).toMatchObject({ cashStatus: CASH_STATUS.verified });
    expect(verifiedEv?.source).toBe(AUDIT_SOURCE_F2);
    const depositedEv = events.find((e) => e.type === "payment.cash_deposited");
    expect(depositedEv?.actorPersonId).toBe(admin.id);
    expect(depositedEv?.before).toMatchObject({ cashStatus: CASH_STATUS.verified });
    expect(depositedEv?.tenantId).toBe(TENANT);
  });

  test("sem Membership activa falha fechado: 403, sem Payment nem AuditEvent financeiro", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const person = await createPersonRepo(deps.db).insert({
      id: crypto.randomUUID(),
      userId: "user-a7-no-membership",
      name: "Sem Membership A7",
      email: "a7-no-membership@test",
      createdAt: new Date(),
    });

    const res = await f2Request("/f2/payments", {
      user: { id: person.userId!, email: person.email ?? undefined },
      body: {
        fracaoId: fracao.id,
        amountCents: 10_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe(F2_ACTOR_REQUIRED_CODE);
    const paymentsCount = await client.execute(
      `SELECT COUNT(*) AS n FROM payments WHERE tenant_id = ?`,
      [TENANT],
    );
    expect(Number(paymentsCount.rows[0]!.n)).toBe(0);
    const audits = await createAuditEventRepo(deps.db).listByTenant(TENANT);
    expect(audits.filter((e) => e.type === "payment.registered")).toHaveLength(0);
  });

  test("use-case sem actor, Membership revogada ou doutro tenant: actor_required e sem side-effect", async () => {
    const { fracao } = await seedFracaoWithObligations();
    const admin = await seedActor({
      userId: "user-admin-a7-usecase",
      roleCode: "Admin",
      name: "Admin A7 use-case",
      email: "admin-a7-usecase@test",
    });

    try {
      await registerPayment(deps, {
        tenantId: TENANT,
        fracaoId: fracao.id,
        amountCents: 10_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      });
      throw new Error("expected actor_required");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("actor_required");
      expect((err as DomainError).httpStatus).toBe(403);
    }

    const membershipRepo = createMembershipRepo(deps.db);
    const [membership] = await membershipRepo.findActiveForPersonTenant(admin.id, TENANT);
    await membershipRepo.revoke({ id: membership!.id, revokedAt: new Date() });
    try {
      await registerPayment(deps, {
        tenantId: TENANT,
        fracaoId: fracao.id,
        amountCents: 10_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
        actor: { personId: admin.id, userId: admin.userId },
      });
      throw new Error("expected actor_required after revoke");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("actor_required");
    }

    const other = await seedActor({
      userId: "user-admin-a7-other",
      roleCode: "Admin",
      name: "Admin A7 other tenant",
      email: "admin-a7-other@test",
    });
    try {
      await registerPayment(deps, {
        tenantId: "tenant-f2-foreign",
        amountCents: 10_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
        actor: { personId: other.id, userId: other.userId },
      });
      throw new Error("expected actor_required for foreign tenant");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("actor_required");
    }

    const paymentsCount = await client.execute(
      `SELECT COUNT(*) AS n FROM payments WHERE tenant_id IN (?, ?)`,
      [TENANT, "tenant-f2-foreign"],
    );
    expect(Number(paymentsCount.rows[0]!.n)).toBe(0);
    const homeAudit = await createAuditEventRepo(deps.db).listByTenant(TENANT);
    const foreignAudit = await createAuditEventRepo(deps.db).listByTenant("tenant-f2-foreign");
    expect(homeAudit.filter((e) => e.type === "payment.registered")).toHaveLength(0);
    expect(foreignAudit).toHaveLength(0);
  });

  test("job de sistema (f2.job) pode gravar AuditEvent com actor_person_id null", async () => {
    const { fracao } = await seedFracaoWithObligations({
      lines: [{ kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 40_00 }],
    });
    const admin = await seedActor({
      userId: "user-admin-a7-job",
      roleCode: "Admin",
      name: "Admin A7 job",
      email: "admin-a7-job@test",
    });
    const created = await f2Json<{ id: string }>("/f2/payments", {
      user: admin,
      body: {
        fracaoId: fracao.id,
        amountCents: 40_00,
        paymentMethod: PAYMENT_METHODS.bankTransfer,
      },
    });
    expect(created.status).toBe(201);
    expect(
      (await f2Request(`/f2/payments/${created.body.id}/allocate`, { user: admin, method: "POST" }))
        .status,
    ).toBe(200);

    const receipt = await issueReceiptForPayment(deps, {
      tenantId: TENANT,
      paymentId: created.body.id,
      actor: systemAuditActor("job-a7-receipt"),
    });
    const events = await createAuditEventRepo(deps.db).listByTenant(TENANT);
    const issued = events.filter(
      (e) => e.type === "financial_document.issued" && e.entityId === receipt.id,
    );
    expect(issued).toHaveLength(1);
    expect(issued[0]!.actorPersonId).toBeNull();
    expect(issued[0]!.source).toBe(AUDIT_SOURCE_F2_JOB);
    expect(issued[0]!.requestId).toBe("job-a7-receipt");
    expect(issued[0]!.tenantId).toBe(TENANT);
  });

  test("upsertBankConnection e reauth notice: Membership activa; sem actor falha fechado antes do audit", async () => {
    deps.now = () => new Date("2026-09-10T12:00:00.000Z");
    const admin = await seedActor({
      userId: "user-admin-a7-bank",
      roleCode: "Admin",
      name: "Admin A7 bank",
      email: "admin-a7-bank@test",
    });
    const requestId = "req-a7-bank";
    const iban = "PT50001800034978380602065";

    try {
      await upsertBankConnection(deps, {
        tenantId: TENANT,
        accountIban: iban,
        consentStatus: BANK_CONSENT_STATUS.authorized,
        consentValidUntil: "2026-09-20T00:00:00.000Z",
      });
      throw new Error("expected actor_required");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("actor_required");
      expect((err as DomainError).httpStatus).toBe(403);
    }
    expect(await listBankConnections(deps, TENANT)).toHaveLength(0);
    expect(
      (await createAuditEventRepo(deps.db).listByTenant(TENANT)).filter(
        (e) => e.type === "bank_connection.upserted",
      ),
    ).toHaveLength(0);

    const created = await f2Json<{ id: string }>("/f2/bank-connections", {
      user: admin,
      headers: { "x-request-id": requestId },
      body: {
        accountIban: iban,
        consentStatus: BANK_CONSENT_STATUS.authorized,
        consentValidUntil: "2026-09-20T00:00:00.000Z",
      },
    });
    expect(created.status).toBe(201);
    const upserted = (await createAuditEventRepo(deps.db).listByTenant(TENANT)).filter(
      (e) => e.type === "bank_connection.upserted",
    );
    expect(upserted).toHaveLength(1);
    expect(upserted[0]!.actorPersonId).toBe(admin.id);
    expect(upserted[0]!.source).toBe(AUDIT_SOURCE_F2);
    expect(upserted[0]!.requestId).toBe(requestId);
    expect(upserted[0]!.tenantId).toBe(TENANT);

    try {
      await sweepBankReauthNotices(deps, { tenantId: TENANT });
      throw new Error("expected actor_required on reauth notice");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("actor_required");
      expect((err as DomainError).httpStatus).toBe(403);
    }
    expect(
      (await createAuditEventRepo(deps.db).listByTenant(TENANT)).filter(
        (e) => e.type === "bank_connection.reauthorization_notice",
      ),
    ).toHaveLength(0);
    const pendingNotices = await client.execute(
      `SELECT COUNT(*) AS n FROM outbox_jobs WHERE tenant_id = ? AND job_type = 'notify.bank_reauth'`,
      [TENANT],
    );
    expect(Number(pendingNotices.rows[0]!.n)).toBe(0);

    const noticed = await f2Json<{ noticed: Array<{ noticed: boolean }> }>(
      "/f2/jobs/reauth-notices",
      { user: admin, headers: { "x-request-id": requestId }, body: {} },
    );
    expect(noticed.status).toBe(200);
    expect(noticed.body.noticed.some((n) => n.noticed)).toBe(true);
    const notices = (await createAuditEventRepo(deps.db).listByTenant(TENANT)).filter(
      (e) => e.type === "bank_connection.reauthorization_notice",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.actorPersonId).toBe(admin.id);
    expect(notices[0]!.source).toBe(AUDIT_SOURCE_F2);
    expect(notices[0]!.requestId).toBe(requestId);
  });

  test("job de sistema em bank connection / reauth grava source f2.job com actor_person_id null", async () => {
    deps.now = () => new Date("2026-09-10T12:00:00.000Z");
    const row = await upsertBankConnection(deps, {
      tenantId: TENANT,
      accountIban: "PT50001800034978380602065",
      consentStatus: BANK_CONSENT_STATUS.authorized,
      consentValidUntil: "2026-09-20T00:00:00.000Z",
      actor: systemAuditActor("job-a7-bank"),
    });
    const upserted = (await createAuditEventRepo(deps.db).listByTenant(TENANT)).filter(
      (e) => e.type === "bank_connection.upserted" && e.entityId === row.id,
    );
    expect(upserted).toHaveLength(1);
    expect(upserted[0]!.actorPersonId).toBeNull();
    expect(upserted[0]!.source).toBe(AUDIT_SOURCE_F2_JOB);
    expect(upserted[0]!.requestId).toBe("job-a7-bank");

    const sweep = await sweepBankReauthNotices(deps, {
      tenantId: TENANT,
      actor: systemAuditActor("job-a7-reauth"),
    });
    expect(sweep.noticed.some((n) => n.noticed)).toBe(true);
    const notices = (await createAuditEventRepo(deps.db).listByTenant(TENANT)).filter(
      (e) => e.type === "bank_connection.reauthorization_notice",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.actorPersonId).toBeNull();
    expect(notices[0]!.source).toBe(AUDIT_SOURCE_F2_JOB);
    expect(notices[0]!.requestId).toBe("job-a7-reauth");
  });

  test("openAccountingPeriod grava AuditEvent; sem actor falha fechado e não insere", async () => {
    try {
      await openAccountingPeriod(deps, { tenantId: TENANT, year: 2026, month: 12 });
      throw new Error("expected actor_required");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("actor_required");
      expect((err as DomainError).httpStatus).toBe(403);
    }
    const periodsCount = await client.execute(
      `SELECT COUNT(*) AS n FROM accounting_periods WHERE tenant_id = ?`,
      [TENANT],
    );
    expect(Number(periodsCount.rows[0]!.n)).toBe(0);
    expect(
      (await createAuditEventRepo(deps.db).listByTenant(TENANT)).filter(
        (e) => e.type === "accounting_period.opened",
      ),
    ).toHaveLength(0);

    const admin = await seedActor({
      userId: "user-admin-a7-period",
      roleCode: "Admin",
      name: "Admin A7 period",
      email: "admin-a7-period@test",
    });
    const requestId = "req-a7-period-open";
    const opened = await f2Json<{ id: string; status: string }>("/f2/periods/open", {
      user: admin,
      headers: { "x-request-id": requestId },
      body: { year: 2026, month: 12 },
    });
    expect(opened.status).toBe(201);
    expect(opened.body.status).toBe("open");
    const again = await f2Json<{ id: string }>("/f2/periods/open", {
      user: admin,
      headers: { "x-request-id": requestId },
      body: { year: 2026, month: 12 },
    });
    expect(again.status).toBe(201);
    const openedEv = (await createAuditEventRepo(deps.db).listByTenant(TENANT)).filter(
      (e) => e.type === "accounting_period.opened",
    );
    expect(openedEv).toHaveLength(1);
    expect(openedEv[0]!.actorPersonId).toBe(admin.id);
    expect(openedEv[0]!.source).toBe(AUDIT_SOURCE_F2);
    expect(openedEv[0]!.requestId).toBe(requestId);
    expect(openedEv[0]!.entityId).toBe(opened.body.id);
    expect(openedEv[0]!.after).toMatchObject({ year: 2026, month: 12, status: "open" });
  });
});
