import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { randomBytes, scrypt } from "crypto";
import { promisify } from "util";
import {
  formatAdminCredentialReport,
  isBetterAuthPasswordHash,
  isLocalFileDatabaseUrl,
  kernelNowSeconds,
  resolveAdminBootstrap,
  WEAK_DEFAULT_ADMIN_PASSWORD,
} from "./lib/admin-bootstrap";

const scryptAsync = promisify(scrypt);

describe("admin password hashing", () => {
  test("admin123 verifica com hash better-auth (create-admin)", async () => {
    const hash = await hashPassword("admin123");
    expect(hash.includes(":")).toBe(true);
    expect(isBetterAuthPasswordHash(hash)).toBe(true);
    expect(await verifyPassword({ hash, password: "admin123" })).toBe(true);
    expect(await verifyPassword({ hash, password: "wrong" })).toBe(false);
  });

  test("hash legado setup-local (hex.salt) não autentica no better-auth", async () => {
    const salt = randomBytes(16).toString("hex");
    const buf = (await scryptAsync("admin123", salt, 64)) as Buffer;
    const legacy = `${buf.toString("hex")}.${salt}`;
    expect(isBetterAuthPasswordHash(legacy)).toBe(false);
    await expect(verifyPassword({ hash: legacy, password: "admin123" })).rejects.toThrow(
      /Invalid password hash/,
    );
  });
});

describe("create-admin bootstrap guards", () => {
  test("file: local permite password fraca por defeito", () => {
    const r = resolveAdminBootstrap({
      DATABASE_URL: "file:./local.db",
      NODE_ENV: "development",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.password).toBe(WEAK_DEFAULT_ADMIN_PASSWORD);
    expect(r.usedWeakDefaultPassword).toBe(true);
  });

  test("file: local respeita ADMIN_PASSWORD se definido", () => {
    const r = resolveAdminBootstrap({
      DATABASE_URL: "file:./local.db",
      ADMIN_PASSWORD: "strong-local",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.password).toBe("strong-local");
    expect(r.usedWeakDefaultPassword).toBe(false);
  });

  test("remoto sem ALLOW_REMOTE_ADMIN_SEED é recusado", () => {
    const r = resolveAdminBootstrap({
      DATABASE_URL: "libsql://example.turso.io",
      ADMIN_PASSWORD: "secret",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("ALLOW_REMOTE_ADMIN_SEED=1");
    expect(r.error).not.toContain(WEAK_DEFAULT_ADMIN_PASSWORD);
    expect(r.error).not.toContain("Password:");
  });

  test("remoto sem ADMIN_PASSWORD é recusado mesmo com ALLOW", () => {
    const r = resolveAdminBootstrap({
      DATABASE_URL: "libsql://example.turso.io",
      ALLOW_REMOTE_ADMIN_SEED: "1",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("ADMIN_PASSWORD");
    expect(r.error).not.toContain(WEAK_DEFAULT_ADMIN_PASSWORD);
  });

  test("remoto com ALLOW_REMOTE_ADMIN_SEED + ADMIN_PASSWORD é permitido e avisa", () => {
    const r = resolveAdminBootstrap({
      DATABASE_URL: "libsql://example.turso.io",
      ALLOW_REMOTE_ADMIN_SEED: "1",
      ADMIN_PASSWORD: "prod-secret",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.password).toBe("prod-secret");
    expect(r.usedWeakDefaultPassword).toBe(false);
    expect(r.restrictedTarget).toBe(true);
    const report = formatAdminCredentialReport({
      email: r.email,
      password: r.password,
      restrictedTarget: true,
    });
    expect(report).toContain("Password: prod-secret");
    expect(report).toContain("AVISO");
    expect(report).not.toContain(WEAK_DEFAULT_ADMIN_PASSWORD);
  });

  test("ALLOW_ADMIN_BOOTSTRAP=1 continua a autorizar o alvo remoto", () => {
    const r = resolveAdminBootstrap({
      DATABASE_URL: "libsql://example.turso.io",
      ALLOW_ADMIN_BOOTSTRAP: "1",
      ADMIN_PASSWORD: "prod-secret",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.restrictedTarget).toBe(true);
  });

  test("NODE_ENV=production em file: exige ALLOW + ADMIN_PASSWORD", () => {
    const noAllow = resolveAdminBootstrap({
      DATABASE_URL: "file:./local.db",
      NODE_ENV: "production",
      ADMIN_PASSWORD: "x",
    });
    expect(noAllow.ok).toBe(false);

    const noPass = resolveAdminBootstrap({
      DATABASE_URL: "file:./local.db",
      NODE_ENV: "production",
      ALLOW_REMOTE_ADMIN_SEED: "1",
    });
    expect(noPass.ok).toBe(false);

    const ok = resolveAdminBootstrap({
      DATABASE_URL: "file:./local.db",
      NODE_ENV: "production",
      ALLOW_REMOTE_ADMIN_SEED: "1",
      ADMIN_PASSWORD: "prod-only",
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.password).toBe("prod-only");
  });

  test("isLocalFileDatabaseUrl só aceita file:", () => {
    expect(isLocalFileDatabaseUrl("file:./local.db")).toBe(true);
    expect(isLocalFileDatabaseUrl(undefined)).toBe(true);
    expect(isLocalFileDatabaseUrl("libsql://x")).toBe(false);
    expect(isLocalFileDatabaseUrl("https://example.com")).toBe(false);
  });
});

describe("timestamp units", () => {
  test("drizzle mode timestamp (kernel e user/account) usa segundos", () => {
    const ms = 1_700_000_000_123;
    expect(kernelNowSeconds(ms)).toBe(1_700_000_000);
    expect(kernelNowSeconds(ms)).toBeLessThan(10_000_000_000);
  });
});
