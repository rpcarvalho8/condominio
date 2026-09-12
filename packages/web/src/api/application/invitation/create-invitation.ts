import { and, eq } from "drizzle-orm";
import { constitutionFracoes } from "../../database/schema";
import { AUDIT_TYPES } from "../../domain/audit";
import { DOMAIN_EVENT_TYPES } from "../../domain/domain-event";
import { DomainError } from "../../domain/errors";
import {
  assertInvitationTokenOpaque,
  defaultInvitationRole,
  generateOpaqueToken,
  hashOpaqueSecret,
  INVITATION_CHANNELS,
  INVITATION_DEFAULT_TTL_MS,
  isInvitationChannel,
  looksLikeEmail,
  normalizeContact,
  toPublicInvitation,
  type InvitationPublicView,
} from "../../domain/invitation";
import { OUTBOX_JOB_TYPES } from "../../domain/outbox";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { createInvitationRepo } from "../../infra/repos/invitation-repo";
import { emitAndEnqueue } from "../events/emit";

export type InvitationActor = {
  personId: string | null;
  userId: string | null;
  source?: string | null;
  requestId?: string | null;
};

export type CreateInvitationItem = {
  fracaoId: string;
  contacto: string;
  canal?: string;
  personName?: string | null;
  roleCode?: string | null;
  expiresInMs?: number;
};

export type CreateInvitationInput = CreateInvitationItem & {
  tenantId: string;
  loteId?: string | null;
  actor: InvitationActor;
};

export type CreatedInvitation = {
  invitation: InvitationPublicView;
  /** Opaque token — returned once. Never stored in plaintext. */
  token: string;
};

async function assertFracaoInTenant(
  deps: KernelDeps,
  tenantId: string,
  fracaoId: string,
): Promise<void> {
  const [fracao] = await deps.db
    .select()
    .from(constitutionFracoes)
    .where(and(eq(constitutionFracoes.id, fracaoId), eq(constitutionFracoes.tenantId, tenantId)))
    .limit(1);
  if (!fracao) {
    throw new DomainError("fracao_not_found", "Fração não encontrada neste tenant", 404);
  }
}

export async function createInvitation(
  deps: KernelDeps,
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);
  }
  const canal = (input.canal ?? INVITATION_CHANNELS.email).trim();
  if (!isInvitationChannel(canal)) {
    throw new DomainError("invalid_channel", "Canal deve ser email ou sms", 400);
  }
  const contacto = normalizeContact(canal, input.contacto ?? "");
  if (!contacto) {
    throw new DomainError("contact_required", "Contacto é obrigatório", 400);
  }
  if (canal === INVITATION_CHANNELS.email && !looksLikeEmail(contacto)) {
    throw new DomainError("invalid_contact", "Email inválido", 400);
  }
  if (!input.fracaoId?.trim()) {
    throw new DomainError("fracao_required", "fracaoId é obrigatório", 400);
  }

  const roleCode = defaultInvitationRole(input.roleCode);
  await assertFracaoInTenant(deps, tenantId, input.fracaoId);

  const repo = createInvitationRepo(deps.db);
  const pending = await repo.findPendingForContact(tenantId, input.fracaoId, contacto);
  if (pending) {
    throw new DomainError(
      "invitation_pending_exists",
      "Já existe um convite pendente para esta fração e contacto",
      409,
    );
  }

  const now = kernelNow(deps);
  const token = generateOpaqueToken();
  const id = crypto.randomUUID();
  assertInvitationTokenOpaque(token, id);
  const ttl = input.expiresInMs && input.expiresInMs > 0 ? input.expiresInMs : INVITATION_DEFAULT_TTL_MS;

  const invitation = await repo.insert({
    id,
    tenantId,
    fracaoId: input.fracaoId,
    canal,
    contacto,
    personName: input.personName?.trim() || null,
    roleCode,
    tokenHash: hashOpaqueSecret(token),
    expiresAt: new Date(now.getTime() + ttl),
    loteId: input.loteId ?? null,
    createdAt: now,
    createdByPersonId: input.actor.personId,
  });

  const publicView = toPublicInvitation(invitation, now);
  await createAuditEventRepo(deps.db).append({
    tenantId,
    type: AUDIT_TYPES.invitationCreated,
    entityType: "invitation",
    entityId: invitation.id,
    actorUserId: input.actor.userId,
    actorPersonId: input.actor.personId,
    before: null,
    after: {
      id: invitation.id,
      fracaoId: invitation.fracaoId,
      canal: invitation.canal,
      contactoMasked: publicView.contactoMasked,
      loteId: invitation.loteId,
      expiresAt: invitation.expiresAt.toISOString(),
    },
    reason: invitation.loteId ? "create_invitation_lote" : "create_invitation",
    source: input.actor.source ?? "application",
    requestId: input.actor.requestId ?? null,
  });

  await emitAndEnqueue(
    deps,
    {
      tenantId,
      type: DOMAIN_EVENT_TYPES.invitationCreated,
      aggregateType: "invitation",
      aggregateId: invitation.id,
      payload: {
        fracaoId: invitation.fracaoId,
        canal: invitation.canal,
        loteId: invitation.loteId,
      },
      correlationId: input.actor.requestId ?? null,
    },
    {
      tenantId,
      jobType: OUTBOX_JOB_TYPES.notifyInvitationCreated,
      idempotencyKey: `notify:invitation:${invitation.id}:created`,
      payload: {
        invitationId: invitation.id,
        canal: invitation.canal,
        destination: invitation.contacto,
        token,
        fracaoId: invitation.fracaoId,
        personName: invitation.personName,
        expiresAt: invitation.expiresAt.toISOString(),
      },
      correlationId: input.actor.requestId ?? null,
    },
    { drain: true },
  );

  return { invitation: publicView, token };
}

export async function createInvitationLote(
  deps: KernelDeps,
  input: {
    tenantId: string;
    items: CreateInvitationItem[];
    actor: InvitationActor;
  },
): Promise<{ loteId: string; invitations: CreatedInvitation[] }> {
  if (!input.items.length) {
    throw new DomainError("lote_empty", "Lote sem convites", 400);
  }
  const loteId = crypto.randomUUID();
  const created: CreatedInvitation[] = [];
  for (const item of input.items) {
    created.push(
      await createInvitation(deps, {
        ...item,
        tenantId: input.tenantId,
        loteId,
        actor: input.actor,
      }),
    );
  }
  return { loteId, invitations: created };
}
