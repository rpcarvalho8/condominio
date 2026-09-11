/**
 * Aplica schema da platform DB (TenantDirectory) e regista o tenant Fonte.
 * Opcionalmente provisiona um segundo DB de teste (idempotente).
 *
 * Uso:
 *   cd packages/web && bun --env-file=../../.env run scripts/migrate-tenant-directory.ts
 *
 * Env:
 *   PLATFORM_DATABASE_URL   — default file:./platform.db
 *   DATABASE_URL            — registado como db_ref do tenant Fonte
 *   TENANT_ID               — id do tenant Fonte (fallback NIF)
 *   PROVISION_TEST_TENANT=1 — cria segundo tenant de teste
 *   TEST_TENANT_ID          — default lumen-test-tenant
 */

import fs from "node:fs";
import path from "node:path";
import { applyPlatformSchema } from "../src/api/platform/apply-schema";
import {
  createPlatformClient,
  createPlatformDb,
  resolvePlatformDatabaseUrl,
} from "../src/api/platform/database";
import { provisionTenant } from "../src/api/application/platform/provision-tenant";
import {
  createExistingDbProvisioner,
  createLocalFileTenantProvisioner,
} from "../src/api/infra/tenant-db-provisioner";
import { CONDOMINIO } from "../src/api/lib/condominio";
import { createTenantDirectoryRepo } from "../src/api/infra/repos/tenant-directory-repo";

const platformUrl = resolvePlatformDatabaseUrl();
const fonteDbUrl = String(process.env.DATABASE_URL ?? "").trim();
const fonteTenantId =
  String(process.env.TENANT_ID ?? "").trim() || CONDOMINIO.nif;
const provisionTest = String(process.env.PROVISION_TEST_TENANT ?? "").trim() === "1";
const testTenantId =
  String(process.env.TEST_TENANT_ID ?? "").trim() || "lumen-test-tenant";

async function main() {
  console.log(`[migrate-platform] platform: ${platformUrl}`);
  const client = createPlatformClient(platformUrl);
  await applyPlatformSchema(client);
  const platformDb = createPlatformDb(client);

  if (fonteDbUrl) {
    const result = await provisionTenant(
      {
        platformDb,
        provisioner: createExistingDbProvisioner(fonteDbUrl),
      },
      {
        tenantId: fonteTenantId,
        region: "eu",
        plan: "pilot",
      },
    );
    console.log(
      `[migrate-platform] Fonte tenant ${fonteTenantId}: ${
        result.created ? "created" : "exists"
      } → ${result.entry.dbRef}`,
    );
  } else {
    console.log("[migrate-platform] DATABASE_URL em falta — Fonte não registada.");
  }

  if (provisionTest) {
    const root =
      String(process.env.TENANT_DB_ROOT ?? "").trim() ||
      path.join(process.cwd(), "data", "tenants");
    fs.mkdirSync(root, { recursive: true });
    const result = await provisionTenant(
      {
        platformDb,
        provisioner: createLocalFileTenantProvisioner({ rootDir: root }),
      },
      {
        tenantId: testTenantId,
        region: "eu",
        plan: "test",
      },
    );
    console.log(
      `[migrate-platform] test tenant ${testTenantId}: ${
        result.created ? "created" : "exists"
      } → ${result.entry.dbRef}`,
    );
  }

  const all = await createTenantDirectoryRepo(platformDb).list();
  console.log(
    `[migrate-platform] directory (${all.length}):`,
    all.map((t) => `${t.tenantId}[${t.status}]`).join(", "),
  );
  client.close();
  console.log("[migrate-platform] concluído.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
