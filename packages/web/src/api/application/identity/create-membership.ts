import { AUDIT_TYPES } from "../../domain/audit";
import { DOMAIN_EVENT_TYPES } from "../../domain/domain-event";
import { DomainError } from "../../domain/errors";
import type { Membership } from "../../domain/membership";
import { sameFracao } from "../../domain/membership";
import type { Person } from "../../domain/person";
import { isKernelRoleCode } from "../../domain/roles";
import { OUTBOX_JOB_TYPES } from "../../domain/outbox";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { createMembershipRepo } from "../../infra/repos/membership-repo";
import { createPersonRepo } from "../../infra/repos/person-repo";
import { createRoleRepo } from "../../infra/repos/role-repo";
import { emitAndEnqueue } from "../events/emit";

export type CreateMembershipInput = {
  tenantId: string;
  roleCode: string;
  fracaoId?: string | null;
  scope?: string | null;
  reason?: string | null;
  personId?: string;
  userId?: string;
  person?: {
    name: string;
    email: string;
    nif?: string | null;
    phone?: string | null;
  };
  actor: {
    personId: string | null;
    userId: string | null;
    source?: string | null;
    requestId?: string | null;
  };
};

export type CreateMembershipResult = {
  person: Person;
  membership: Membership;
};

async function resolvePerson(
  input: CreateMembershipInput,
  personRepo: ReturnType<typeof createPersonRepo>,
  now: Date,
): Promise<Person> {
  if (input.personId) {
    const existing = await personRepo.findById(input.personId);
    if (!existing) {
      throw new DomainError("person_not_found", "Person não encontrada", 404);
    }
    return existing;
  }

  if (input.userId) {
    const byUser = await personRepo.findByUserId(input.userId);
    if (byUser) return byUser;
  }

  if (input.person) {
    const email = input.person.email;
    if (!email?.trim() || !input.person.name?.trim()) {
      throw new DomainError("invalid_person", "name e email são obrigatórios", 400);
    }
    const byEmail = await personRepo.findByEmail(email);
    if (byEmail) {
      if (input.userId && byEmail.userId && byEmail.userId !== input.userId) {
        throw new DomainError(
          "person_user_conflict",
          "Person já está ligada a outro utilizador",
          409,
        );
      }
      if (input.userId && !byEmail.userId) {
        const linked = await personRepo.linkUserId(byEmail.id, input.userId);
        if (!linked) {
          throw new DomainError("person_not_found", "Person não encontrada", 404);
        }
        return linked;
      }
      return byEmail;
    }
    return personRepo.insert({
      id: crypto.randomUUID(),
      userId: input.userId ?? null,
      name: input.person.name,
      email,
      nif: input.person.nif ?? null,
      phone: input.person.phone ?? null,
      createdAt: now,
    });
  }

  throw new DomainError(
    "person_required",
    "Indique personId, userId com Person existente, ou dados de Person",
    400,
  );
}

function snapshot(membership: Membership): Record<string, unknown> {
  return {
    id: membership.id,
    personId: membership.personId,
    tenantId: membership.tenantId,
    fracaoId: membership.fracaoId,
    roleCode: membership.roleCode,
    scope: membership.scope,
    status: membership.status,
  };
}

export async function createMembership(
  deps: KernelDeps,
  input: CreateMembershipInput,
): Promise<CreateMembershipResult> {
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);
  }
  if (!isKernelRoleCode(input.roleCode)) {
    throw new DomainError("invalid_role", `Role inválido: ${input.roleCode}`, 400);
  }

  const now = kernelNow(deps);
  const roleRepo = createRoleRepo(deps.db);
  const personRepo = createPersonRepo(deps.db);
  const membershipRepo = createMembershipRepo(deps.db);
  const auditRepo = createAuditEventRepo(deps.db);

  const role = await roleRepo.findByCode(input.roleCode);
  if (!role) {
    throw new DomainError("role_not_seeded", `Role ${input.roleCode} não está no seed`, 500);
  }

  const person = await resolvePerson(input, personRepo, now);
  const existing = await membershipRepo.findActiveForPersonTenant(person.id, tenantId);
  const duplicate = existing.find(
    (m) => m.roleCode === input.roleCode && sameFracao(m.fracaoId, input.fracaoId),
  );
  if (duplicate) {
    throw new DomainError("membership_exists", "Já existe Membership activo para este vínculo", 409);
  }

  const membership = await membershipRepo.insert({
    id: crypto.randomUUID(),
    personId: person.id,
    tenantId,
    fracaoId: input.fracaoId ?? null,
    roleCode: input.roleCode,
    scope: input.scope ?? null,
    createdAt: now,
    createdByPersonId: input.actor.personId,
  });

  await auditRepo.append({
    tenantId,
    type: AUDIT_TYPES.membershipCreated,
    entityType: "membership",
    entityId: membership.id,
    actorUserId: input.actor.userId,
    actorPersonId: input.actor.personId,
    before: null,
    after: snapshot(membership),
    reason: input.reason ?? "create_membership",
    source: input.actor.source ?? "application",
    requestId: input.actor.requestId ?? null,
  });

  await emitAndEnqueue(
    deps,
    {
      tenantId,
      type: DOMAIN_EVENT_TYPES.membershipCreated,
      aggregateType: "membership",
      aggregateId: membership.id,
      payload: snapshot(membership),
      correlationId: input.actor.requestId ?? null,
    },
    {
      tenantId,
      jobType: OUTBOX_JOB_TYPES.notifyMembershipCreated,
      idempotencyKey: `notify:membership:${membership.id}:created`,
      payload: {
        membershipId: membership.id,
        personId: person.id,
        email: person.email,
        roleCode: membership.roleCode,
      },
      correlationId: input.actor.requestId ?? null,
    },
    { drain: true },
  );

  return { person, membership };
}
