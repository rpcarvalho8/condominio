import { and, eq } from "drizzle-orm";
import { constitutionFracoes, ownerContactDrafts } from "../../database/schema";
import { DomainError } from "../../domain/errors";
import {
  deriveInvitationStatus,
  INVITATION_CHANNELS,
  INVITATION_STATUS,
  maskContact,
  type InvitationStatus,
} from "../../domain/invitation";
import { AUDIT_TYPES } from "../../domain/audit";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { createInvitationRepo } from "../../infra/repos/invitation-repo";
import type { InvitationActor } from "./create-invitation";

export type ActivationPreviewRow = {
  contactDraftId: string;
  fracaoId: string | null;
  fracaoCodigo: string;
  personName: string;
  canal: string;
  contacto: string;
  contactoMasked: string;
  alreadyInvited: boolean;
};

export type ActivationPanel = {
  invited: number;
  pending: number;
  accepted: number;
  revoked: number;
  expired: number;
  accounts: number;
  /** Condóminos com Membership que abriram o portal (saldo Ledger). */
  portalOpen: number;
  /** Condóminos que descarregaram um FinancialDocument. */
  documentsSeen: number;
  preview: ActivationPreviewRow[];
};

export async function getActivationPanel(
  deps: KernelDeps,
  input: { tenantId: string },
): Promise<ActivationPanel> {
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);
  }
  const now = kernelNow(deps);
  const invitations = await createInvitationRepo(deps.db).listByTenant(tenantId);
  const counts: Record<InvitationStatus, number> = {
    pending: 0,
    accepted: 0,
    revoked: 0,
    expired: 0,
  };
  for (const row of invitations) {
    counts[deriveInvitationStatus(row, now)] += 1;
  }

  const drafts = await deps.db
    .select()
    .from(ownerContactDrafts)
    .where(
      and(eq(ownerContactDrafts.tenantId, tenantId), eq(ownerContactDrafts.status, "confirmed")),
    );
  const fracoes = await deps.db
    .select()
    .from(constitutionFracoes)
    .where(eq(constitutionFracoes.tenantId, tenantId));
  const fracaoByCodigo = new Map(fracoes.map((f) => [f.codigo, f]));

  const preview: ActivationPreviewRow[] = drafts.map((draft) => {
    const canal = draft.email ? INVITATION_CHANNELS.email : INVITATION_CHANNELS.sms;
    const contacto = (draft.email ?? draft.phone ?? "").trim();
    const fracao = fracaoByCodigo.get(draft.fracaoCodigo) ?? null;
    const alreadyInvited = invitations.some(
      (inv) =>
        inv.fracaoId === fracao?.id &&
        inv.contacto === (canal === INVITATION_CHANNELS.email ? contacto.toLowerCase() : contacto) &&
        deriveInvitationStatus(inv, now) === INVITATION_STATUS.pending,
    );
    return {
      contactDraftId: draft.id,
      fracaoId: fracao?.id ?? null,
      fracaoCodigo: draft.fracaoCodigo,
      personName: draft.personName,
      canal,
      contacto,
      contactoMasked: contacto ? maskContact(canal, contacto) : "",
      alreadyInvited,
    };
  });

  return {
    invited: invitations.length,
    pending: counts.pending,
    accepted: counts.accepted,
    revoked: counts.revoked,
    expired: counts.expired,
    accounts: counts.accepted,
    portalOpen: await createAuditEventRepo(deps.db).countDistinctActorsByTypes(tenantId, [
      AUDIT_TYPES.portalOpened,
    ]),
    documentsSeen: await createAuditEventRepo(deps.db).countDistinctActorsByTypes(tenantId, [
      AUDIT_TYPES.financialDocumentSeen,
    ]),
    preview,
  };
}

export async function createInvitationsFromConfirmedContacts(
  deps: KernelDeps,
  input: {
    tenantId: string;
    contactDraftIds: string[];
    actor: InvitationActor;
  },
) {
  if (!input.contactDraftIds.length) {
    throw new DomainError("lote_empty", "Seleccione contactos confirmados", 400);
  }
  const panel = await getActivationPanel(deps, { tenantId: input.tenantId });
  const selected = panel.preview.filter((row) => input.contactDraftIds.includes(row.contactDraftId));
  if (selected.length !== input.contactDraftIds.length) {
    throw new DomainError(
      "contact_draft_not_found",
      "Contacto confirmado não encontrado (OCR nunca dispara convites)",
      404,
    );
  }
  const items = selected.map((row) => {
    if (!row.fracaoId) {
      throw new DomainError(
        "fracao_not_found",
        `Fração ${row.fracaoCodigo} ainda não está confirmada`,
        400,
      );
    }
    if (!row.contacto) {
      throw new DomainError("contact_required", `Contacto em falta para ${row.fracaoCodigo}`, 400);
    }
    return {
      fracaoId: row.fracaoId,
      contacto: row.contacto,
      canal: row.canal,
      personName: row.personName,
    };
  });

  const { createInvitationLote } = await import("./create-invitation");
  return createInvitationLote(deps, {
    tenantId: input.tenantId,
    items,
    actor: input.actor,
  });
}
