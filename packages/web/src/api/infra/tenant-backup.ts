import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import type { PlatformDb } from "../platform/database";
import { createTenantDirectoryRepo } from "./repos/tenant-directory-repo";
import { DomainError } from "../domain/errors";

function filePathFromDbRef(dbRef: string): string | null {
  if (!dbRef.startsWith("file:")) return null;
  return dbRef.slice("file:".length);
}

/**
 * F0 property 7 — backup + restore of one tenant DB (file-backed).
 */
export async function backupTenantDatabase(
  platformDb: PlatformDb,
  tenantId: string,
  backupDir: string,
): Promise<{ backupPath: string }> {
  const entry = await createTenantDirectoryRepo(platformDb).findById(tenantId);
  if (!entry) throw new DomainError("tenant_not_found", "Tenant não encontrado", 404);
  const src = filePathFromDbRef(entry.dbRef);
  if (!src || !fs.existsSync(src)) {
    throw new DomainError("backup_unsupported", "Backup só suportado para db_ref file:", 400);
  }
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${tenantId}.bak.db`);
  fs.copyFileSync(src, backupPath);
  return { backupPath };
}

export async function restoreTenantDatabase(
  platformDb: PlatformDb,
  tenantId: string,
  backupPath: string,
): Promise<{ restoredPath: string }> {
  const entry = await createTenantDirectoryRepo(platformDb).findById(tenantId);
  if (!entry) throw new DomainError("tenant_not_found", "Tenant não encontrado", 404);
  const dest = filePathFromDbRef(entry.dbRef);
  if (!dest) {
    throw new DomainError("restore_unsupported", "Restore só suportado para db_ref file:", 400);
  }
  if (!fs.existsSync(backupPath)) {
    throw new DomainError("backup_missing", "Ficheiro de backup em falta", 404);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(backupPath, dest);

  // Smoke: open restored DB
  const client = createClient({ url: `file:${dest}` });
  try {
    await client.execute("SELECT 1 AS ok");
  } finally {
    client.close();
  }
  return { restoredPath: dest };
}
