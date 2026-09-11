import { eq } from "drizzle-orm";
import {
  BACKUP_STATUS,
  MIGRATION_STATUS,
  TENANT_STATUS,
  type TenantDirectoryEntry,
} from "../../domain/tenant-directory";
import type { PlatformDb } from "../../platform/database";
import { tenantDirectory } from "../../platform/schema";

function mapRow(row: typeof tenantDirectory.$inferSelect): TenantDirectoryEntry {
  return {
    tenantId: row.tenantId,
    dbRef: row.dbRef,
    schemaVersion: row.schemaVersion,
    status: row.status,
    region: row.region ?? null,
    plan: row.plan ?? null,
    createdAt: row.createdAt,
    migrationStatus: row.migrationStatus,
    backupStatus: row.backupStatus,
    encryptionKeyRef: row.encryptionKeyRef ?? null,
  };
}

export function createTenantDirectoryRepo(db: PlatformDb) {
  return {
    async findById(tenantId: string): Promise<TenantDirectoryEntry | null> {
      const [row] = await db
        .select()
        .from(tenantDirectory)
        .where(eq(tenantDirectory.tenantId, tenantId))
        .limit(1);
      return row ? mapRow(row) : null;
    },
    async list(): Promise<TenantDirectoryEntry[]> {
      const rows = await db.select().from(tenantDirectory);
      return rows.map(mapRow);
    },
    async insert(input: {
      tenantId: string;
      dbRef: string;
      schemaVersion: string;
      status?: string;
      region?: string | null;
      plan?: string | null;
      createdAt: Date;
      migrationStatus?: string;
      backupStatus?: string;
      encryptionKeyRef?: string | null;
    }): Promise<TenantDirectoryEntry> {
      const [row] = await db
        .insert(tenantDirectory)
        .values({
          tenantId: input.tenantId,
          dbRef: input.dbRef,
          schemaVersion: input.schemaVersion,
          status: input.status ?? TENANT_STATUS.provisioning,
          region: input.region ?? null,
          plan: input.plan ?? null,
          createdAt: input.createdAt,
          migrationStatus: input.migrationStatus ?? MIGRATION_STATUS.pending,
          backupStatus: input.backupStatus ?? BACKUP_STATUS.unknown,
          encryptionKeyRef: input.encryptionKeyRef ?? null,
        })
        .returning();
      return mapRow(row!);
    },
    async update(
      tenantId: string,
      patch: Partial<{
        dbRef: string;
        schemaVersion: string;
        status: string;
        region: string | null;
        plan: string | null;
        migrationStatus: string;
        backupStatus: string;
        encryptionKeyRef: string | null;
      }>,
    ): Promise<TenantDirectoryEntry | null> {
      const [row] = await db
        .update(tenantDirectory)
        .set(patch)
        .where(eq(tenantDirectory.tenantId, tenantId))
        .returning();
      return row ? mapRow(row) : null;
    },
  };
}

export type TenantDirectoryRepo = ReturnType<typeof createTenantDirectoryRepo>;
