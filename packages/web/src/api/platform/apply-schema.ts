export type SqlExecutor = {
  execute: (sql: string) => Promise<unknown>;
};

function isAlreadyExists(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return (
    msg.includes("duplicate column") ||
    msg.includes("already exists") ||
    msg.includes("duplicate column name")
  );
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS tenant_directory (
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
  )`,
  `CREATE INDEX IF NOT EXISTS tenant_directory_status_idx ON tenant_directory (status)`,
  `CREATE INDEX IF NOT EXISTS tenant_directory_db_ref_idx ON tenant_directory (db_ref)`,
];

async function execSafe(client: SqlExecutor, stmt: string): Promise<void> {
  try {
    await client.execute(stmt);
  } catch (e) {
    if (isAlreadyExists(e)) return;
    throw e;
  }
}

export async function applyPlatformSchema(client: SqlExecutor): Promise<void> {
  for (const stmt of DDL) {
    await execSafe(client, stmt);
  }
}
