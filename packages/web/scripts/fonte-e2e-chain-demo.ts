/**
 * Demo ponta-a-ponta Fonte (1 fracção): F1 → Membership → Obligation → Payment → Allocation → Ledger → Portal.
 * Ambiente LOCAL isolado — não escreve em local.db nem em dados de piloto.
 *
 * Uso: cd packages/web && bun run scripts/fonte-e2e-chain-demo.ts
 */
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import * as schema from "../src/api/database/schema.ts";
import {
  approveBudgetAndCreateObligations,
  confirmFracaoLines,
  createAnnualBudget,
  listConstitutionFracoes,
} from "../src/api/application/constitution/f1-constitution.ts";
import {
  extractDocumentFromStoredContent,
  uploadIngestDocumentFile,
} from "../src/api/application/constitution/upload-and-extract.ts";
import { createInvitation } from "../src/api/application/invitation/create-invitation.ts";
import { acceptInvitation } from "../src/api/application/invitation/accept-invitation.ts";
import {
  readContactVerificationFromOutbox,
  resetInvitationSecretHarness,
} from "../src/api/application/invitation/invitation-secrets.ts";
import {
  confirmContactVerification,
  requestContactVerification,
} from "../src/api/application/invitation/verify-contact.ts";
import { BUDGET_LINE_KINDS, INGEST_DOCUMENT_KINDS } from "../src/api/domain/constitution.ts";
import { PAYMENT_METHODS } from "../src/api/domain/finance.ts";
import { applyDomainKernelSchema } from "../src/api/infra/kernel-schema.ts";
import { applyF1ConstitutionSchema } from "../src/api/infra/f1-schema.ts";
import { applyF2FinanceSchema } from "../src/api/infra/f2-schema.ts";
import type { KernelDeps } from "../src/api/infra/kernel-deps.ts";
import { createMembershipRepo } from "../src/api/infra/repos/membership-repo.ts";
import { createPersonRepo } from "../src/api/infra/repos/person-repo.ts";
import type { KernelAuthUser, KernelVariables } from "../src/api/middleware/membership.ts";
import { createF1Routes } from "../src/api/routes/f1.ts";
import { createF2Routes } from "../src/api/routes/f2.ts";
import { createF3Routes } from "../src/api/routes/f3.ts";
import { createKernelRoutes } from "../src/api/routes/kernel.ts";

const WEB_ROOT = path.join(import.meta.dir, "..");
const DB_PATH = path.join(WEB_ROOT, ".tmp-fonte-e2e-chain.db");
const BLOB_ROOT = path.join(WEB_ROOT, ".tmp-fonte-e2e-chain-content");
const FIXTURE = path.join(
  WEB_ROOT,
  "src/api/application/constitution/extractors/fixtures/anexo-regulamento-fonte.pdf",
);
const TENANT = "tenant-fonte-e2e-chain";
const TARGET_CODIGO = "E"; // Lugar Garagem 27 — 3,00‰ → 3 após round; simples

process.env.CONTENT_BLOB_ROOT = BLOB_ROOT;

const log: Array<Record<string, unknown>> = [];
function step(name: string, data: Record<string, unknown>) {
  log.push({ step: name, ...data });
  console.log(JSON.stringify({ step: name, ...data }, null, 2));
}

try {
  fs.rmSync(DB_PATH, { force: true });
  fs.rmSync(BLOB_ROOT, { recursive: true, force: true });
} catch {
  /* ignore */
}
fs.mkdirSync(BLOB_ROOT, { recursive: true });

const client = createClient({ url: `file:${DB_PATH}` });
await applyDomainKernelSchema(client);
await applyF1ConstitutionSchema(client);
await applyF2FinanceSchema(client);
const db = drizzle(client, { schema });
const deps: KernelDeps = { db, getTenantId: () => TENANT };

let currentUser: KernelAuthUser | null = null;
const app = new Hono<{ Variables: KernelVariables }>()
  .use(async (c, next) => {
    c.set("user", currentUser);
    await next();
  })
  .route("/f1", createF1Routes(deps))
  .route("/f2", createF2Routes(deps))
  .route("/f3", createF3Routes(deps))
  .route("/kernel", createKernelRoutes(deps));

async function req(pathName: string, init?: { method?: string; body?: unknown }) {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(pathName, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
}

// --- Admin ---
resetInvitationSecretHarness();
const personRepo = createPersonRepo(db);
const membershipRepo = createMembershipRepo(db);
const admin = await personRepo.insert({
  id: crypto.randomUUID(),
  userId: "user-fonte-e2e-admin",
  name: "Admin Fonte E2E",
  email: "admin-fonte-e2e@example.test",
  createdAt: new Date(),
});
await membershipRepo.insert({
  id: crypto.randomUUID(),
  personId: admin.id,
  tenantId: TENANT,
  roleCode: "Admin",
  createdAt: new Date(),
});
currentUser = { id: admin.userId!, email: admin.email ?? undefined };

// ========== 1. F1 Fonte PDF → confirm ==========
const bytes = fs.readFileSync(FIXTURE);
const uploaded = await uploadIngestDocumentFile(deps, {
  tenantId: TENANT,
  kind: INGEST_DOCUMENT_KINDS.regulamento,
  filename: "anexo-regulamento-fonte.pdf",
  bytes,
  actor: { personId: admin.id, userId: admin.userId },
});
step("1a_upload_extract", {
  endpoint: "uploadIngestDocumentFile + extractDocumentFromStoredContent (F1)",
  documentId: uploaded.document.id,
  ok: true,
});

const extracted = await extractDocumentFromStoredContent(deps, {
  tenantId: TENANT,
  documentId: uploaded.document.id,
  actor: { personId: admin.id, userId: admin.userId },
});
step("1b_extract", {
  endpoint: "POST /f1/documents/:id/extract-from-file (via use-case)",
  lines: extracted.lines.length,
  documentStatus: extracted.document.status,
});

const confirmations = extracted.lines.map((line) => ({ lineId: line.id }));
const confirmed = await confirmFracaoLines(deps, {
  tenantId: TENANT,
  documentId: uploaded.document.id,
  confirmations,
  actor: { personId: admin.id, userId: admin.userId },
});
const fracoes = await listConstitutionFracoes(deps, { tenantId: TENANT });
const target = fracoes.find((f) => f.codigo === TARGET_CODIGO)!;
const fracaoM = fracoes.find((f) => f.codigo === "M");
step("1c_confirm_fracoes", {
  endpoint: "POST /f1/documents/:id/confirm-fracoes",
  N: fracoes.length,
  sum: confirmed.permilagemCentesimasSum,
  target: {
    codigo: target.codigo,
    id: target.id,
    permilagem: target.permilagem,
    permilagemCentesimas: target.permilagemCentesimas,
  },
  M: {
    permilagemCentesimas: fracaoM?.permilagemCentesimas ?? null,
    permilagem: fracaoM?.permilagem ?? null,
  },
  humanAdjustment: null,
  ok:
    confirmed.permilagemCentesimasSum === 100000 &&
    fracoes.length === 33 &&
    fracaoM?.permilagemCentesimas === 3950 &&
    fracaoM?.permilagem == null,
});

// ========== 2. Membership via Invitation ==========
const inv = await createInvitation(deps, {
  tenantId: TENANT,
  fracaoId: target.id,
  contacto: "owner-e@fonte-e2e.test",
  personName: "Owner Fracao E",
  actor: { personId: admin.id, userId: admin.userId, requestId: "e2e-inv" },
});
step("2a_create_invitation", {
  endpoint: "POST /f3/invitations",
  invitationId: inv.invitation.id,
  fracaoId: target.id,
  tokenPresent: Boolean(inv.token),
});

await requestContactVerification(deps, { token: inv.token, requestId: "e2e-ver" });
const secrets = await readContactVerificationFromOutbox(deps, inv.invitation.id);
await confirmContactVerification(deps, {
  token: inv.token,
  verificationToken: secrets.verificationToken,
  requestId: "e2e-conf",
});
const accepted = await acceptInvitation(deps, {
  token: inv.token,
  userId: "user-owner-e-fonte",
  name: "Owner Fracao E",
  email: "owner-e@fonte-e2e.test",
  requestId: "e2e-acc",
});
const ownerMembership = (await membershipRepo.findActiveForPersonTenant(
  accepted.personId,
  TENANT,
)).find((m) => m.fracaoId === target.id);
step("2b_accept_invitation", {
  endpoint: "POST /f3/public/invitations/:token/accept (+ verify)",
  personId: accepted.personId,
  membershipId: accepted.membershipId,
  roleCode: ownerMembership?.roleCode ?? null,
  fracaoId: ownerMembership?.fracaoId ?? null,
  ok: Boolean(ownerMembership) && ownerMembership!.fracaoId === target.id,
});

// ========== 3. Budget + approve → Obligations ==========
const budget = await createAnnualBudget(deps, {
  tenantId: TENANT,
  year: 2026,
  title: "Orçamento Fonte E2E 2026",
  lines: [
    { kind: BUDGET_LINE_KINDS.quotaCorrente, label: "Quota", amountCents: 1_000_000 },
    { kind: BUDGET_LINE_KINDS.fcr, label: "FCR", amountCents: 100_000 },
  ],
  actor: { personId: admin.id, userId: admin.userId },
});
const approved = await approveBudgetAndCreateObligations(deps, {
  tenantId: TENANT,
  budgetId: budget.budget.id,
  actor: { personId: admin.id, userId: admin.userId },
});
const targetObligations = approved.obligations.filter((o) => o.fracaoId === target.id);
const targetDebtCents = targetObligations.reduce((a, o) => a + o.openAmountCents, 0);
step("3_budget_approve_obligations", {
  endpoint: "POST /f1/budgets + POST /f1/budgets/:id/approve",
  budgetId: budget.budget.id,
  obligationsTotal: approved.obligations.length,
  targetObligations: targetObligations.map((o) => ({
    id: o.id,
    kind: o.kind,
    openAmountCents: o.openAmountCents,
  })),
  targetDebtCents,
  note: "approveBudgetAndCreateObligations cria Obligation automaticamente",
  ok: targetObligations.length > 0 && targetDebtCents > 0,
});

// ========== 4. Payment ==========
const payRes = await req("/f2/payments", {
  body: {
    fracaoId: target.id,
    amountCents: targetDebtCents,
    paymentMethod: PAYMENT_METHODS.bankTransfer,
    payerReference: "E2E-FONTE-E",
  },
});
const payment = payRes.body as { id?: string; allocationStatus?: string; message?: string };
step("4_register_payment", {
  endpoint: "POST /f2/payments",
  status: payRes.status,
  paymentId: payment.id ?? null,
  amountCents: targetDebtCents,
  method: PAYMENT_METHODS.bankTransfer,
  ok: payRes.status === 201 && Boolean(payment.id),
  error: payment.message ?? null,
});
if (payRes.status !== 201 || !payment.id) {
  fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });
  fs.writeFileSync(
    "/opt/cursor/artifacts/fonte-e2e-chain.json",
    JSON.stringify({ failedAt: "payment", log }, null, 2),
  );
  throw new Error(`Payment failed: ${payRes.status} ${JSON.stringify(payment)}`);
}

// ========== 5. Allocate ==========
const allocRes = await req(`/f2/payments/${payment.id}/allocate`, { method: "POST" });
const allocBody = allocRes.body as {
  allocations?: Array<{ id: string; amountCents: number; obligationId: string }>;
  message?: string;
  code?: string;
};
step("5_allocate", {
  endpoint: "POST /f2/payments/:id/allocate",
  status: allocRes.status,
  allocations: allocBody.allocations?.length ?? 0,
  sample: allocBody.allocations?.slice(0, 3) ?? null,
  ok: allocRes.status === 200 && (allocBody.allocations?.length ?? 0) > 0,
  error: allocBody.message ?? allocBody.code ?? null,
});
if (allocRes.status !== 200) {
  fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });
  fs.writeFileSync(
    "/opt/cursor/artifacts/fonte-e2e-chain.json",
    JSON.stringify({ failedAt: "allocate", log }, null, 2),
  );
  throw new Error(`Allocate failed: ${JSON.stringify(allocBody)}`);
}

// ========== 6. Ledger validate ==========
const ledgerRes = await req("/f2/ledger/validate", { method: "POST" });
const ledgerBody = ledgerRes.body as { ok?: boolean; message?: string };
step("6_ledger_validate", {
  endpoint: "POST /f2/ledger/validate",
  status: ledgerRes.status,
  ok: ledgerRes.status === 200 && ledgerBody.ok === true,
  body: ledgerBody,
});

// ========== 7. Portal saldo (owner) ==========
currentUser = { id: "user-owner-e-fonte", email: "owner-e@fonte-e2e.test" };
const saldoRes = await req("/f3/portal/saldo");
const saldoBody = saldoRes.body as {
  source?: string;
  fractions?: Array<{
    fracaoId: string;
    codigo?: string;
    balanceCents?: number;
    openObligationsCents?: number;
  }>;
  message?: string;
};
const fracSaldo = saldoBody.fractions?.[0] as
  | {
      fracaoId?: string;
      fracaoCodigo?: string;
      openCents?: number;
      allocatedCents?: number;
      originalCents?: number;
    }
  | undefined;
const paidDown = Boolean(fracSaldo) && fracSaldo!.openCents === 0 && (fracSaldo!.allocatedCents ?? 0) > 0;
step("7_portal_saldo", {
  endpoint: "GET /f3/portal/saldo",
  status: saldoRes.status,
  source: saldoBody.source ?? null,
  fractions: saldoBody.fractions ?? null,
  ok:
    saldoRes.status === 200 &&
    saldoBody.source === "ledger" &&
    Boolean(fracSaldo) &&
    fracSaldo!.fracaoId === target.id &&
    paidDown,
  paidDown,
  error: saldoBody.message ?? null,
});

const summary = {
  environment: "local/dev isolated SQLite (.tmp-fonte-e2e-chain.db)",
  isolatesPilotData: true,
  tenant: TENANT,
  targetCodigo: TARGET_CODIGO,
  chainOk: log.every((s) => s.ok !== false),
  permilagemCentesimasSum: confirmed.permilagemCentesimasSum,
  Nfracoes: fracoes.length,
  targetDebtCents,
  paymentId: payment.id,
  ledgerOk: ledgerBody.ok === true,
  portalSource: saldoBody.source ?? null,
  portalOpenCents: fracSaldo?.openCents ?? null,
  portalAllocatedCents: fracSaldo?.allocatedCents ?? null,
  portalOriginalCents: fracSaldo?.originalCents ?? null,
  steps: log,
};
fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });
fs.writeFileSync("/opt/cursor/artifacts/fonte-e2e-chain.json", JSON.stringify(summary, null, 2));
console.log("---SUMMARY---");
console.log(JSON.stringify(summary, null, 2));

client.close();
