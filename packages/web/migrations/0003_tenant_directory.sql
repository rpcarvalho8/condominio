-- Migration 0003: TenantDirectory (platform DB)
-- Aplicar via: bun run scripts/migrate-tenant-directory.ts
-- Corre na PLATFORM_DATABASE_URL (fora das BDs de tenant).

CREATE TABLE IF NOT EXISTS tenant_directory (
  tenant_id TEXT PRIMARY KEY NOT NULL,
  db_ref TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning',
  region TEXT,
  plan TEXT,
  created_at INTEGER NOT NULL,
  migration_status TEXT NOT NULL DEFAULT 'pending',
  backup_status TEXT NOT NULL DEFAULT 'unknown',
  encryption_key_ref TEXT
);

CREATE INDEX IF NOT EXISTS tenant_directory_status_idx ON tenant_directory (status);
CREATE INDEX IF NOT EXISTS tenant_directory_db_ref_idx ON tenant_directory (db_ref);
