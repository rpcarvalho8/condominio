import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Platform DB schema — never colocated with tenant business data (ADR-016).
 */
export const tenantDirectory = sqliteTable(
  "tenant_directory",
  {
    tenantId: text("tenant_id").primaryKey(),
    dbRef: text("db_ref").notNull(),
    schemaVersion: text("schema_version").notNull(),
    status: text("status").notNull().default("provisioning"),
    region: text("region"),
    plan: text("plan"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    migrationStatus: text("migration_status").notNull().default("pending"),
    backupStatus: text("backup_status").notNull().default("unknown"),
    encryptionKeyRef: text("encryption_key_ref"),
  },
  (t) => ({
    statusIdx: index("tenant_directory_status_idx").on(t.status),
    dbRefUq: index("tenant_directory_db_ref_idx").on(t.dbRef),
  }),
);

export const platformSchema = { tenantDirectory };
