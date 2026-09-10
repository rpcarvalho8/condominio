import { DomainError } from "../../domain/errors";
import {
  BACKUP_STATUS,
  KERNEL_SCHEMA_VERSION,
  MIGRATION_STATUS,
  TENANT_STATUS,
  type TenantDirectoryEntry,
} from "../../domain/tenant-directory";
import type { PlatformDb } from "../../platform/database";
import { createTenantDirectoryRepo } from "../../infra/repos/tenant-directory-repo";
import type { TenantDbProvisioner } from "../../infra/tenant-db-provisioner";

export type ProvisionTenantDeps = {
  platformDb: PlatformDb;
  provisioner: TenantDbProvisioner;
  now?: () => Date;
};

export type ProvisionTenantInput = {
  tenantId: string;
  region?: string | null;
  plan?: string | null;
  /** When registering an existing DB, skip physical create if already listed. */
  forceReprovision?: boolean;
};

export type ProvisionTenantResult = {
  entry: TenantDirectoryEntry;
  created: boolean;
};

/**
 * Idempotent tenant provisioning (ADR-016 / F0-B).
 * Second call with the same tenantId returns the existing directory row
 * without creating another database.
 */
export async function provisionTenant(
  deps: ProvisionTenantDeps,
  input: ProvisionTenantInput,
): Promise<ProvisionTenantResult> {
  const tenantId = String(input.tenantId ?? "").trim();
  if (!tenantId) {
    throw new DomainError("tenant_id_required", "tenant_id é obrigatório", 400);
  }

  const repo = createTenantDirectoryRepo(deps.platformDb);
  const existing = await repo.findById(tenantId);
  if (existing && !input.forceReprovision) {
    return { entry: existing, created: false };
  }

  const now = deps.now ? deps.now() : new Date();
  const provisioned = await deps.provisioner.provision(tenantId);

  if (existing) {
    const updated = await repo.update(tenantId, {
      dbRef: provisioned.dbRef,
      schemaVersion: KERNEL_SCHEMA_VERSION,
      status: TENANT_STATUS.active,
      region: input.region ?? existing.region,
      plan: input.plan ?? existing.plan,
      migrationStatus: MIGRATION_STATUS.current,
      backupStatus: BACKUP_STATUS.unknown,
    });
    provisioned.client.close();
    return { entry: updated!, created: false };
  }

  const entry = await repo.insert({
    tenantId,
    dbRef: provisioned.dbRef,
    schemaVersion: KERNEL_SCHEMA_VERSION,
    status: TENANT_STATUS.active,
    region: input.region ?? null,
    plan: input.plan ?? null,
    createdAt: now,
    migrationStatus: MIGRATION_STATUS.current,
    backupStatus: BACKUP_STATUS.unknown,
  });
  provisioned.client.close();
  return { entry, created: true };
}

export async function getTenantFromDirectory(
  platformDb: PlatformDb,
  tenantId: string,
): Promise<TenantDirectoryEntry | null> {
  const id = String(tenantId ?? "").trim();
  if (!id) return null;
  return createTenantDirectoryRepo(platformDb).findById(id);
}

export async function requireActiveTenant(
  platformDb: PlatformDb,
  tenantId: string,
): Promise<TenantDirectoryEntry> {
  const entry = await getTenantFromDirectory(platformDb, tenantId);
  if (!entry || entry.status !== TENANT_STATUS.active) {
    throw new DomainError("tenant_invalid", "Contexto de tenant inválido", 403);
  }
  return entry;
}
