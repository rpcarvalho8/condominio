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
  /** Override explícito para BD remota ou NODE_ENV=production. */
  ALLOW_REMOTE_ADMIN_SEED?: string;
  /** Alias antigo de ALLOW_REMOTE_ADMIN_SEED. */
  ALLOW_ADMIN_BOOTSTRAP?: string;
};

export type AdminBootstrapOk = {
  ok: true;
  email: string;
  password: string;
  name: string;
  dbUrl: string;
  usedWeakDefaultPassword: boolean;
  /** BD remota ou NODE_ENV=production — a seed só chega aqui com override explícito. */
  restrictedTarget: boolean;
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
 * - Local file: DB + non-production: weak default is allowed if ADMIN_PASSWORD unset.
 * - Remote URL or NODE_ENV=production: require ADMIN_PASSWORD (no weak default)
 *   AND ALLOW_REMOTE_ADMIN_SEED=1 (ALLOW_ADMIN_BOOTSTRAP=1 ainda é aceite).
 */
export function remoteAdminSeedExplicitlyAllowed(env: AdminBootstrapEnv): boolean {
  return (
    (env.ALLOW_REMOTE_ADMIN_SEED ?? "").trim() === "1" ||
    (env.ALLOW_ADMIN_BOOTSTRAP ?? "").trim() === "1"
  );
}

export function resolveAdminBootstrap(env: AdminBootstrapEnv = {}): AdminBootstrapResult {
  const dbUrl = env.DATABASE_URL?.trim() || "file:./local.db";
  const email = env.ADMIN_EMAIL?.trim() || DEFAULT_ADMIN_EMAIL;
  const name = env.ADMIN_NAME?.trim() || DEFAULT_ADMIN_NAME;
  const localFile = isLocalFileDatabaseUrl(dbUrl);
  const production = (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
  const allowBootstrap = remoteAdminSeedExplicitlyAllowed(env);
  const passwordSet = typeof env.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD.length > 0;
  const restrictedTarget = !localFile || production;

  if (restrictedTarget) {
    if (!allowBootstrap) {
      return {
        ok: false,
        error:
          "Recusado: create-admin em BD remota ou NODE_ENV=production exige ALLOW_REMOTE_ADMIN_SEED=1. " +
          "Não é sugerida nenhuma password por defeito para este alvo.",
      };
    }
    if (!passwordSet) {
      return {
        ok: false,
        error:
          "Recusado: em BD remota ou NODE_ENV=production define ADMIN_PASSWORD explicitamente. " +
          "Não há password por defeito neste alvo.",
      };
    }
    return {
      ok: true,
      email,
      password: env.ADMIN_PASSWORD as string,
      name,
      dbUrl,
      usedWeakDefaultPassword: false,
      restrictedTarget: true,
    };
  }

  return {
    ok: true,
    email,
    password: passwordSet ? (env.ADMIN_PASSWORD as string) : WEAK_DEFAULT_ADMIN_PASSWORD,
    name,
    dbUrl,
    usedWeakDefaultPassword: !passwordSet,
    restrictedTarget: false,
  };
}

/**
 * Linhas de stdout depois de uma seed autorizada.
 * A password só entra aqui — o caminho de recusa não chama esta função.
 */
export function formatAdminCredentialReport(opts: {
  email: string;
  password: string;
  restrictedTarget: boolean;
}): string {
  const lines = [`   Email:    ${opts.email}`, `   Password: ${opts.password}`];
  if (opts.restrictedTarget) {
    lines.push(
      "   AVISO: password impressa porque ALLOW_REMOTE_ADMIN_SEED=1 autorizou uma base remota ou produção. Não reutilizes credenciais de desenvolvimento.",
    );
  } else {
    lines.push("   Abre http://localhost:4200/login com estas credenciais.");
    lines.push("   Confirma que WEBSITE_URL no .env é exactamente a origem que usas no browser.");
  }
  return lines.join("\n");
}

/**
 * Unix seconds. Drizzle `integer(..., { mode: "timestamp" })` — persons,
 * memberships, and better-auth user/account — guarda segundos, não ms.
 */
export function kernelNowSeconds(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000);
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
