/**
 * Backup / restore de um tenant (F0 property 7).
 *
 *   bun run scripts/backup-restore-tenant.ts backup <tenantId> [dir]
 *   bun run scripts/backup-restore-tenant.ts restore <tenantId> <backupPath>
 */

import { applyPlatformSchema } from "../src/api/platform/apply-schema";
import {
  createPlatformClient,
  createPlatformDb,
  resolvePlatformDatabaseUrl,
} from "../src/api/platform/database";
import {
  backupTenantDatabase,
  restoreTenantDatabase,
} from "../src/api/infra/tenant-backup";

async function main() {
  const [cmd, tenantId, arg3] = process.argv.slice(2);
  if (!cmd || !tenantId) {
    console.error(
      "Uso: backup-restore-tenant.ts backup <tenantId> [dir] | restore <tenantId> <backupPath>",
    );
    process.exit(1);
  }
  const client = createPlatformClient(resolvePlatformDatabaseUrl());
  await applyPlatformSchema(client);
  const platformDb = createPlatformDb(client);

  if (cmd === "backup") {
    const dir = arg3 || "./data/backups";
    const { backupPath } = await backupTenantDatabase(platformDb, tenantId, dir);
    console.log(`[backup] ${backupPath}`);
  } else if (cmd === "restore") {
    if (!arg3) {
      console.error("restore exige <backupPath>");
      process.exit(1);
    }
    const { restoredPath } = await restoreTenantDatabase(platformDb, tenantId, arg3);
    console.log(`[restore] ${restoredPath}`);
  } else {
    console.error(`comando desconhecido: ${cmd}`);
    process.exit(1);
  }
  client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
