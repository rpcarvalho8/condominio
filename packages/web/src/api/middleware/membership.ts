import { createMiddleware } from "hono/factory";
import type { Person } from "../domain/person";
import type { Membership } from "../domain/membership";
import { F2_ACTOR_REQUIRED_CODE, F2_ACTOR_REQUIRED_MESSAGE } from "../domain/audit";
import { canManageFinance, canManageMemberships, canVerifyCash } from "../domain/roles";
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

type MembershipGateOk = {
  ok: true;
  person: Person;
  memberships: Membership[];
  tenantId: string;
};

type MembershipGateDeny = {
  ok: false;
  status: 401 | 403;
  kind: "unauthenticated" | "tenant" | "membership";
  body: { message: string };
};

async function resolveMembershipGate(
  deps: KernelDeps,
  c: { get: (key: "user") => unknown },
): Promise<MembershipGateOk | MembershipGateDeny> {
  const user = readUser(c);
  if (!user) {
    return { ok: false, status: 401, kind: "unauthenticated", body: { message: "Não autenticado" } };
  }

  const tenantId = String(deps.getTenantId() ?? "").trim();
  if (!tenantId) {
    return {
      ok: false,
      status: 403,
      kind: "tenant",
      body: { message: "Contexto de tenant inválido" },
    };
  }

  if (deps.assertTenantActive) {
    try {
      await deps.assertTenantActive(tenantId);
    } catch {
      return {
        ok: false,
        status: 403,
        kind: "tenant",
        body: { message: "Contexto de tenant inválido" },
      };
    }
  }

  const personRepo = createPersonRepo(deps.db);
  const membershipRepo = createMembershipRepo(deps.db);
  const person = await personRepo.findByUserId(user.id);
  if (!person) {
    return { ok: false, status: 403, kind: "membership", body: { message: "Acesso negado" } };
  }

  const memberships = await membershipRepo.findActiveForPersonTenant(person.id, tenantId);
  if (memberships.length === 0) {
    return { ok: false, status: 403, kind: "membership", body: { message: "Acesso negado" } };
  }

  return { ok: true, person, memberships, tenantId };
}

function isReadMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

/**
 * New kernel paths only. Session identifies Person; authorization reads Membership.
 * tenant_id is never taken from the client. Missing tenant or membership → 403.
 * Shared by F1 / F3 / kernel / platform — do not attach F2 `actor_required` here.
 */
export function createRequireActiveMembership(deps: KernelDeps) {
  return createMiddleware<{ Variables: KernelVariables }>(async (c, next) => {
    const resolved = await resolveMembershipGate(deps, c);
    if (!resolved.ok) return c.json(resolved.body, resolved.status);
    c.set("person", resolved.person);
    c.set("memberships", resolved.memberships);
    c.set("tenantId", resolved.tenantId);
    return next();
  });
}

/**
 * F2 only. Human mutations that would write AuditEvent: missing Person/Membership
 * → 403 `actor_required`. Reads and non-F2 slices keep generic `Acesso negado`.
 */
export function createRequireF2HumanMutationMembership(deps: KernelDeps) {
  return createMiddleware<{ Variables: KernelVariables }>(async (c, next) => {
    const resolved = await resolveMembershipGate(deps, c);
    if (!resolved.ok) {
      if (resolved.kind === "membership" && !isReadMethod(c.req.method)) {
        return c.json(
          { message: F2_ACTOR_REQUIRED_MESSAGE, code: F2_ACTOR_REQUIRED_CODE },
          403,
        );
      }
      return c.json(resolved.body, resolved.status);
    }
    c.set("person", resolved.person);
    c.set("memberships", resolved.memberships);
    c.set("tenantId", resolved.tenantId);
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

/** Registar / depositar / alocar / documentos F2 — não Fiscalizacao. */
export function createRequireFinanceManager() {
  return createMiddleware<{ Variables: KernelVariables }>(async (c, next) => {
    const memberships = c.get("memberships") ?? [];
    const allowed = memberships.some((m) => canManageFinance(String(m.roleCode)));
    if (!allowed) {
      return c.json({ message: "Acesso negado" }, 403);
    }
    return next();
  });
}

/** verify-cash: Fiscalizacao ou gestor (ADR-028 / ADR-031). */
export function createRequireCashVerifier() {
  return createMiddleware<{ Variables: KernelVariables }>(async (c, next) => {
    const memberships = c.get("memberships") ?? [];
    const allowed = memberships.some((m) => canVerifyCash(String(m.roleCode)));
    if (!allowed) {
      return c.json({ message: "Acesso negado" }, 403);
    }
    return next();
  });
}
