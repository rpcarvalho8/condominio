/**
 * Migra schema kernel em todos os tenants do TenantDirectory.
 *
 *   cd packages/web && bun --env-file=../../.env run scripts/migrate-all-tenants.ts
 */

import { applyPlatformSchema } from "../src/api/platform/apply-schema";
import {
  createPlatformClient,
  createPlatformDb,
  resolvePlatformDatabaseUrl,
} from "../src/api/platform/database";
import { migrateAllTenants } from "../src/api/infra/migrate-all-tenants";

async function main() {
  const platformUrl = resolvePlatformDatabaseUrl();
  console.log(`[migrate-all] platform: ${platformUrl}`);
  const client = createPlatformClient(platformUrl);
  await applyPlatformSchema(client);
  const platformDb = createPlatformDb(client);
  const result = await migrateAllTenants(platformDb);
  for (const r of result.results) {
    if (r.ok) console.log(`[ok] ${r.tenantId} → ${r.schemaVersion}`);
    else console.error(`[fail] ${r.tenantId} → ${r.error}`);
  }
  console.log(`[migrate-all] ok=${result.okCount} fail=${result.failCount}`);
  client.close();
  if (result.failCount > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
