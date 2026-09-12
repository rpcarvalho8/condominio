/**
 * F3 portal Essencial — saldo Ledger + FinancialDocument, scoped à Membership.
 * Fail-closed: só Membership activa com fração; tenant da sessão.
 */
import { AUDIT_TYPES } from "../../domain/audit";
import { FINANCIAL_DOC_TYPES } from "../../domain/finance";
import { DomainError } from "../../domain/errors";
import { isActiveMembership, type Membership } from "../../domain/membership";
import type { KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import {
  getFinancialDocumentInTenant,
  issueAccountStatement,
  listFinancialDocumentsForFracoes,
} from "../finance/f2-finance";
import { reconstructFracaoBalance, type FracaoLedgerBalance } from "../finance/f2-ledger-balance";

export type PortalActor = {
  personId: string;
  userId?: string | null;
  requestId?: string | null;
};

export type PortalDocumentView = {
  id: string;
  fracaoId: string | null;
  docType: string;
  periodLabel: string | null;
  issuedAt: string;
  dueAt: string | null;
  amountCents: number;
  status: string;
  documentNumber: string | null;
  generatedFrom: Record<string, unknown>;
  downloadable: boolean;
};

const PORTAL_DOC_TYPES = new Set<string>([
  FINANCIAL_DOC_TYPES.paymentNotice,
  FINANCIAL_DOC_TYPES.receipt,
  FINANCIAL_DOC_TYPES.accountStatement,
]);

export function authorizedFracaoIds(memberships: Membership[]): string[] {
  const ids = new Set<string>();
  for (const m of memberships) {
    if (!isActiveMembership(m)) continue;
    if (m.fracaoId) ids.add(m.fracaoId);
  }
  return [...ids];
}

function assertPortalMembership(memberships: Membership[]): string[] {
  const fracaoIds = authorizedFracaoIds(memberships);
  if (fracaoIds.length === 0) {
    throw new DomainError(
      "portal_fracao_required",
      "Membership activa da fração é obrigatória",
      403,
    );
  }
  return fracaoIds;
}

function assertFracaoAuthorized(fracaoIds: string[], fracaoId: string | null | undefined): string {
  if (!fracaoId || !fracaoIds.includes(fracaoId)) {
    throw new DomainError("portal_fracao_forbidden", "Acesso negado a esta fração", 403);
  }
  return fracaoId;
}

function parseGeneratedFrom(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function toDocumentView(row: {
  id: string;
  fracaoId: string | null;
  docType: string;
  periodLabel: string | null;
  issuedAt: Date;
  dueAt: Date | null;
  amountCents: number;
  status: string;
  documentNumber: string | null;
  generatedFromJson: string;
}): PortalDocumentView {
  return {
    id: row.id,
    fracaoId: row.fracaoId,
    docType: row.docType,
    periodLabel: row.periodLabel,
    issuedAt: row.issuedAt.toISOString(),
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    amountCents: row.amountCents,
    status: row.status,
    documentNumber: row.documentNumber,
    generatedFrom: parseGeneratedFrom(row.generatedFromJson),
    downloadable: true,
  };
}

async function recordPortalSignal(
  deps: KernelDeps,
  input: {
    tenantId: string;
    type: string;
    entityType: string;
    entityId: string;
    actor: PortalActor;
    after?: Record<string, unknown>;
  },
) {
  await createAuditEventRepo(deps.db).append({
    tenantId: input.tenantId,
    type: input.type,
    entityType: input.entityType,
    entityId: input.entityId,
    actorPersonId: input.actor.personId,
    actorUserId: input.actor.userId ?? null,
    requestId: input.actor.requestId ?? null,
    after: input.after ?? null,
    source: "f3-portal",
  });
}

export async function getPortalSaldo(
  deps: KernelDeps,
  input: {
    tenantId: string;
    memberships: Membership[];
    actor: PortalActor;
  },
): Promise<{ source: "ledger"; fractions: FracaoLedgerBalance[] }> {
  const tenantId = input.tenantId.trim();
  if (!tenantId) throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);
  const fracaoIds = assertPortalMembership(input.memberships);

  const fractions: FracaoLedgerBalance[] = [];
  for (const fracaoId of fracaoIds) {
    fractions.push(await reconstructFracaoBalance(deps, { tenantId, fracaoId }));
  }

  await recordPortalSignal(deps, {
    tenantId,
    type: AUDIT_TYPES.portalOpened,
    entityType: "membership",
    entityId: input.memberships.find((m) => m.fracaoId === fracaoIds[0])?.id ?? input.actor.personId,
    actor: input.actor,
    after: { fracaoIds, source: "ledger" },
  });

  return { source: "ledger", fractions };
}

export async function listPortalDocuments(
  deps: KernelDeps,
  input: {
    tenantId: string;
    memberships: Membership[];
    actor: PortalActor;
  },
): Promise<{ documents: PortalDocumentView[] }> {
  const tenantId = input.tenantId.trim();
  if (!tenantId) throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);
  const fracaoIds = assertPortalMembership(input.memberships);
  const rows = await listFinancialDocumentsForFracoes(deps, { tenantId, fracaoIds });
  const documents = rows
    .filter((row) => PORTAL_DOC_TYPES.has(row.docType))
    .map(toDocumentView)
    .sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1));
  return { documents };
}

export async function downloadPortalDocument(
  deps: KernelDeps,
  input: {
    tenantId: string;
    documentId: string;
    memberships: Membership[];
    actor: PortalActor;
  },
): Promise<{ filename: string; contentType: string; body: string; document: PortalDocumentView }> {
  const tenantId = input.tenantId.trim();
  if (!tenantId) throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);
  const fracaoIds = assertPortalMembership(input.memberships);
  const row = await getFinancialDocumentInTenant(deps, {
    tenantId,
    documentId: input.documentId,
  });
  if (!row || !PORTAL_DOC_TYPES.has(row.docType)) {
    throw new DomainError("document_not_found", "Documento não encontrado", 404);
  }
  assertFracaoAuthorized(fracaoIds, row.fracaoId);

  const view = toDocumentView(row);
  await recordPortalSignal(deps, {
    tenantId,
    type: AUDIT_TYPES.financialDocumentSeen,
    entityType: "financial_document",
    entityId: row.id,
    actor: input.actor,
    after: { docType: row.docType, documentNumber: row.documentNumber },
  });

  const html = renderFinancialDocumentHtml(view);
  const safeName = (row.documentNumber ?? row.id).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return {
    filename: `${safeName}.html`,
    contentType: "text/html; charset=utf-8",
    body: html,
    document: view,
  };
}

export async function requestPortalAccountStatement(
  deps: KernelDeps,
  input: {
    tenantId: string;
    fracaoId?: string | null;
    memberships: Membership[];
    actor: PortalActor;
  },
) {
  const tenantId = input.tenantId.trim();
  if (!tenantId) throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);
  const fracaoIds = assertPortalMembership(input.memberships);
  const fracaoId = assertFracaoAuthorized(fracaoIds, input.fracaoId ?? fracaoIds[0]);
  const doc = await issueAccountStatement(deps, {
    tenantId,
    fracaoId,
    actor: {
      personId: input.actor.personId,
      userId: input.actor.userId ?? null,
      requestId: input.actor.requestId ?? null,
    },
  });
  return toDocumentView(doc);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

function docTypeLabel(docType: string): string {
  if (docType === FINANCIAL_DOC_TYPES.paymentNotice) return "Aviso de Débito";
  if (docType === FINANCIAL_DOC_TYPES.receipt) return "Recibo";
  if (docType === FINANCIAL_DOC_TYPES.accountStatement) return "Extrato";
  return docType;
}

function renderFinancialDocumentHtml(doc: PortalDocumentView): string {
  const generated = escapeHtml(JSON.stringify(doc.generatedFrom, null, 2));
  return `<!doctype html>
<html lang="pt">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(docTypeLabel(doc.docType))} ${escapeHtml(doc.documentNumber ?? doc.id)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; color: #111; background: #fff; padding: 32px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    .meta { color: #555; font-size: 14px; }
    .valor { font-size: 28px; font-weight: 700; margin: 24px 0; color: #D0021B; }
    pre { background: #F5F5F7; padding: 12px; border-radius: 8px; overflow: auto; font-size: 12px; }
    .note { color: #666; font-size: 12px; margin-top: 24px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(docTypeLabel(doc.docType))}</h1>
  <p class="meta">N.º ${escapeHtml(doc.documentNumber ?? "—")} · Período ${escapeHtml(doc.periodLabel ?? "—")}</p>
  <p class="meta">Emitido ${escapeHtml(new Date(doc.issuedAt).toLocaleString("pt-PT"))}</p>
  <p class="valor">${escapeHtml(formatCents(doc.amountCents))}</p>
  <h2>Origem (generated_from)</h2>
  <pre>${generated}</pre>
  <p class="note">Representação imutável reconstruída a partir do Ledger. FinancialDocument nunca é fonte de verdade.</p>
</body>
</html>`;
}
