/**
 * migration-p1.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Migração P1: adicionar coluna rubrica_extra à tabela bank_transactions
 *              + backfill retrocompatível inteligente por regex.
 *
 * Executa com:
 *   DATABASE_URL=libsql://... DATABASE_AUTH_TOKEN=... bun run migration-p1.ts
 *
 * Seguro para reexecutar (PRAGMA check / try-catch).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createClient } from "@libsql/client";

const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN;

if (!DATABASE_URL) {
  console.error("[migration-p1] ERRO: DATABASE_URL não definida.");
  console.error(
    "  Executa: DATABASE_URL=libsql://... DATABASE_AUTH_TOKEN=... bun run migration-p1.ts"
  );
  process.exit(1);
}

const client = createClient({
  url: DATABASE_URL,
  authToken: DATABASE_AUTH_TOKEN,
});

// ─── Inferência de rubrica (espelho de inferirRubricaDeDescricao em bank.ts) ──
type RubricaExtra = "OBRAS" | "MOTOR" | "INCENDIO" | "ELEVADORES" | "CONDOMINIO";

function inferirRubrica(descricao: string): RubricaExtra {
  const d = descricao.toUpperCase();
  if (/\bOBRAS?\b|COTA\s+(EXTRA\s+)?OBRAS|QUOTA\s+(EXTRA\s+)?OBRAS/.test(d)) return "OBRAS";
  if (
    /MOTOR\s+(DA\s+)?GARAGEM|PORT[AÃ]O\s+(GARAGEM|MOTOR)|COTA\s+(EXTRA\s+)?MOTOR|QUOTA\s+(EXTRA\s+)?MOTOR|COTA\s+(EXTRA\s+)?PORT[AÃ]O|\bAH\s+COTA\s+EXTRA|\bAI\s+COTA\s+EXTRA/.test(
      d
    )
  )
    return "MOTOR";
  if (
    /INC[EÊ]NDIO|SEGURO\s+(INCENDIO|INC[EÊ]NDIO)|COTA\s+INC[EÊ]NDIO|QUOTA\s+INC[EÊ]NDIO/.test(
      d
    )
  )
    return "INCENDIO";
  if (
    /INDAQUA|ELEVADOR|ELEV\b|COTA\s+(EXTRA\s+)?ELEV|QUOTA\s+(EXTRA\s+)?ELEV/.test(d)
  )
    return "ELEVADORES";
  return "CONDOMINIO";
}

async function run() {
  console.log("═══════════════════════════════════════════════════════");
  console.log(" migration-p1 — rubrica_extra @ bank_transactions");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`[migration-p1] Base de dados: ${DATABASE_URL}`);

  // ── 1. VERIFICAÇÃO DO SCHEMA ───────────────────────────────────────────────
  const tableInfo = await client.execute("PRAGMA table_info(bank_transactions)");
  const columns = tableInfo.rows.map((r: any) => r[1] as string);
  console.log(`[migration-p1] Colunas actuais (${columns.length}): ${columns.join(", ")}`);

  let columnAdded = false;

  if (columns.includes("rubrica_extra")) {
    console.log("[migration-p1] ✅ Coluna rubrica_extra já existe — ALTER TABLE ignorado.");
  } else {
    // ── 2. ALTER TABLE ───────────────────────────────────────────────────────
    console.log("[migration-p1] ➕ A adicionar coluna rubrica_extra TEXT...");
    try {
      await client.execute(
        "ALTER TABLE bank_transactions ADD COLUMN rubrica_extra TEXT"
      );
      columnAdded = true;
      console.log("[migration-p1] ✅ Coluna rubrica_extra adicionada com sucesso.");
    } catch (err: any) {
      // Turso pode lançar erro "duplicate column name" em race conditions
      if (/duplicate column/i.test(err?.message ?? "")) {
        console.log(
          "[migration-p1] ⚠️  Coluna já existia (erro duplicate column) — continuando."
        );
      } else {
        throw err;
      }
    }

    // Verificação pós-ALTER
    const verify = await client.execute("PRAGMA table_info(bank_transactions)");
    const newCols = verify.rows.map((r: any) => r[1] as string);
    if (!newCols.includes("rubrica_extra")) {
      console.error(
        "[migration-p1] ❌ FALHA — coluna não encontrada após ALTER TABLE."
      );
      process.exit(1);
    }
    console.log("[migration-p1] ✅ Schema verificado. Coluna presente.");
  }

  // ── 3. BACKFILL RETROCOMPATÍVEL ────────────────────────────────────────────
  console.log("\n[migration-p1] A iniciar backfill retrocompatível...");
  console.log(
    "[migration-p1] Critério: bank_transactions WHERE rubrica_extra IS NULL AND description IS NOT NULL"
  );

  const rows = await client.execute(
    "SELECT id, description FROM bank_transactions WHERE rubrica_extra IS NULL AND description IS NOT NULL"
  );

  const total = rows.rows.length;
  console.log(`[migration-p1] Transações elegíveis para backfill: ${total}`);

  if (total === 0) {
    console.log("[migration-p1] ✅ Nenhuma linha requer backfill.");
  } else {
    // Contadores por rubrica para relatório final
    const counts: Record<RubricaExtra, number> = {
      OBRAS: 0,
      MOTOR: 0,
      INCENDIO: 0,
      ELEVADORES: 0,
      CONDOMINIO: 0,
    };

    let updated = 0;
    let skipped = 0;

    for (const row of rows.rows) {
      const id = row[0] as string;
      const description = row[1] as string | null;

      if (!description || description.trim() === "") {
        skipped++;
        continue;
      }

      const rubrica = inferirRubrica(description);
      counts[rubrica]++;

      try {
        await client.execute({
          sql: "UPDATE bank_transactions SET rubrica_extra = ? WHERE id = ?",
          args: [rubrica, id],
        });
        updated++;
      } catch (err) {
        console.error(`[migration-p1] ⚠️  Erro ao actualizar id=${id}:`, err);
        skipped++;
      }
    }

    // ── 4. RELATÓRIO DE BACKFILL ─────────────────────────────────────────────
    console.log("\n─── Relatório de Backfill ───────────────────────────────");
    console.log(`  Total elegíveis : ${total}`);
    console.log(`  Actualizadas    : ${updated}`);
    console.log(`  Ignoradas       : ${skipped}`);
    console.log(`  Por rubrica:`);
    for (const [rubrica, count] of Object.entries(counts)) {
      if (count > 0) {
        console.log(`    ${rubrica.padEnd(12)}: ${count} linha(s)`);
      }
    }
    console.log("────────────────────────────────────────────────────────");
    console.log(`[migration-p1] ✅ Backfill concluído: ${updated}/${total} linha(s) actualizadas.`);
  }

  // ── 5. SUMÁRIO FINAL ───────────────────────────────────────────────────────
  await client.close();
  console.log("\n═══════════════════════════════════════════════════════");
  console.log(" MIGRAÇÃO P1 CONCLUÍDA");
  console.log(
    columnAdded
      ? " Schema: coluna rubrica_extra ADICIONADA"
      : " Schema: coluna rubrica_extra já existia"
  );
  console.log("═══════════════════════════════════════════════════════\n");
}

run().catch((err) => {
  console.error("[migration-p1] ERRO FATAL:", err);
  process.exit(1);
});
