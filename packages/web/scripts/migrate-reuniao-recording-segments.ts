/**
 * Aplica migration 0001 (RecordingSegment / tenant / audit) de forma segura.
 *
 * Uso:
 *   cd packages/web && bun --env-file=../../.env run scripts/migrate-reuniao-recording-segments.ts
 *
 * - BD limpa: cria o que faltar
 * - BD existente: ADD COLUMN ignora se já existir; backfill tenant_id
 * - Não apaga dados
 */

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { CONDOMINIO } from "../src/api/lib/condominio";

const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN;

if (!DATABASE_URL) {
  console.error("[migrate] DATABASE_URL em falta.");
  process.exit(1);
}

const tenantId = String(process.env.TENANT_ID ?? "").trim() || CONDOMINIO.nif;
const sqlPath = path.join(
  import.meta.dir,
  "..",
  "migrations",
  "0001_reuniao_recording_segments.sql",
);

let raw = fs.readFileSync(sqlPath, "utf8");
raw = raw.replaceAll("__TENANT_ID__", tenantId.replace(/'/g, "''"));

const client = createClient({
  url: DATABASE_URL,
  authToken: DATABASE_AUTH_TOKEN,
});

function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

async function execSafe(stmt: string): Promise<"ok" | "skip" | "error"> {
  try {
    await client.execute(stmt);
    return "ok";
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    // SQLite/Turso: coluna/tabela/índice já existe
    if (
      msg.includes("duplicate column") ||
      msg.includes("already exists") ||
      msg.includes("duplicate column name")
    ) {
      return "skip";
    }
    console.error("[migrate] ERRO:", stmt.slice(0, 120), "→", e?.message ?? e);
    return "error";
  }
}

async function main() {
  console.log(`[migrate] BD: ${DATABASE_URL}`);
  console.log(`[migrate] tenant_id backfill: ${tenantId}`);

  const stmts = splitStatements(raw);
  let ok = 0;
  let skip = 0;
  let err = 0;
  for (const stmt of stmts) {
    const r = await execSafe(stmt);
    if (r === "ok") ok++;
    else if (r === "skip") skip++;
    else err++;
  }

  // Garantir backfill mesmo se UPDATE no SQL falhou por ordem
  await execSafe(
    `UPDATE reunioes SET tenant_id = '${tenantId.replace(/'/g, "''")}' WHERE tenant_id IS NULL OR tenant_id = ''`,
  );

  const count = await client.execute(
    `SELECT COUNT(*) AS c FROM reunioes WHERE tenant_id = '${tenantId.replace(/'/g, "''")}'`,
  );
  console.log(`[migrate] reunioes com tenant_id=${tenantId}:`, count.rows[0]?.c);
  console.log(`[migrate] concluído: ok=${ok} skip=${skip} err=${err}`);
  if (err > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
