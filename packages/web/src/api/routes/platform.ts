import { Hono } from "hono";
import { DomainError } from "../domain/errors";
import {
  getTenantFromDirectory,
  provisionTenant,
} from "../application/platform/provision-tenant";
import type { PlatformDb } from "../platform/database";
import type { TenantDbProvisioner } from "../infra/tenant-db-provisioner";
import {
  createRequireActiveMembership,
  createRequireMembershipManager,
  type KernelVariables,
} from "../middleware/membership";
import type { KernelDeps } from "../infra/kernel-deps";

function httpError(err: unknown): { message: string; status: 400 | 403 | 404 | 409 | 500 } {
  if (err instanceof DomainError) {
    const status = err.httpStatus;
    if (status === 400 || status === 403 || status === 404 || status === 409) {
      return { message: err.message, status };
    }
  }
  console.error("[platform]", err);
  return { message: "Erro interno", status: 500 };
}

export type PlatformRoutesDeps = {
  kernel: KernelDeps;
  platformDb: PlatformDb;
  provisioner: TenantDbProvisioner;
};

/**
 * Platform routes — TenantDirectory only.
 * Authorization: active Membership with Admin/PlatformAdmin (kernel), not user.role.
 */
export function createPlatformRoutes(deps: PlatformRoutesDeps) {
  const requireMembership = createRequireActiveMembership(deps.kernel);
  const requireManager = createRequireMembershipManager();

  return new Hono<{ Variables: KernelVariables }>()
    .use(requireMembership)
    .use(requireManager)
    .get("/tenants", async (c) => {
      const { createTenantDirectoryRepo } = await import(
        "../infra/repos/tenant-directory-repo"
      );
      const entries = await createTenantDirectoryRepo(deps.platformDb).list();
      return c.json({ tenants: entries });
    })
    .get("/tenants/:tenantId", async (c) => {
      const entry = await getTenantFromDirectory(deps.platformDb, c.req.param("tenantId"));
      if (!entry) return c.json({ message: "Tenant não encontrado" }, 404);
      return c.json({ tenant: entry });
    })
    .post("/tenants", async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          tenantId?: string;
          region?: string | null;
          plan?: string | null;
        };
        if (!body.tenantId?.trim()) {
          return c.json({ message: "tenantId é obrigatório" }, 400);
        }

        const result = await provisionTenant(
          { platformDb: deps.platformDb, provisioner: deps.provisioner },
          {
            tenantId: body.tenantId,
            region: body.region ?? null,
            plan: body.plan ?? null,
          },
        );
        return c.json(result, result.created ? 201 : 200);
      } catch (err) {
        const mapped = httpError(err);
        return c.json({ message: mapped.message }, mapped.status);
      }
    });
}
