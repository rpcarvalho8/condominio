import { AUDIT_TYPES } from "../../domain/audit";
import { DOMAIN_EVENT_TYPES } from "../../domain/domain-event";
import { DomainError } from "../../domain/errors";
import {
  deriveInvitationStatus,
  INVITATION_STATUS,
  maskContact,
  toPublicInvitation,
  type InvitationPublicView,
} from "../../domain/invitation";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { createInvitationRepo } from "../../infra/repos/invitation-repo";
import { publishDomainEvent } from "../events/emit";
import type { InvitationActor } from "./create-invitation";

export async function revokeInvitation(
  deps: KernelDeps,
  input: {
    invitationId: string;
    tenantId: string;
    reason?: string | null;
    actor: InvitationActor;
  },
): Promise<InvitationPublicView> {
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);
  }
  const repo = createInvitationRepo(deps.db);
  const current = await repo.findById(input.invitationId);
  if (!current) {
    throw new DomainError("invitation_not_found", "Convite não encontrado", 404);
  }
  if (current.tenantId !== tenantId) {
    throw new DomainError("tenant_mismatch", "Convite não pertence a este tenant", 403);
  }

  const now = kernelNow(deps);
  const status = deriveInvitationStatus(current, now);
  if (status === INVITATION_STATUS.revoked) {
    return toPublicInvitation(current, now);
  }
  if (status === INVITATION_STATUS.accepted) {
    throw new DomainError("invitation_used", "Não é possível revogar um convite já aceite", 409);
  }

  const revoked = await repo.revoke({
    id: current.id,
    revokedAt: now,
    revokedByPersonId: input.actor.personId,
  });
  if (!revoked) {
    const raced = await repo.findById(current.id);
    if (raced && deriveInvitationStatus(raced, now) === INVITATION_STATUS.accepted) {
      throw new DomainError("invitation_used", "Não é possível revogar um convite já aceite", 409);
    }
    throw new DomainError("invitation_not_found", "Convite não encontrado", 404);
  }

  await createAuditEventRepo(deps.db).append({
    tenantId,
    type: AUDIT_TYPES.invitationRevoked,
    entityType: "invitation",
    entityId: revoked.id,
    actorUserId: input.actor.userId,
    actorPersonId: input.actor.personId,
    before: {
      status: current.status,
      contactoMasked: maskContact(current.canal, current.contacto),
    },
    after: {
      status: revoked.status,
      revokedAt: revoked.revokedAt?.toISOString() ?? null,
    },
    reason: input.reason ?? "revoke_invitation",
    source: input.actor.source ?? "application",
    requestId: input.actor.requestId ?? null,
  });

  await publishDomainEvent(deps, {
    tenantId,
    type: DOMAIN_EVENT_TYPES.invitationRevoked,
    aggregateType: "invitation",
    aggregateId: revoked.id,
    payload: { status: revoked.status },
    correlationId: input.actor.requestId ?? null,
  });

  return toPublicInvitation(revoked, now);
}
