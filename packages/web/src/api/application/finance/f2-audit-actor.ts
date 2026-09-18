/**
 * Astra A7 — AuditEvent identity (ADR-009 / invariante 10).
 * Human F2 mutations: session → Person → active Membership in this tenant.
 * System jobs (`f2.job`) may persist a null actor_person_id.
 */
import {
  AUDIT_SOURCE_F2,
  F2_ACTOR_REQUIRED_CODE,
  F2_ACTOR_REQUIRED_MESSAGE,
  isSystemAuditSource,
  type AuditActor,
} from "../../domain/audit";
import { DomainError } from "../../domain/errors";
import type { KernelDeps } from "../../infra/kernel-deps";
import { createMembershipRepo } from "../../infra/repos/membership-repo";

export type ResolvedF2Actor = {
  personId: string | null;
  userId: string | null;
  requestId: string | null;
  source: string;
};

export async function resolveF2AuditActor(
  deps: KernelDeps,
  tenantId: string,
  actor?: AuditActor | null,
): Promise<ResolvedF2Actor> {
  const source = actor?.source?.trim() || AUDIT_SOURCE_F2;
  const personId = actor?.personId?.trim() || null;
  const userId = actor?.userId?.trim() || null;
  const requestId = actor?.requestId?.trim() || null;

  if (isSystemAuditSource(source)) {
    return { personId, userId, requestId, source };
  }

  if (!personId) {
    throw new DomainError(F2_ACTOR_REQUIRED_CODE, F2_ACTOR_REQUIRED_MESSAGE, 403);
  }

  const memberships = await createMembershipRepo(deps.db).findActiveForPersonTenant(
    personId,
    tenantId,
  );
  if (memberships.length === 0) {
    throw new DomainError(F2_ACTOR_REQUIRED_CODE, F2_ACTOR_REQUIRED_MESSAGE, 403);
  }

  return { personId, userId, requestId, source };
}
