/**
 * Fecha historicamente a campanha Campainhas 2026.
 * - 7 frações: AB, AE, AH, AI, M, N, O × €47,50 = €332,50
 * - No sync actual só existe 1 crédito €47,50 e 0 débitos €332,50
 *   (restantes movimentos anteriores a 20/07 — fora da janela Enable Banking)
 *
 * Uso: bun --env-file=../../.env run scripts/close-campainhas-rateio.ts
 */
import { createClient } from "@libsql/client";

const c = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

const FRACOES = ["AB", "AE", "AH", "AI", "M", "N", "O"];
const VALOR = 47.5;
const TOTAL = 332.5; // 7 × 47.50

async function q(sql: string, args: unknown[] = []) {
  return (await c.execute({ sql, args })).rows;
}

async function ensureCols() {
  const cols = await q(`PRAGMA table_info(rateio_campanhas)`);
  const names = new Set(cols.map((r) => String(r.name)));
  const add = async (col: string, def: string) => {
    if (!names.has(col)) {
      await c.execute(`ALTER TABLE rateio_campanhas ADD COLUMN ${col} ${def}`);
      console.log(`✅ Coluna ${col}`);
    }
  };
  await add("fracoes_esperadas", "TEXT");
  await add("pago_valor", "REAL");
  await add("pago_bank_transaction_id", "TEXT");
  await add("pago_em", "INTEGER");
}

async function main() {
  await ensureCols();

  const [camp] = await q(`SELECT * FROM rateio_campanhas WHERE nome=?`, ["Campainhas 2026"]);
  if (!camp) {
    console.error("Campanha Campainhas 2026 não encontrada");
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  await c.execute({
    sql: `UPDATE rateio_campanhas SET
      fracoes_esperadas = ?,
      quantidade_esperada = 7,
      quantidade_recebida = 7,
      total_recebido = ?,
      valor_unitario = ?,
      keywords = ?,
      status = 'paga',
      pago_valor = ?,
      pago_em = ?,
      fornecedor_nome = ?,
      descricao = ?,
      updated_at = ?
    WHERE id = ?`,
    args: [
      JSON.stringify(FRACOES),
      TOTAL,
      VALOR,
      "CAMPAINHA,CAMPAINHAS,EXTRA CAMPAINHAS",
      TOTAL,
      now,
      "Fornecedor campainhas (pagamento fora da janela sync 20/07+)",
      "Comparticipação arranjo campainhas — AB,AE,AH,AI,M,N,O × €47,50 = €332,50 → fornecedor. Sem cota extra: rateio transitório.",
      now,
      camp.id,
    ],
  });

  // Ligar o único crédito conhecido (se ainda sem fração) — última transferência
  const [pag] = await q(
    `SELECT id, fracao_id FROM rateio_pagamentos WHERE campanha_id=? LIMIT 1`,
    [camp.id],
  );
  if (pag && !pag.fracao_id) {
    // Sem evidência de qual das 7 foi a última no descritivo — deixa null
    console.log("· Pagamento rateio sem fração no descritivo (ok — histórico)");
  }

  console.log("\n=== Verificação extracto (sync actual) ===");
  const c47 = await q(
    `SELECT COUNT(*) as n, ROUND(SUM(amount),2) as t FROM bank_transactions WHERE ABS(amount-47.5)<0.02 AND amount>0`,
  );
  const d332 = await q(
    `SELECT COUNT(*) as n FROM bank_transactions WHERE ABS(amount+332.5)<0.02`,
  );
  console.log(`Créditos €47,50 na BD: ${c47[0]?.n} (soma ${c47[0]?.t}) — esperado 7; em falta ${7 - Number(c47[0]?.n)} (pré-20/07)`);
  console.log(`Débitos €332,50 na BD: ${d332[0]?.n} — esperado 1; em falta se 0 (pré-20/07)`);

  const [updated] = await q(`SELECT * FROM rateio_campanhas WHERE id=?`, [camp.id]);
  console.log("\n✅ Campanha actualizada:");
  console.log({
    status: updated.status,
    fracoes: updated.fracoes_esperadas,
    recebidos: `${updated.quantidade_recebida}/${updated.quantidade_esperada}`,
    total: updated.total_recebido,
    pago: updated.pago_valor,
  });
  console.log(`
Modelo (futuro, automático):
  1. Criar campanha com frações + € unitário + keywords
  2. Sync: créditos €47,50 + "campainha" → rateio (não quota)
  3. Sync: débito €332,50 → status paga + despesa rateio
  Sem cota extra — dinheiro transitório na CC.
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
