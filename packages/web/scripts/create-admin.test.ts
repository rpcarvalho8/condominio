import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { verifyPassword } from "better-auth/crypto";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { applyDomainKernelSchema } from "../src/api/infra/kernel-schema";

const AUTH_DDL = `
  CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    role TEXT NOT NULL DEFAULT 'condómino',
    fracao_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS "account" (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    password TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS "session" (
    id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
  );
`;

function childEnv(overrides: Record<string, string>, unset: string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of unset) delete env[key];
  return { ...env, NODE_ENV: "development", ...overrides };
}

async function runCreateAdmin(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", resolve(import.meta.dir, "create-admin.ts")], {
    cwd: resolve(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code, output: `${stdout}\n${stderr}` };
}

function assertUnixSeconds(value: number) {
  expect(value).toBeGreaterThan(1_000_000_000);
  expect(value).toBeLessThan(10_000_000_000);
}

describe("create-admin upsert idempotente", () => {
  test("segunda corrida mantém o user id, uma membership e timestamps em segundos", async () => {
    const dir = mkdtempSync(join(tmpdir(), "create-admin-"));
    const dbFile = join(dir, "admin.db");
    const setup = createClient({ url: `file:${dbFile}` });
    await setup.executeMultiple(AUTH_DDL);
    await applyDomainKernelSchema(setup);
    setup.close();

    const env = childEnv(
      {
        DATABASE_URL: `file:${dbFile}`,
        TENANT_ID: "tenant-test",
        ADMIN_EMAIL: "admin@condominio.local",
      },
      ["ADMIN_PASSWORD", "ALLOW_REMOTE_ADMIN_SEED", "ALLOW_ADMIN_BOOTSTRAP"],
    );

    const first = await runCreateAdmin(env);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Password: admin123");
    expect(first.stdout).toContain("Membership Admin ligada");

    const second = await runCreateAdmin(env);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("mesmo user id");
    expect(second.stdout).toContain("já activa");

    const client = createClient({ url: `file:${dbFile}` });
    const users = await client.execute(`SELECT id, created_at, updated_at FROM "user"`);
    expect(users.rows.length).toBe(1);
    assertUnixSeconds(Number(users.rows[0].created_at));
    assertUnixSeconds(Number(users.rows[0].updated_at));

    const accounts = await client.execute(`SELECT password, created_at, updated_at FROM "account"`);
    expect(accounts.rows.length).toBe(1);
    assertUnixSeconds(Number(accounts.rows[0].created_at));
    assertUnixSeconds(Number(accounts.rows[0].updated_at));
    expect(await verifyPassword({ hash: String(accounts.rows[0].password), password: "admin123" })).toBe(true);

    const persons = await client.execute(`SELECT created_at FROM persons`);
    expect(persons.rows.length).toBe(1);
    assertUnixSeconds(Number(persons.rows[0].created_at));

    const memberships = await client.execute(
      `SELECT created_at FROM memberships WHERE status = 'active' AND role_code = 'Admin'`,
    );
    expect(memberships.rows.length).toBe(1);
    assertUnixSeconds(Number(memberships.rows[0].created_at));
    client.close();
  });

  test("recusa libsql remoto sem override e não imprime a password por defeito", async () => {
    const result = await runCreateAdmin(
      childEnv(
        { DATABASE_URL: "libsql://example.turso.io" },
        ["ADMIN_PASSWORD", "ALLOW_REMOTE_ADMIN_SEED", "ALLOW_ADMIN_BOOTSTRAP"],
      ),
    );
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("ALLOW_REMOTE_ADMIN_SEED=1");
    expect(result.output).not.toContain("admin123");
    expect(result.output).not.toContain("Password:");
  });
});
