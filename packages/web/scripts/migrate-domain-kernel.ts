/**
 * Aplica migration 0002 (Domain Kernel v0.1) de forma segura.
 *
 * Uso:
 *   cd packages/web && bun --env-file=../../.env run scripts/migrate-domain-kernel.ts
 */

import { createClient } from "@libsql/client";
import { applyDomainKernelSchema } from "../src/api/infra/kernel-schema";
import { applyF1ConstitutionSchema } from "../src/api/infra/f1-schema";
import { applyF2FinanceSchema } from "../src/api/infra/f2-schema";

const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN;

if (!DATABASE_URL) {
  console.error("[migrate-kernel] DATABASE_URL em falta.");
  process.exit(1);
}

const client = createClient({
  url: DATABASE_URL,
  authToken: DATABASE_AUTH_TOKEN,
});

async function main() {
  console.log(`[migrate-kernel] BD: ${DATABASE_URL}`);
  await applyDomainKernelSchema(client);
  await applyF1ConstitutionSchema(client);
  console.log("[migrate-kernel] F1 constitution schema aplicado.");
  await applyF2FinanceSchema(client);
  console.log("[migrate-kernel] F2 finance schema aplicado.");
  const roles = await client.execute("SELECT code FROM roles ORDER BY code");
  console.log(
    "[migrate-kernel] roles:",
    roles.rows.map((r) => r.code).join(", "),
  );
  console.log("[migrate-kernel] concluído.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
