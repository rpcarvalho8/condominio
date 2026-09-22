/**
 * Guards for scripts that create/reset the admin credential.
 * Weak default password is only allowed on local file: databases outside production.
 */

export const DEFAULT_ADMIN_EMAIL = "admin@condominio.local";
export const DEFAULT_ADMIN_NAME = "Administrador";
export const WEAK_DEFAULT_ADMIN_PASSWORD = "admin123";

export type AdminBootstrapEnv = {
  DATABASE_URL?: string;
  NODE_ENV?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_NAME?: string;
  ALLOW_ADMIN_BOOTSTRAP?: string;
};

export type AdminBootstrapOk = {
  ok: true;
  email: string;
  password: string;
  name: string;
  dbUrl: string;
  usedWeakDefaultPassword: boolean;
};

export type AdminBootstrapErr = {
  ok: false;
  error: string;
};

export type AdminBootstrapResult = AdminBootstrapOk | AdminBootstrapErr;

/** True when DATABASE_URL points at a local SQLite file (not libsql/http/remote). */
export function isLocalFileDatabaseUrl(raw: string | undefined): boolean {
  const url = (raw?.trim() || "file:./local.db").toLowerCase();
  return url.startsWith("file:");
}

/**
 * Decide whether create-admin may run, and which password to use.
 * - Local file: DB + non-production: weak default admin123 is allowed if ADMIN_PASSWORD unset.
 * - Remote URL or NODE_ENV=production: require ADMIN_PASSWORD (no weak default)
 *   AND ALLOW_ADMIN_BOOTSTRAP=1.
 */
export function resolveAdminBootstrap(env: AdminBootstrapEnv = {}): AdminBootstrapResult {
  const dbUrl = env.DATABASE_URL?.trim() || "file:./local.db";
  const email = env.ADMIN_EMAIL?.trim() || DEFAULT_ADMIN_EMAIL;
  const name = env.ADMIN_NAME?.trim() || DEFAULT_ADMIN_NAME;
  const localFile = isLocalFileDatabaseUrl(dbUrl);
  const production = (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
  const allowBootstrap = (env.ALLOW_ADMIN_BOOTSTRAP ?? "").trim() === "1";
  const passwordSet = typeof env.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD.length > 0;

  if (!localFile || production) {
    if (!allowBootstrap) {
      return {
        ok: false,
        error:
          "Recusado: create-admin em BD remota ou NODE_ENV=production exige ALLOW_ADMIN_BOOTSTRAP=1. " +
          "Isto evita repor silenciosamente o admin com a password fraca por defeito.",
      };
    }
    if (!passwordSet) {
      return {
        ok: false,
        error:
          "Recusado: em BD remota ou NODE_ENV=production define ADMIN_PASSWORD explicitamente " +
          "(não há password fraca por defeito).",
      };
    }
    return {
      ok: true,
      email,
      password: env.ADMIN_PASSWORD as string,
      name,
      dbUrl,
      usedWeakDefaultPassword: false,
    };
  }

  return {
    ok: true,
    email,
    password: passwordSet ? (env.ADMIN_PASSWORD as string) : WEAK_DEFAULT_ADMIN_PASSWORD,
    name,
    dbUrl,
    usedWeakDefaultPassword: !passwordSet,
  };
}

/** Seconds for Drizzle `mode: "timestamp"` / kernel persons & memberships. */
export function kernelNowSeconds(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000);
}

/** Milliseconds — matches existing better-auth user/account rows written with Date.now(). */
export function authNowMs(nowMs = Date.now()): number {
  return nowMs;
}

/** better-auth stores scrypt as `salt:key`; legacy setup used `hex.salt`. */
export function isBetterAuthPasswordHash(hash: string | null | undefined): boolean {
  if (!hash || typeof hash !== "string") return false;
  const colon = hash.indexOf(":");
  if (colon <= 0 || colon === hash.length - 1) return false;
  // Legacy format used a single '.' between hex digest and salt.
  if (!hash.includes(":") && hash.includes(".")) return false;
  return hash.includes(":");
}
