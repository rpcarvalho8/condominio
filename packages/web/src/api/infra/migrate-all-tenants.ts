import type { PlatformDb } from "../platform/database";
import { createTenantDirectoryRepo } from "./repos/tenant-directory-repo";
import { createClient } from "@libsql/client";
import { applyDomainKernelSchema } from "./kernel-schema";
import { applyF1ConstitutionSchema } from "./f1-schema";
import { KERNEL_SCHEMA_VERSION, MIGRATION_STATUS } from "../domain/tenant-directory";

async function applyKernelAndF1(client: { execute: (sql: string) => Promise<unknown> }) {
  await applyDomainKernelSchema(client);
  await applyF1ConstitutionSchema(client);
}

export type TenantMigrationResult = {
  tenantId: string;
  ok: boolean;
  error?: string;
  schemaVersion?: string;
};

/**
 * F0 property 6 — migrate N tenants independently; failures reported per tenant.
 */
export async function migrateAllTenants(
  platformDb: PlatformDb,
  opts?: {
    applySchema?: (client: { execute: (sql: string) => Promise<unknown> }) => Promise<void>;
    targetVersion?: string;
  },
): Promise<{ results: TenantMigrationResult[]; okCount: number; failCount: number }> {
  const apply = opts?.applySchema ?? applyKernelAndF1;
  const targetVersion = opts?.targetVersion ?? KERNEL_SCHEMA_VERSION;
  const repo = createTenantDirectoryRepo(platformDb);
  const tenants = await repo.list();
  const results: TenantMigrationResult[] = [];

  for (const tenant of tenants) {
    try {
      const client = createClient({
        url: tenant.dbRef,
        authToken: process.env.DATABASE_AUTH_TOKEN,
      });
      try {
        await apply(client);
      } finally {
        client.close();
      }
      await repo.update(tenant.tenantId, {
        schemaVersion: targetVersion,
        migrationStatus: MIGRATION_STATUS.current,
      });
      results.push({ tenantId: tenant.tenantId, ok: true, schemaVersion: targetVersion });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await repo.update(tenant.tenantId, {
        migrationStatus: MIGRATION_STATUS.failed,
      });
      results.push({ tenantId: tenant.tenantId, ok: false, error: message });
    }
  }

  return {
    results,
    okCount: results.filter((r) => r.ok).length,
    failCount: results.filter((r) => !r.ok).length,
  };
}
