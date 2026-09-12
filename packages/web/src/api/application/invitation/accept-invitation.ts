import { AUDIT_TYPES } from "../../domain/audit";
import { DOMAIN_EVENT_TYPES } from "../../domain/domain-event";
import { DomainError } from "../../domain/errors";
import {
  assertUsableInvitation,
  hashOpaqueSecret,
  INVITATION_CHANNELS,
  looksLikeEmail,
  toPublicInvitation,
  type InvitationPublicView,
} from "../../domain/invitation";
import { kernelNow, type KernelDb, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { createInvitationRepo } from "../../infra/repos/invitation-repo";
import { createMembership } from "../identity/create-membership";
import { publishDomainEvent } from "../events/emit";

export type AcceptInvitationInput = {
  token: string;
  userId?: string | null;
  name?: string | null;
  email?: string | null;
  requestId?: string | null;
};

async function withAcceptTransaction<T>(
  deps: KernelDeps,
  fn: (txDeps: KernelDeps) => Promise<T>,
): Promise<T> {
  return deps.db.transaction(async (tx) => {
    return fn({ ...deps, db: tx as unknown as KernelDb });
  });
}

export async function acceptInvitation(
  deps: KernelDeps,
  input: AcceptInvitationInput,
): Promise<{
  invitation: InvitationPublicView;
  personId: string;
  membershipId: string;
  tenantId: string;
}> {
  if (!input.token?.trim()) {
    throw new DomainError("token_required", "Token do convite é obrigatório", 400);
  }

  return withAcceptTransaction(deps, async (txDeps) => {
    const repo = createInvitationRepo(txDeps.db);
    const invitation = await repo.findByTokenHash(hashOpaqueSecret(input.token));
    if (!invitation) {
      throw new DomainError("invitation_not_found", "Convite não encontrado", 404);
    }

    const now = kernelNow(txDeps);
    assertUsableInvitation(invitation, now);
    if (!invitation.contactVerifiedAt) {
      throw new DomainError(
        "contact_not_verified",
        "Verifique o contacto antes de criar Membership",
        403,
      );
    }

    const email =
      invitation.canal === INVITATION_CHANNELS.email
        ? invitation.contacto
        : (input.email?.trim().toLowerCase() ?? "");
    if (!looksLikeEmail(email)) {
      throw new DomainError(
        "email_required",
        "Email da conta é obrigatório após verificação do contacto",
        400,
      );
    }
    if (
      invitation.canal === INVITATION_CHANNELS.email &&
      input.email &&
      input.email.trim().toLowerCase() !== invitation.contacto
    ) {
      throw new DomainError(
        "contact_mismatch",
        "O email da conta tem de coincidir com o contacto verificado",
        403,
      );
    }

    const name = (input.name?.trim() || invitation.personName || email.split("@")[0] || "Condómino").trim();

    const created = await createMembership(txDeps, {
      tenantId: invitation.tenantId,
      roleCode: invitation.roleCode,
      fracaoId: invitation.fracaoId,
      reason: "invitation_accepted",
      userId: input.userId ?? undefined,
      person: {
        name,
        email,
        phone: invitation.canal === INVITATION_CHANNELS.sms ? invitation.contacto : null,
      },
      actor: {
        personId: invitation.createdByPersonId,
        userId: input.userId ?? null,
        source: "invitation",
        requestId: input.requestId ?? null,
      },
    });

    const accepted = await repo.markAccepted({
      id: invitation.id,
      usedAt: now,
      acceptedPersonId: created.person.id,
      acceptedMembershipId: created.membership.id,
    });
    if (!accepted) {
      throw new DomainError(
        "invitation_used",
        "Convite já foi utilizado",
        409,
      );
    }

    await createAuditEventRepo(txDeps.db).append({
      tenantId: invitation.tenantId,
      type: AUDIT_TYPES.invitationAccepted,
      entityType: "invitation",
      entityId: invitation.id,
      actorUserId: input.userId ?? null,
      actorPersonId: created.person.id,
      after: {
        personId: created.person.id,
        membershipId: created.membership.id,
        fracaoId: invitation.fracaoId,
        roleCode: created.membership.roleCode,
        userId: created.person.userId,
      },
      reason: "accept_invitation",
      source: "invitation",
      requestId: input.requestId ?? null,
    });

    await publishDomainEvent(txDeps, {
      tenantId: invitation.tenantId,
      type: DOMAIN_EVENT_TYPES.invitationAccepted,
      aggregateType: "invitation",
      aggregateId: invitation.id,
      payload: {
        personId: created.person.id,
        membershipId: created.membership.id,
      },
      correlationId: input.requestId ?? null,
    });

    return {
      invitation: toPublicInvitation(accepted, now),
      personId: created.person.id,
      membershipId: created.membership.id,
      tenantId: invitation.tenantId,
    };
  });
}
