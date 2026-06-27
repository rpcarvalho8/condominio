// @ts-nocheck
/**
 * migration-clean.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PURGA DE SEEDS ANTIGOS / DADOS QA
 *
 * Remove todos os registos da tabela `quotas` e `bank_transactions` que tenham
 * data anterior a 02 de Junho de 2026 (ANCORA_DATA_MOVIMENTOS).
 *
 * Lógica:
 *   • quotas com (ano < 2026) OU (ano = 2026 AND mes < 6) → DELETE
 *   • bank_transactions com date < unix(2026-06-02) → DELETE
 *
 * Execute com:
 *   cd packages/web && bun run ../../migration-clean.ts
 * ou diretamente:
 *   bun migration-clean.ts  (na raiz do repo)
 *
 * AVISO: operação irreversível. Fazer backup da DB antes se necessário.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { and, lt, or, sql, eq, lte } from "drizzle-orm";
import * as schema from "./packages/web/src/api/database/schema";
import path from "node:path";

// ── Localizar a DB (SQLite) ───────────────────────────────────────────────────
// Prioridade: env var DATABASE_URL, depois caminho padrão do stack
const DB_PATH =
  process.env.DATABASE_URL?.replace("file:", "") ??
  path.join(import.meta.dir, "packages", "web", "data", "condominio.db");

console.log(`\n[migration-clean] A ligar a: ${DB_PATH}`);

const sqlite = new Database(DB_PATH);
const db = drizzle(sqlite, { schema });

// ── Data-âncora: 02/06/2026 ───────────────────────────────────────────────────
// Quotas com ano/mes anteriores a Junho 2026 são seeds de teste.
// bank_transactions com date < este timestamp são dados QA.
const ANCORA_TS = Math.floor(new Date("2026-06-02T00:00:00.000Z").getTime() / 1000);

async function main() {
  // ── 1. Contar antes ─────────────────────────────────────────────────────────
  const [{ total: totalQuotasAntes }] = db
    .select({ total: sql<number>`count(*)` })
    .from(schema.quotas)
    .all() as any;

  const [{ total: totalBankAntes }] = db
    .select({ total: sql<number>`count(*)` })
    .from(schema.bankTransactions)
    .all() as any;

  console.log(`\n[migration-clean] Antes da purga:`);
  console.log(`  quotas total:            ${totalQuotasAntes}`);
  console.log(`  bank_transactions total: ${totalBankAntes}`);

  // ── 2. Purgar quotas pré-Junho-2026 ─────────────────────────────────────────
  // Condição: (ano < 2026) OR (ano = 2026 AND mes < 6)
  const deletedQuotas = db
    .delete(schema.quotas)
    .where(
      or(
        lt(schema.quotas.ano, 2026),
        and(
          eq(schema.quotas.ano, 2026),
          lt(schema.quotas.mes, 6),
        ),
      )!
    )
    .run();

  console.log(`\n[migration-clean] ✅ Quotas eliminadas: ${deletedQuotas.changes}`);

  // ── 3. Purgar bank_transactions pré-02/06/2026 ──────────────────────────────
  const deletedBank = db
    .delete(schema.bankTransactions)
    .where(sql`${schema.bankTransactions.date} < ${ANCORA_TS}`)
    .run();

  console.log(`[migration-clean] ✅ bank_transactions eliminadas: ${deletedBank.changes}`);

  // ── 4. Contar depois ────────────────────────────────────────────────────────
  const [{ total: totalQuotasDepois }] = db
    .select({ total: sql<number>`count(*)` })
    .from(schema.quotas)
    .all() as any;

  const [{ total: totalBankDepois }] = db
    .select({ total: sql<number>`count(*)` })
    .from(schema.bankTransactions)
    .all() as any;

  console.log(`\n[migration-clean] Depois da purga:`);
  console.log(`  quotas total:            ${totalQuotasDepois}`);
  console.log(`  bank_transactions total: ${totalBankDepois}`);
  console.log(`\n[migration-clean] ✅ Concluído — base de dados limpa de seeds antigos.\n`);

  sqlite.close();
}

main().catch((e) => {
  console.error("[migration-clean] ERRO:", e);
  process.exit(1);
});
