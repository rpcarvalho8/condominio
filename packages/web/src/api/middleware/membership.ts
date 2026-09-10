import { createMiddleware } from "hono/factory";
import type { Person } from "../domain/person";
import type { Membership } from "../domain/membership";
import { canManageMemberships } from "../domain/roles";
import type { KernelDeps } from "../infra/kernel-deps";
import { createMembershipRepo } from "../infra/repos/membership-repo";
import { createPersonRepo } from "../infra/repos/person-repo";

export type KernelAuthUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
};

export type KernelVariables = {
  user: KernelAuthUser | null;
  session: unknown;
  person: Person | null;
  memberships: Membership[];
  tenantId: string | null;
};

function readUser(c: { get: (key: "user") => unknown }): KernelAuthUser | null {
  const user = c.get("user") as KernelAuthUser | null;
  if (!user?.id) return null;
  return user;
}

/**
 * New kernel paths only. Session identifies Person; authorization reads Membership.
 * tenant_id is never taken from the client. Missing tenant or membership → 403.
 */
export function createRequireActiveMembership(deps: KernelDeps) {
  return createMiddleware<{ Variables: KernelVariables }>(async (c, next) => {
    const user = readUser(c);
    if (!user) return c.json({ message: "Não autenticado" }, 401);

    const tenantId = String(deps.getTenantId() ?? "").trim();
    if (!tenantId) {
      return c.json({ message: "Contexto de tenant inválido" }, 403);
    }

    const personRepo = createPersonRepo(deps.db);
    const membershipRepo = createMembershipRepo(deps.db);
    const person = await personRepo.findByUserId(user.id);
    if (!person) {
      return c.json({ message: "Acesso negado" }, 403);
    }

    const memberships = await membershipRepo.findActiveForPersonTenant(person.id, tenantId);
    if (memberships.length === 0) {
      return c.json({ message: "Acesso negado" }, 403);
    }

    c.set("person", person);
    c.set("memberships", memberships);
    c.set("tenantId", tenantId);
    return next();
  });
}

export function createRequireMembershipManager() {
  return createMiddleware<{ Variables: KernelVariables }>(async (c, next) => {
    const memberships = c.get("memberships") ?? [];
    const allowed = memberships.some((m) => canManageMemberships(String(m.roleCode)));
    if (!allowed) {
      return c.json({ message: "Acesso negado" }, 403);
    }
    return next();
  });
}
