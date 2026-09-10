import { AUDIT_TYPES } from "../../domain/audit";
import { DomainError } from "../../domain/errors";
import { MEMBERSHIP_STATUS, type Membership } from "../../domain/membership";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { createMembershipRepo } from "../../infra/repos/membership-repo";

export type RevokeMembershipInput = {
  membershipId: string;
  tenantId: string;
  reason?: string | null;
  actor: {
    personId: string | null;
    userId: string | null;
    source?: string | null;
    requestId?: string | null;
  };
};

function snapshot(membership: Membership): Record<string, unknown> {
  return {
    id: membership.id,
    personId: membership.personId,
    tenantId: membership.tenantId,
    fracaoId: membership.fracaoId,
    roleCode: membership.roleCode,
    scope: membership.scope,
    status: membership.status,
    revokedAt: membership.revokedAt ? membership.revokedAt.toISOString() : null,
  };
}

export async function revokeMembership(
  deps: KernelDeps,
  input: RevokeMembershipInput,
): Promise<Membership> {
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);
  }

  const membershipRepo = createMembershipRepo(deps.db);
  const auditRepo = createAuditEventRepo(deps.db);
  const now = kernelNow(deps);

  const current = await membershipRepo.findById(input.membershipId);
  if (!current) {
    throw new DomainError("membership_not_found", "Membership não encontrada", 404);
  }
  if (current.tenantId !== tenantId) {
    throw new DomainError("tenant_mismatch", "Membership não pertence a este tenant", 403);
  }
  if (current.status === MEMBERSHIP_STATUS.revoked) {
    return current;
  }

  const before = snapshot(current);
  const revoked = await membershipRepo.revoke({
    id: current.id,
    revokedAt: now,
    revokedByPersonId: input.actor.personId,
  });
  if (!revoked) {
    throw new DomainError("membership_not_found", "Membership não encontrada", 404);
  }

  await auditRepo.append({
    tenantId,
    type: AUDIT_TYPES.membershipRevoked,
    entityType: "membership",
    entityId: revoked.id,
    actorUserId: input.actor.userId,
    actorPersonId: input.actor.personId,
    before,
    after: snapshot(revoked),
    reason: input.reason ?? "revoke_membership",
    source: input.actor.source ?? "application",
    requestId: input.actor.requestId ?? null,
  });

  return revoked;
}
