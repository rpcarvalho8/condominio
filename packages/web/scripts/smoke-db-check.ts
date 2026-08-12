/**
 * Smoke check da BD — só contagens/chaves, sem dados pessoais.
 *
 * Uso:
 *   cd packages/web && bun --env-file=../../.env run scripts/smoke-db-check.ts
 *   # ou na raiz: bun run smoke:db
 */

import { createClient } from "@libsql/client";
import { resolve } from "path";

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

const ANCORA_KEYS = [
  "ancora_saldo_cc",
  "ancora_saldo_fr",
  "ancora_saldo_elevadores",
  "ancora_saldo_obras",
  "ancora_data_cc",
  "ancora_data_movimentos",
];

async function count(sql: string): Promise<number> {
  const r = await client.execute(sql);
  const row = r.rows[0] as Record<string, unknown>;
  const v = row.count ?? row["COUNT(*)"] ?? Object.values(row)[0];
  return Number(v ?? 0);
}

async function main() {
  let failed = 0;
  const ok = (label: string, pass: boolean, detail?: string) => {
    const mark = pass ? "OK" : "FAIL";
    if (!pass) failed++;
    console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
  };

  console.log(`DB: ${DB_URL.startsWith("file:") ? "local file" : "remote"}`);

  const fracoes = await count("SELECT COUNT(*) as count FROM fracoes");
  ok("fracoes > 0", fracoes > 0, `count=${fracoes}`);

  const users = await count('SELECT COUNT(*) as count FROM "user"');
  ok("users > 0", users > 0, `count=${users}`);

  const placeholders = ANCORA_KEYS.map(() => "?").join(",");
  const cfg = await client.execute({
    sql: `SELECT chave FROM configuracoes WHERE chave IN (${placeholders})`,
    args: ANCORA_KEYS,
  });
  const found = new Set(cfg.rows.map((r) => String((r as { chave: string }).chave)));
  const missing = ANCORA_KEYS.filter((k) => !found.has(k));
  ok(
    "âncoras em configuracoes",
    missing.length === 0,
    missing.length ? `missing=${missing.join(",")}` : `found=${found.size}`,
  );

  const quotas = await count("SELECT COUNT(*) as count FROM quotas");
  ok("quotas table reachable", Number.isFinite(quotas), `count=${quotas}`);

  if (failed > 0) {
    console.log(`\nSmoke FAILED (${failed} checks)`);
    process.exit(1);
  }
  console.log("\nSmoke OK");
}

main().catch((e) => {
  console.error("Smoke ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
