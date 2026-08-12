/**
 * Cria (ou recria) utilizador admin na BD configurada em DATABASE_URL.
 * Uso (a partir de packages/web):
 *   bun --env-file=../../.env run scripts/create-admin.ts
 *
 * Credenciais por defeito (altera abaixo se quiseres):
 *   admin@condominio.local / admin123
 */

import { createClient } from "@libsql/client";
import { hashPassword } from "better-auth/crypto";
import { resolve } from "path";

const EMAIL = process.env.ADMIN_EMAIL ?? "admin@condominio.local";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "admin123";
const NAME = process.env.ADMIN_NAME ?? "Administrador";

function resolveDbUrl(raw: string | undefined): string {
  const url = raw?.trim() || "file:./local.db";
  if (!url.startsWith("file:")) return url;
  const pathPart = url.slice("file:".length);
  // Paths relativos → relativos a packages/web (cwd típico deste script)
  if (pathPart.startsWith("./") || pathPart.startsWith("../") || !pathPart.startsWith("/")) {
    return `file:${resolve(process.cwd(), pathPart)}`;
  }
  return url;
}

const DB_URL = resolveDbUrl(process.env.DATABASE_URL);
const client = createClient({
  url: DB_URL,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

async function main() {
  console.log(`DB: ${DB_URL.startsWith("file:") ? DB_URL : "[remote]"}`);

  await client.execute({
    sql: `DELETE FROM "account" WHERE user_id IN (SELECT id FROM "user" WHERE email = ?)`,
    args: [EMAIL],
  });
  await client.execute({
    sql: `DELETE FROM "session" WHERE user_id IN (SELECT id FROM "user" WHERE email = ?)`,
    args: [EMAIL],
  });
  await client.execute({
    sql: `DELETE FROM "user" WHERE email = ?`,
    args: [EMAIL],
  });

  const now = Date.now();
  const userId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const hashedPw = await hashPassword(PASSWORD);

  await client.execute({
    sql: `INSERT INTO "user" (id, name, email, email_verified, role, fracao_id, created_at, updated_at)
          VALUES (?, ?, ?, 1, 'admin', NULL, ?, ?)`,
    args: [userId, NAME, EMAIL, now, now],
  });

  await client.execute({
    sql: `INSERT INTO "account" (id, account_id, provider_id, user_id, password, created_at, updated_at)
          VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
    args: [accountId, userId, userId, hashedPw, now, now],
  });

  console.log("✅ Admin criado/reposto com sucesso!");
  console.log(`   Email:    ${EMAIL}`);
  console.log(`   Password: ${PASSWORD}`);
  console.log("   Abre http://localhost:4200 e faz login com estas credenciais.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
