/**
 * Cria ou repõe o admin na BD de DATABASE_URL **sem** apagar o user
 * (apagar quebrava Person/Membership e podia falhar por FK).
 *
 * Uso (a partir de packages/web):
 *   bun --env-file=../../.env run scripts/create-admin.ts
 *
 * Credenciais por defeito:
 *   admin@condominio.local / admin123
 */

import { createClient } from "@libsql/client";
import { hashPassword } from "better-auth/crypto";
import { resolve } from "path";
import { CONDOMINIO } from "../src/api/lib/condominio";

const EMAIL = process.env.ADMIN_EMAIL ?? "admin@condominio.local";
const PASSWORD = process.env.ADMIN_PASSWORD ?? "admin123";
const NAME = process.env.ADMIN_NAME ?? "Administrador";

function resolveDbUrl(raw: string | undefined): string {
  const url = raw?.trim() || "file:./local.db";
  if (!url.startsWith("file:")) return url;
  const pathPart = url.slice("file:".length);
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

async function tableExists(name: string): Promise<boolean> {
  const rows = await client.execute({
    sql: `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    args: [name],
  });
  return rows.rows.length > 0;
}

async function ensureKernelAdmin(userId: string): Promise<void> {
  if (!(await tableExists("persons")) || !(await tableExists("memberships")) || !(await tableExists("roles"))) {
    console.log("ℹ️  Schema kernel ainda não está nesta BD — corre `bun run db:migrate:kernel` e volta a correr este script.");
    return;
  }

  const tenantId = String(process.env.TENANT_ID ?? "").trim() || CONDOMINIO.nif;
  const now = Date.now();

  const byUser = await client.execute({
    sql: "SELECT id FROM persons WHERE user_id = ? LIMIT 1",
    args: [userId],
  });
  let personId = byUser.rows[0] ? String((byUser.rows[0] as { id: string }).id) : null;

  if (!personId) {
    const byEmail = await client.execute({
      sql: "SELECT id FROM persons WHERE email = ? LIMIT 1",
      args: [EMAIL],
    });
    if (byEmail.rows[0]) {
      personId = String((byEmail.rows[0] as { id: string }).id);
      await client.execute({
        sql: "UPDATE persons SET user_id = ?, name = ?, updated_at = ? WHERE id = ?",
        args: [userId, NAME, now, personId],
      });
    }
  }

  if (!personId) {
    personId = crypto.randomUUID();
    await client.execute({
      sql: `INSERT INTO persons (id, user_id, name, email, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [personId, userId, NAME, EMAIL, now, now],
    });
  }

  const existingMem = await client.execute({
    sql: `SELECT id FROM memberships
          WHERE person_id = ? AND tenant_id = ? AND status = 'active' AND role_code = 'Admin'
          LIMIT 1`,
    args: [personId, tenantId],
  });
  if (existingMem.rows.length === 0) {
    await client.execute({
      sql: `INSERT INTO memberships (id, person_id, tenant_id, role_code, status, created_at, created_by_person_id)
            VALUES (?, ?, ?, 'Admin', 'active', ?, ?)`,
      args: [crypto.randomUUID(), personId, tenantId, now, personId],
    });
    console.log(`✅ Membership Admin ligada (tenant ${tenantId})`);
  } else {
    console.log(`ℹ️  Membership Admin já activa (tenant ${tenantId})`);
  }
}

async function main() {
  console.log(`DB: ${DB_URL.startsWith("file:") ? DB_URL : "[remote]"}`);

  const hashedPw = await hashPassword(PASSWORD);
  const now = Date.now();

  const existing = await client.execute({
    sql: `SELECT id FROM "user" WHERE email = ? LIMIT 1`,
    args: [EMAIL],
  });

  let userId: string;
  if (existing.rows[0]) {
    userId = String((existing.rows[0] as { id: string }).id);
    await client.execute({
      sql: `UPDATE "user" SET name = ?, email_verified = 1, role = 'admin', updated_at = ? WHERE id = ?`,
      args: [NAME, now, userId],
    });

    const account = await client.execute({
      sql: `SELECT id FROM "account" WHERE user_id = ? AND provider_id = 'credential' LIMIT 1`,
      args: [userId],
    });
    if (account.rows[0]) {
      await client.execute({
        sql: `UPDATE "account" SET password = ?, updated_at = ? WHERE id = ?`,
        args: [hashedPw, now, String((account.rows[0] as { id: string }).id)],
      });
    } else {
      await client.execute({
        sql: `INSERT INTO "account" (id, account_id, provider_id, user_id, password, created_at, updated_at)
              VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
        args: [crypto.randomUUID(), userId, userId, hashedPw, now, now],
      });
    }

    await client.execute({
      sql: `DELETE FROM "session" WHERE user_id = ?`,
      args: [userId],
    });
    console.log("✅ Admin existente: password e role=admin repostos (mesmo user id).");
  } else {
    userId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
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
    console.log("✅ Admin criado.");
  }

  await ensureKernelAdmin(userId);

  console.log(`   Email:    ${EMAIL}`);
  console.log(`   Password: ${PASSWORD}`);
  console.log("   Abre http://localhost:4200/login com estas credenciais.");
  console.log("   Confirma que WEBSITE_URL no .env é exactamente a origem que usas no browser.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
