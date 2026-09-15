/**
 * TenantDirectory — registo de plataforma (ADR-016).
 * Fora de qualquer BD de tenant.
 *
 * `tenant_id` is canonical (`parseCanonicalTenantId` in `tenant-id.ts`):
 * `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` without `..`. Rejected at creation so
 * local/S3 storage namespaces stay injective (identity, no `_` rewrite).
 */

export const TENANT_STATUS = {
  provisioning: "provisioning",
  active: "active",
  suspended: "suspended",
  archived: "archived",
} as const;

export type TenantStatus = (typeof TENANT_STATUS)[keyof typeof TENANT_STATUS];

export const MIGRATION_STATUS = {
  pending: "pending",
  current: "current",
  failed: "failed",
} as const;

export type MigrationStatus = (typeof MIGRATION_STATUS)[keyof typeof MIGRATION_STATUS];

export const BACKUP_STATUS = {
  unknown: "unknown",
  ok: "ok",
  stale: "stale",
  failed: "failed",
} as const;

export type BackupStatus = (typeof BACKUP_STATUS)[keyof typeof BACKUP_STATUS];

export type TenantDirectoryEntry = {
  tenantId: string;
  dbRef: string;
  schemaVersion: string;
  status: TenantStatus | string;
  region: string | null;
  plan: string | null;
  createdAt: Date;
  migrationStatus: MigrationStatus | string;
  backupStatus: BackupStatus | string;
  encryptionKeyRef: string | null;
};

/** Schema alvo após F0 + F1 (constituição). */
export const KERNEL_SCHEMA_VERSION = "f1-constitution-v1";

export function isActiveTenant(entry: Pick<TenantDirectoryEntry, "status">): boolean {
  return entry.status === TENANT_STATUS.active;
}
