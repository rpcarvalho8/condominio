import { Hono } from "hono";
import { createMembership } from "../application/identity/create-membership";
import { revokeMembership } from "../application/identity/revoke-membership";
import { DomainError } from "../domain/errors";
import { db } from "../database";
import { getKernelTenantId } from "../lib/tenant";
import type { KernelDeps } from "../infra/kernel-deps";
import {
  createRequireActiveMembership,
  createRequireMembershipManager,
  type KernelVariables,
} from "../middleware/membership";

function requestIdFrom(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header("x-request-id")?.trim() || crypto.randomUUID();
}

function httpError(err: unknown): { message: string; status: 400 | 403 | 404 | 409 | 500 } {
  if (err instanceof DomainError) {
    const status = err.httpStatus;
    if (status === 400 || status === 403 || status === 404 || status === 409) {
      return { message: err.message, status };
    }
  }
  console.error("[kernel]", err);
  return { message: "Erro interno", status: 500 };
}

export function createKernelRoutes(deps: KernelDeps) {
  const requireMembership = createRequireActiveMembership(deps);
  const requireManager = createRequireMembershipManager();

  return new Hono<{ Variables: KernelVariables }>()
    .use(requireMembership)
    .get("/me", (c) => {
      return c.json({
        tenantId: c.get("tenantId"),
        person: c.get("person"),
        memberships: c.get("memberships"),
      });
    })
    .post("/memberships", requireManager, async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          personId?: string;
          userId?: string;
          person?: { name: string; email: string; nif?: string | null; phone?: string | null };
          roleCode?: string;
          fracaoId?: string | null;
          scope?: string | null;
          reason?: string | null;
        };
        if (!body.roleCode) {
          return c.json({ message: "roleCode é obrigatório" }, 400);
        }
        const person = c.get("person");
        const user = c.get("user");
        const result = await createMembership(deps, {
          tenantId: c.get("tenantId")!,
          roleCode: body.roleCode,
          fracaoId: body.fracaoId ?? null,
          scope: body.scope ?? null,
          reason: body.reason ?? null,
          personId: body.personId,
          userId: body.userId,
          person: body.person,
          actor: {
            personId: person?.id ?? null,
            userId: user?.id ?? null,
            source: "http",
            requestId: requestIdFrom(c),
          },
        });
        return c.json(result, 201);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    })
    .post("/memberships/:id/revoke", requireManager, async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as { reason?: string | null };
        const person = c.get("person");
        const user = c.get("user");
        const membership = await revokeMembership(deps, {
          membershipId: c.req.param("id"),
          tenantId: c.get("tenantId")!,
          reason: body.reason ?? null,
          actor: {
            personId: person?.id ?? null,
            userId: user?.id ?? null,
            source: "http",
            requestId: requestIdFrom(c),
          },
        });
        return c.json({ membership });
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    });
}

export const kernelRoutes = createKernelRoutes({
  db: db as KernelDeps["db"],
  getTenantId: getKernelTenantId,
});
