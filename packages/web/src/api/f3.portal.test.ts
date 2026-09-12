/**
 * F3 portal Essencial: saldo Ledger + FinancialDocument + AuthZ + isolamento.
 * Nunca Quota.pago. Nunca openAmountCents como fonte de verdade.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
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
import { acceptInvitation } from "./application/invitation/accept-invitation";
import { createInvitation } from "./application/invitation/create-invitation";
import { readContactVerificationFromOutbox, resetInvitationSecretHarness } from "./application/invitation/invitation-secrets";
import { resetF3PublicRateLimit } from "./application/invitation/public-rate-limit";
import { confirmContactVerification, requestContactVerification } from "./application/invitation/verify-contact";
import { getActivationPanel } from "./application/invitation/activation-panel";
import {
  allocatePayment,
  issueAccountStatement,
  issuePaymentNotice,
  issueReceiptForPayment,
  registerPayment,
} from "./application/finance/f2-finance";
import { reconstructFracaoBalance } from "./application/finance/f2-ledger-balance";
import { processOutbox } from "./application/jobs/process-outbox";
import { BUDGET_LINE_KINDS, INGEST_DOCUMENT_KINDS } from "./domain/constitution";
import { AUDIT_TYPES } from "./domain/audit";
import { LEDGER_ENTRY_TYPES, PAYMENT_METHODS } from "./domain/finance";
import { applyDomainKernelSchema } from "./infra/kernel-schema";
import { applyF1ConstitutionSchema } from "./infra/f1-schema";
import { applyF2FinanceSchema } from "./infra/f2-schema";
import { OUTBOX_JOB_TYPES } from "./domain/outbox";
import { TICKET_PHOTO_MAX_BYTES } from "./domain/ticket";
import type { KernelDeps } from "./infra/kernel-deps";
import { createMembershipRepo } from "./infra/repos/membership-repo";
import { createPersonRepo } from "./infra/repos/person-repo";
import type { KernelAuthUser, KernelVariables } from "./middleware/membership";
import { createF3Routes } from "./routes/f3";
import { createKernelRoutes } from "./routes/kernel";

const DB_PATH = path.join(import.meta.dir, "..", "..", ".tmp-test-f3-portal.db");
const BLOB_ROOT = path.join(import.meta.dir, "..", "..", ".tmp-test-f3-portal-content");
process.env.CONTENT_BLOB_ROOT = BLOB_ROOT;
const TENANT_A = "tenant-f3-portal-a";
const TENANT_B = "tenant-f3-portal-b";

/** 1×1 PNG — foto mínima para o critério ticket+foto. */
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

let client: ReturnType<typeof createClient>;
let deps: KernelDeps;
let currentUser: KernelAuthUser | null = null;
let tenantIdOverride = TENANT_A;
let app: Hono;

async function seedFracoesWithBudget(tenantId: string, codigos: string[] = ["A", "B"]) {
  const doc = await registerIngestDocument(deps, {
    tenantId,
    kind: INGEST_DOCUMENT_KINDS.regulamento,
    filename: "regulamento.pdf",
  });
  const perm = Math.floor(1000 / codigos.length);
  const remainder = 1000 - perm * (codigos.length - 1);
  const { lines } = await extractDocumentLines(deps, {
    tenantId,
    documentId: doc.id,
    extraction: {
      lines: codigos.map((codigo, i) => ({
        kind: "fracao",
        payload: { codigo, permilagem: i === 0 ? remainder : perm },
        sourceExcerpt: `${codigo} — permilagem`,
      })),
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
    year: 2026,
    title: "Orçamento 2026",
    lines: [
      { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Quota", amountCents: 10_000_00 },
      { kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 1_000_00 },
    ],
  });
  const approved = await approveBudgetAndCreateObligations(deps, {
    tenantId,
    budgetId: budget.budget.id,
  });
  return { fracoes, obligations: approved.obligations };
}

async function seedActor(opts: {
  userId: string;
  roleCode: string;
  name: string;
  email: string;
  tenantId?: string;
  fracaoId?: string | null;
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
    tenantId: opts.tenantId ?? TENANT_A,
    roleCode: opts.roleCode,
    fracaoId: opts.fracaoId ?? null,
    createdAt: new Date(),
  });
  return person;
}

async function acceptOwnerForFracao(opts: {
  tenantId: string;
  fracaoId: string;
  email: string;
  userId: string;
  name: string;
}) {
  const created = await createInvitation(deps, {
    tenantId: opts.tenantId,
    fracaoId: opts.fracaoId,
    contacto: opts.email,
    personName: opts.name,
    actor: { personId: null, userId: null, requestId: "seed-inv" },
  });
  await requestContactVerification(deps, { token: created.token, requestId: "seed-ver" });
  const secrets = await readContactVerificationFromOutbox(deps, created.invitation.id);
  await confirmContactVerification(deps, {
    token: created.token,
    verificationToken: secrets.verificationToken,
    requestId: "seed-conf",
  });
  return acceptInvitation(deps, {
    token: created.token,
    userId: opts.userId,
    name: opts.name,
    email: opts.email,
    requestId: "seed-acc",
  });
}

function buildApp() {
  return new Hono<{ Variables: KernelVariables }>()
    .use(async (c, next) => {
      c.set("user", currentUser);
      await next();
    })
    .route("/f3", createF3Routes(deps))
    .route("/kernel", createKernelRoutes(deps));
}

beforeAll(async () => {
  process.env.CONTENT_BLOB_ROOT = BLOB_ROOT;
  try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(BLOB_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  fs.mkdirSync(BLOB_ROOT, { recursive: true });
  client = createClient({ url: `file:${DB_PATH}` });
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
  resetInvitationSecretHarness();
  resetF3PublicRateLimit();
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
    "invitations",
    "memberships",
    "persons",
    "owner_contact_drafts",
    "constitution_fracoes",
    "extract_lines",
    "ingest_documents",
    "outbox_jobs",
    "notification_deliveries",
    "portal_ticket_photos",
    "portal_tickets",
    "portal_admin_contacts",
    "content_uploads",
    "audit_events",
    "domain_events",
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
  try {
    fs.rmSync(BLOB_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("F3 portal — saldo Ledger + documentos", () => {
  test("condómino com Membership vê saldo reconstruído do Ledger, não Quota.pago nem openAmountCents", async () => {
    const { fracoes, obligations: obs } = await seedFracoesWithBudget(TENANT_A, ["A"]);
    const fracao = fracoes[0]!;
    const original = obs.filter((o) => o.fracaoId === fracao.id).reduce((s, o) => s + o.amountCents, 0);

    await acceptOwnerForFracao({
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      email: "maria@condo.test",
      userId: "user-maria",
      name: "Maria",
    });

    const payment = await registerPayment(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      amountCents: 20_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
    });
    await allocatePayment(deps, { tenantId: TENANT_A, paymentId: payment.id });
    await processOutbox(deps);

    await client.execute(
      `INSERT INTO quotas (id, fracao_id, tipo, mes, ano, valor, pago) VALUES (?, ?, 'condominio', 9, 2026, 1, 1)`,
      ["quota-pago-fake", fracao.id],
    );
    await client.execute(`UPDATE obligations SET open_amount_cents = 1 WHERE tenant_id = ?`, [TENANT_A]);

    const reconstructed = await reconstructFracaoBalance(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
    });
    expect(reconstructed.source).toBe("ledger");
    expect(reconstructed.originalCents).toBe(original);
    expect(reconstructed.allocatedCents).toBe(20_000);
    expect(reconstructed.openCents).toBe(original - 20_000);
    expect(reconstructed.openCents).not.toBe(1);

    currentUser = { id: "user-maria", email: "maria@condo.test" };
    const res = await app.request("/f3/portal/saldo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      fractions: Array<{ openCents: number; allocatedCents: number; originalCents: number; source: string }>;
    };
    expect(body.source).toBe("ledger");
    expect(body.fractions).toHaveLength(1);
    expect(body.fractions[0]!.source).toBe("ledger");
    expect(body.fractions[0]!.openCents).toBe(original - 20_000);
    expect(body.fractions[0]!.allocatedCents).toBe(20_000);
    expect(JSON.stringify(body)).not.toContain("pago");
  });

  test("ajuste a crédito reduz dívida; ajuste a débito aumenta (sinal do Ledger)", async () => {
    const { fracoes, obligations: obs } = await seedFracoesWithBudget(TENANT_A, ["A"]);
    const fracao = fracoes[0]!;
    const quota = obs.find((o) => o.fracaoId === fracao.id && o.kind === "quota_corrente") ?? obs[0]!;
    const original = obs.filter((o) => o.fracaoId === fracao.id).reduce((s, o) => s + o.amountCents, 0);

    async function insertAdjustment(opts: {
      obligationId: string;
      direction: "credit" | "debit";
      amountCents: number;
      sequence: number;
    }) {
      await deps.db.insert(schema.ledgerEntries).values({
        id: crypto.randomUUID(),
        tenantId: TENANT_A,
        sequence: opts.sequence,
        entryType: LEDGER_ENTRY_TYPES.adjustment,
        createdAt: new Date(),
        payloadJson: JSON.stringify({
          amount_cents: opts.amountCents,
          direction: opts.direction,
          obligation_id: opts.obligationId,
        }),
        previousHash: "prev",
        entryHash: `hash-adj-${opts.sequence}-${opts.direction}`,
        algorithmVersion: "sha256-v1",
        obligationId: opts.obligationId,
        amountCents: opts.amountCents,
        direction: opts.direction,
      });
    }

    await insertAdjustment({
      obligationId: quota.id,
      direction: "credit",
      amountCents: 5_000,
      sequence: 1,
    });
    const afterCredit = await reconstructFracaoBalance(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
    });
    expect(afterCredit.adjustmentCents).toBe(5_000);
    expect(afterCredit.openCents).toBe(original - 5_000);

    await insertAdjustment({
      obligationId: quota.id,
      direction: "debit",
      amountCents: 3_000,
      sequence: 2,
    });
    const afterDebit = await reconstructFracaoBalance(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
    });
    expect(afterDebit.adjustmentCents).toBe(2_000);
    expect(afterDebit.openCents).toBe(original - 2_000);
    expect(afterDebit.openCents).not.toBe(original + 2_000);
  });

  test("extrato é idempotente por tenant+fração+período (duplo clique / corrida)", async () => {
    const { fracoes } = await seedFracoesWithBudget(TENANT_A, ["A"]);
    const fracao = fracoes[0]!;
    await acceptOwnerForFracao({
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      email: "extrato@condo.test",
      userId: "user-extrato",
      name: "Extrato",
    });
    currentUser = { id: "user-extrato", email: "extrato@condo.test" };
    deps.now = () => new Date("2026-09-12T10:00:00.000Z");

    const first = await issueAccountStatement(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      periodLabel: "2026-09",
    });
    const second = await issueAccountStatement(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      periodLabel: "2026-09",
    });
    expect(second.id).toBe(first.id);

    const [viaHttpA, viaHttpB] = await Promise.all([
      app.request("/f3/portal/documents/account-statement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fracaoId: fracao.id }),
      }),
      app.request("/f3/portal/documents/account-statement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fracaoId: fracao.id }),
      }),
    ]);
    expect(viaHttpA.status).toBeLessThan(300);
    expect(viaHttpB.status).toBeLessThan(300);
    const bodyA = (await viaHttpA.json()) as { document: { id: string } };
    const bodyB = (await viaHttpB.json()) as { document: { id: string } };
    expect(bodyA.document.id).toBe(first.id);
    expect(bodyB.document.id).toBe(first.id);

    const statements = (await deps.db.select().from(schema.financialDocuments)).filter(
      (d) => d.docType === "AccountStatement",
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]!.periodLabel).toBe("2026-09");
    expect(statements[0]!.fracaoId).toBe(fracao.id);
  });

  test("lista e descarrega FinancialDocument da fração; extrato sob pedido com generated_from", async () => {
    const { fracoes, obligations: obs } = await seedFracoesWithBudget(TENANT_A, ["A"]);
    const fracao = fracoes[0]!;
    const mine = obs.filter((o) => o.fracaoId === fracao.id && o.openAmountCents > 0);
    const notice = await issuePaymentNotice(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      amountCents: mine.reduce((s, o) => s + o.openAmountCents, 0),
      periodLabel: "2026-09",
      obligationIds: mine.map((o) => o.id),
    });
    const payment = await registerPayment(deps, {
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      amountCents: 15_000,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
    });
    await allocatePayment(deps, { tenantId: TENANT_A, paymentId: payment.id });
    const receipt = await issueReceiptForPayment(deps, { tenantId: TENANT_A, paymentId: payment.id });

    await acceptOwnerForFracao({
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      email: "docs@condo.test",
      userId: "user-docs",
      name: "Docs",
    });
    currentUser = { id: "user-docs", email: "docs@condo.test" };

    const list = await app.request("/f3/portal/documents");
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { documents: Array<{ id: string; docType: string; generatedFrom: object }> };
    const types = listed.documents.map((d) => d.docType).sort();
    expect(types).toContain("PaymentNotice");
    expect(types).toContain("Receipt");
    expect(listed.documents.every((d) => d.generatedFrom && Object.keys(d.generatedFrom).length > 0)).toBe(true);

    const dl = await app.request(`/f3/portal/documents/${notice.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toContain("text/html");
    const html = await dl.text();
    expect(html).toContain("Aviso de Débito");
    expect(html).toContain(notice.documentNumber ?? notice.id);
    expect(html).toContain("generated_from");

    const receiptDl = await app.request(`/f3/portal/documents/${receipt.id}/download`);
    expect(receiptDl.status).toBe(200);
    expect(await receiptDl.text()).toContain("Recibo");

    const extrato = await app.request("/f3/portal/documents/account-statement", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fracaoId: fracao.id }),
    });
    expect(extrato.status).toBe(201);
    const issued = (await extrato.json()) as {
      document: { docType: string; generatedFrom: { obligationIds?: string[]; openCents?: number } };
    };
    expect(issued.document.docType).toBe("AccountStatement");
    expect(issued.document.generatedFrom.obligationIds?.length).toBeGreaterThan(0);

    const audits = await deps.db.select().from(schema.auditEvents);
    expect(audits.some((a) => a.type === AUDIT_TYPES.financialDocumentSeen)).toBe(true);
    expect(audits.some((a) => a.type === "financial_document.issued")).toBe(true);

    const panel = await getActivationPanel(deps, { tenantId: TENANT_A });
    expect(panel.portalOpen).toBe(0);
    await app.request("/f3/portal/saldo");
    await app.request("/f3/portal/saldo");
    const after = await getActivationPanel(deps, { tenantId: TENANT_A });
    expect(after.portalOpen).toBe(1);
    expect(after.documentsSeen).toBe(1);
    const opened = (await deps.db.select().from(schema.auditEvents)).filter(
      (a) => a.type === AUDIT_TYPES.portalOpened,
    );
    expect(opened).toHaveLength(1);
  });

  test("isolamento multi-tenant e AuthZ fail-closed", async () => {
    const seededA = await seedFracoesWithBudget(TENANT_A, ["A", "B"]);
    const fracaoA = seededA.fracoes.find((f) => f.codigo === "A")!;
    const fracaoB = seededA.fracoes.find((f) => f.codigo === "B")!;
    const seededB = await seedFracoesWithBudget(TENANT_B, ["A"]);
    const fracaoOtherTenant = seededB.fracoes[0]!;

    await acceptOwnerForFracao({
      tenantId: TENANT_A,
      fracaoId: fracaoA.id,
      email: "owner-a@condo.test",
      userId: "user-owner-a",
      name: "Owner A",
    });
    await acceptOwnerForFracao({
      tenantId: TENANT_A,
      fracaoId: fracaoB.id,
      email: "owner-b@condo.test",
      userId: "user-owner-b",
      name: "Owner B",
    });
    await acceptOwnerForFracao({
      tenantId: TENANT_B,
      fracaoId: fracaoOtherTenant.id,
      email: "owner-x@other.test",
      userId: "user-owner-x",
      name: "Owner X",
    });
    await seedActor({
      userId: "user-admin",
      roleCode: "Admin",
      name: "Admin",
      email: "admin@condo.test",
      tenantId: TENANT_A,
    });

    const obsB = seededA.obligations.filter((o) => o.fracaoId === fracaoB.id && o.openAmountCents > 0);
    const noticeB = await issuePaymentNotice(deps, {
      tenantId: TENANT_A,
      fracaoId: fracaoB.id,
      amountCents: obsB.reduce((s, o) => s + o.openAmountCents, 0),
      periodLabel: "2026-09",
      obligationIds: obsB.map((o) => o.id),
    });
    const obsX = seededB.obligations.filter((o) => o.fracaoId === fracaoOtherTenant.id && o.openAmountCents > 0);
    const noticeX = await issuePaymentNotice(deps, {
      tenantId: TENANT_B,
      fracaoId: fracaoOtherTenant.id,
      amountCents: obsX.reduce((s, o) => s + o.openAmountCents, 0),
      periodLabel: "2026-09",
      obligationIds: obsX.map((o) => o.id),
    });

    currentUser = { id: "user-owner-a", email: "owner-a@condo.test" };
    tenantIdOverride = TENANT_A;
    const saldoA = await app.request("/f3/portal/saldo");
    expect(saldoA.status).toBe(200);
    const saldoBody = (await saldoA.json()) as { fractions: Array<{ fracaoId: string }> };
    expect(saldoBody.fractions.map((f) => f.fracaoId)).toEqual([fracaoA.id]);

    const docsA = await app.request("/f3/portal/documents");
    const docsABody = (await docsA.json()) as { documents: Array<{ id: string }> };
    expect(docsABody.documents.some((d) => d.id === noticeB.id)).toBe(false);
    expect(docsABody.documents.some((d) => d.id === noticeX.id)).toBe(false);

    const stealB = await app.request(`/f3/portal/documents/${noticeB.id}/download`);
    expect(stealB.status).toBe(403);
    const stealX = await app.request(`/f3/portal/documents/${noticeX.id}/download`);
    expect(stealX.status).toBe(404);

    tenantIdOverride = TENANT_B;
    const crossTenant = await app.request("/f3/portal/saldo");
    expect(crossTenant.status).toBe(403);

    tenantIdOverride = TENANT_A;
    currentUser = { id: "user-admin", email: "admin@condo.test" };
    const adminPortal = await app.request("/f3/portal/saldo");
    expect(adminPortal.status).toBe(403);

    currentUser = null;
    const anon = await app.request("/f3/portal/saldo");
    expect(anon.status).toBe(401);

    const ownerB = await createPersonRepo(deps.db).findByUserId("user-owner-b");
    const membershipsB = await createMembershipRepo(deps.db).findActiveForPersonTenant(ownerB!.id, TENANT_A);
    await createMembershipRepo(deps.db).revoke({
      id: membershipsB[0]!.id,
      revokedAt: new Date(),
    });
    currentUser = { id: "user-owner-b", email: "owner-b@condo.test" };
    const revoked = await app.request("/f3/portal/saldo");
    expect(revoked.status).toBe(403);

    const panelA = await getActivationPanel(deps, { tenantId: TENANT_A });
    const panelB = await getActivationPanel(deps, { tenantId: TENANT_B });
    expect(panelA.portalOpen).toBe(1);
    expect(panelB.portalOpen).toBe(0);
  });
});

describe("F3 portal — tickets+foto + contactar admin", () => {
  test("condómino cria ticket com foto (blob F1), lista só a sua fração e notifica admin via outbox", async () => {
    const seeded = await seedFracoesWithBudget(TENANT_A, ["A", "B"]);
    const fracaoA = seeded.fracoes.find((f) => f.codigo === "A")!;
    const fracaoB = seeded.fracoes.find((f) => f.codigo === "B")!;
    await acceptOwnerForFracao({
      tenantId: TENANT_A,
      fracaoId: fracaoA.id,
      email: "maria-ticket@condo.test",
      userId: "user-maria-ticket",
      name: "Maria Ticket",
    });
    await seedActor({
      userId: "user-admin-ticket",
      roleCode: "Admin",
      name: "Admin Ticket",
      email: "admin-ticket@condo.test",
      tenantId: TENANT_A,
    });

    currentUser = { id: "user-maria-ticket", email: "maria-ticket@condo.test" };
    const form = new FormData();
    form.set("titulo", "Infiltração na cave");
    form.set("descricao", "Há água a entrar junto ao elevador.");
    form.set("fracaoId", fracaoA.id);
    form.set("categoria", "manutencao");
    form.set("file", new File([TINY_PNG], "fuga.png", { type: "image/png" }));

    const created = await app.request("/f3/portal/tickets", { method: "POST", body: form });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      ticket: {
        id: string;
        fracaoId: string;
        titulo: string;
        photoCount: number;
        photos: Array<{ id: string; contentHash: string; mimeType: string }>;
      };
    };
    expect(createdBody.ticket.fracaoId).toBe(fracaoA.id);
    expect(createdBody.ticket.titulo).toBe("Infiltração na cave");
    expect(createdBody.ticket.photoCount).toBe(1);
    expect(createdBody.ticket.photos[0]!.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(createdBody.ticket.photos[0]!.mimeType).toContain("image/");

    const listed = await app.request("/f3/portal/tickets");
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { tickets: Array<{ id: string; fracaoId: string }> };
    expect(listBody.tickets).toHaveLength(1);
    expect(listBody.tickets[0]!.id).toBe(createdBody.ticket.id);

    const photo = await app.request(
      `/f3/portal/tickets/${createdBody.ticket.id}/photos/${createdBody.ticket.photos[0]!.id}`,
    );
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toContain("image/");
    const bytes = Buffer.from(await photo.arrayBuffer());
    expect(bytes.equals(TINY_PNG)).toBe(true);

    const audits = await deps.db.select().from(schema.auditEvents);
    expect(audits.some((a) => a.type === AUDIT_TYPES.ticketCreated)).toBe(true);
    const jobs = await deps.db.select().from(schema.outboxJobs);
    const ticketJobs = jobs.filter((j) => j.jobType === OUTBOX_JOB_TYPES.notifyTicketCreated);
    expect(ticketJobs).toHaveLength(1);
    expect(ticketJobs[0]!.status).toBe("completed");
    const deliveries = await deps.db.select().from(schema.notificationDeliveries);
    expect(deliveries.some((d) => d.template === "ticket_created" && d.destination === "admin-ticket@condo.test")).toBe(
      true,
    );

    await acceptOwnerForFracao({
      tenantId: TENANT_A,
      fracaoId: fracaoB.id,
      email: "owner-b-ticket@condo.test",
      userId: "user-owner-b-ticket",
      name: "Owner B Ticket",
    });
    currentUser = { id: "user-owner-b-ticket", email: "owner-b-ticket@condo.test" };
    const stealList = await app.request("/f3/portal/tickets");
    const stealListBody = (await stealList.json()) as { tickets: Array<{ id: string }> };
    expect(stealListBody.tickets.some((t) => t.id === createdBody.ticket.id)).toBe(false);
    const stealGet = await app.request(`/f3/portal/tickets/${createdBody.ticket.id}`);
    expect(stealGet.status).toBe(403);
    const stealPhoto = await app.request(
      `/f3/portal/tickets/${createdBody.ticket.id}/photos/${createdBody.ticket.photos[0]!.id}`,
    );
    expect(stealPhoto.status).toBe(403);

    currentUser = { id: "user-maria-ticket", email: "maria-ticket@condo.test" };
    const pdf = new FormData();
    pdf.set("titulo", "Documento");
    pdf.set("descricao", "Não é foto");
    pdf.set("file", new File(["%PDF-1.4"], "nota.pdf", { type: "application/pdf" }));
    const badType = await app.request("/f3/portal/tickets", { method: "POST", body: pdf });
    expect(badType.status).toBe(400);

    const huge = new FormData();
    huge.set("titulo", "Foto enorme");
    huge.set("descricao", "Não cabe");
    huge.set(
      "file",
      new File([new Uint8Array(TICKET_PHOTO_MAX_BYTES + 1)], "grande.jpg", { type: "image/jpeg" }),
    );
    const tooBig = await app.request("/f3/portal/tickets", { method: "POST", body: huge });
    expect(tooBig.status).toBe(400);
  });

  test("contactar admin: AuditEvent + outbox idempotente + estado observável", async () => {
    const { fracoes } = await seedFracoesWithBudget(TENANT_A, ["A"]);
    const fracao = fracoes[0]!;
    await acceptOwnerForFracao({
      tenantId: TENANT_A,
      fracaoId: fracao.id,
      email: "contacto@condo.test",
      userId: "user-contacto",
      name: "Contacto",
    });
    await seedActor({
      userId: "user-admin-mail",
      roleCode: "Admin",
      name: "Admin Mail",
      email: "admin-mail@condo.test",
      tenantId: TENANT_A,
    });
    currentUser = { id: "user-contacto", email: "contacto@condo.test" };

    const first = await app.request("/f3/portal/contact-admin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: "Dúvida de quota",
        body: "O extrato não bate com o que paguei.",
        fracaoId: fracao.id,
      }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { contact: { id: string; status: string; subject: string } };
    expect(firstBody.contact.subject).toBe("Dúvida de quota");
    expect(["attempted", "queued"]).toContain(firstBody.contact.status);

    const listed = await app.request("/f3/portal/contact-admin");
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { contacts: Array<{ id: string; status: string }> };
    expect(listBody.contacts).toHaveLength(1);
    expect(listBody.contacts[0]!.status).toBe("attempted");

    const jobs = (await deps.db.select().from(schema.outboxJobs)).filter(
      (j) => j.jobType === OUTBOX_JOB_TYPES.notifyAdminContact,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.idempotencyKey).toBe(`notify:admin_contact:${firstBody.contact.id}:created`);
    expect(jobs[0]!.status).toBe("completed");

    await processOutbox(deps);
    const jobsAfter = (await deps.db.select().from(schema.outboxJobs)).filter(
      (j) => j.jobType === OUTBOX_JOB_TYPES.notifyAdminContact,
    );
    expect(jobsAfter).toHaveLength(1);
    const deliveries = (await deps.db.select().from(schema.notificationDeliveries)).filter(
      (d) => d.template === "admin_contact",
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.destination).toBe("admin-mail@condo.test");
    expect(deliveries[0]!.status).toBe("attempted");

    const audits = await deps.db.select().from(schema.auditEvents);
    expect(audits.some((a) => a.type === AUDIT_TYPES.adminContactCreated)).toBe(true);
    expect(audits.some((a) => a.type === "notification.email.attempted")).toBe(true);

    currentUser = null;
    const anon = await app.request("/f3/portal/contact-admin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "x", body: "y" }),
    });
    expect(anon.status).toBe(401);
  });

  test("tickets e contacto fail-closed: sem tenant, outra fração, outro tenant, Membership revogada", async () => {
    const seededA = await seedFracoesWithBudget(TENANT_A, ["A", "B"]);
    const fracaoA = seededA.fracoes.find((f) => f.codigo === "A")!;
    const fracaoB = seededA.fracoes.find((f) => f.codigo === "B")!;
    const seededB = await seedFracoesWithBudget(TENANT_B, ["A"]);
    const fracaoX = seededB.fracoes[0]!;

    await acceptOwnerForFracao({
      tenantId: TENANT_A,
      fracaoId: fracaoA.id,
      email: "iso-a@condo.test",
      userId: "user-iso-a",
      name: "Iso A",
    });
    await acceptOwnerForFracao({
      tenantId: TENANT_A,
      fracaoId: fracaoB.id,
      email: "iso-b@condo.test",
      userId: "user-iso-b",
      name: "Iso B",
    });
    await acceptOwnerForFracao({
      tenantId: TENANT_B,
      fracaoId: fracaoX.id,
      email: "iso-x@other.test",
      userId: "user-iso-x",
      name: "Iso X",
    });
    await seedActor({
      userId: "user-admin-iso",
      roleCode: "Admin",
      name: "Admin Iso",
      email: "admin-iso@condo.test",
      tenantId: TENANT_A,
    });

    currentUser = { id: "user-iso-a", email: "iso-a@condo.test" };
    tenantIdOverride = TENANT_A;
    const created = await app.request("/f3/portal/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        titulo: "Pedido A",
        descricao: "Só da fração A",
        fracaoId: fracaoA.id,
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { ticket: { id: string } };

    const stealFracao = await app.request("/f3/portal/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        titulo: "Não é minha",
        descricao: "Fração B",
        fracaoId: fracaoB.id,
      }),
    });
    expect(stealFracao.status).toBe(403);

    const stealContact = await app.request("/f3/portal/contact-admin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: "Não",
        body: "Fração B",
        fracaoId: fracaoB.id,
      }),
    });
    expect(stealContact.status).toBe(403);

    tenantIdOverride = TENANT_B;
    const crossTenant = await app.request(`/f3/portal/tickets/${createdBody.ticket.id}`);
    expect(crossTenant.status).toBe(403);

    tenantIdOverride = TENANT_A;
    currentUser = { id: "user-admin-iso", email: "admin-iso@condo.test" };
    const adminPortal = await app.request("/f3/portal/tickets");
    expect(adminPortal.status).toBe(403);

    currentUser = null;
    const anon = await app.request("/f3/portal/tickets");
    expect(anon.status).toBe(401);

    const ownerB = await createPersonRepo(deps.db).findByUserId("user-iso-b");
    const membershipsB = await createMembershipRepo(deps.db).findActiveForPersonTenant(ownerB!.id, TENANT_A);
    await createMembershipRepo(deps.db).revoke({
      id: membershipsB[0]!.id,
      revokedAt: new Date(),
    });
    currentUser = { id: "user-iso-b", email: "iso-b@condo.test" };
    const revoked = await app.request("/f3/portal/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ titulo: "Revogado", descricao: "Não" }),
    });
    expect(revoked.status).toBe(403);
  });
});
