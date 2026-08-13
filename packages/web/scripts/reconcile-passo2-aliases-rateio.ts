/**
 * Setup aliases + rateio + reconciliação Passo 2.
 * Uso: bun --env-file=../../.env run scripts/reconcile-passo2-aliases-rateio.ts
 */
import { createClient } from "@libsql/client";

const c = createClient({
  url: process.env.DATABASE_URL!,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

async function q(sql: string, args: unknown[] = []) {
  return (await c.execute({ sql, args })).rows;
}

function uuid(): string {
  return crypto.randomUUID();
}

function norm(s: string): string {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function ensureColumn() {
  const cols = await q(`PRAGMA table_info(fracoes)`);
  const names = new Set(cols.map((r) => String(r.name)));
  if (!names.has("proprietario_aliases")) {
    await c.execute(`ALTER TABLE fracoes ADD COLUMN proprietario_aliases TEXT`);
    console.log("✅ Coluna fracoes.proprietario_aliases criada");
  } else {
    console.log("· Coluna proprietario_aliases já existe");
  }
}

async function ensureRateioTables() {
  await c.execute(`
    CREATE TABLE IF NOT EXISTS rateio_campanhas (
      id TEXT PRIMARY KEY NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      valor_unitario REAL NOT NULL,
      quantidade_esperada INTEGER NOT NULL DEFAULT 1,
      quantidade_recebida INTEGER NOT NULL DEFAULT 0,
      total_recebido REAL NOT NULL DEFAULT 0,
      keywords TEXT,
      status TEXT NOT NULL DEFAULT 'aberta',
      fornecedor_nome TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await c.execute(`
    CREATE TABLE IF NOT EXISTS rateio_pagamentos (
      id TEXT PRIMARY KEY NOT NULL,
      campanha_id TEXT NOT NULL REFERENCES rateio_campanhas(id),
      bank_transaction_id TEXT REFERENCES bank_transactions(id),
      fracao_id TEXT REFERENCES fracoes(id),
      valor REAL NOT NULL,
      debtor_name TEXT,
      data INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  console.log("✅ Tabelas rateio prontas");
}

async function setAliases(numero: string, aliases: string[]) {
  const [f] = await q(`SELECT id, proprietario_nome, proprietario_aliases FROM fracoes WHERE numero=?`, [numero]);
  if (!f) {
    console.warn(`⚠️  Fração ${numero} não encontrada`);
    return;
  }
  let current: string[] = [];
  try {
    current = JSON.parse(String(f.proprietario_aliases ?? "[]"));
  } catch {
    current = [];
  }
  if (!Array.isArray(current)) current = [];
  const set = new Set(current.map(norm));
  for (const a of aliases) {
    const n = norm(a);
    if (n && !set.has(n) && n !== norm(String(f.proprietario_nome ?? ""))) {
      current.push(a);
      set.add(n);
    }
  }
  await c.execute({
    sql: `UPDATE fracoes SET proprietario_aliases = ? WHERE numero = ?`,
    args: [JSON.stringify(current), numero],
  });
  console.log(`✓ Aliases ${numero}:`, current);
}

async function ensureCampainha(): Promise<string> {
  const nome = "Campainhas 2026";
  const [ex] = await q(`SELECT id FROM rateio_campanhas WHERE nome=?`, [nome]);
  if (ex) return String(ex.id);
  const id = uuid();
  const now = Math.floor(Date.now() / 1000);
  // 1 já na BD + pelo menos 6 = 7 esperados
  await c.execute({
    sql: `INSERT INTO rateio_campanhas
      (id, nome, descricao, valor_unitario, quantidade_esperada, quantidade_recebida, total_recebido, keywords, status, created_at, updated_at)
      VALUES (?, ?, ?, 47.50, 7, 0, 0, ?, 'aberta', ?, ?)`,
    args: [
      id,
      nome,
      "Comparticipação arranjo campainhas — N condóminos → condomínio → fornecedor",
      "CAMPAINHA,CAMPAINHAS,EXTRA CAMPAINHAS",
      now,
      now,
    ],
  });
  console.log("✅ Campanha Campainhas 2026 criada (7× €47,50)");
  return id;
}

async function linkQuota(opts: {
  txnId: string;
  fracaoNumero: string;
  valor: number;
  mes: number;
  ano: number;
  nomeAlias?: string;
  obs: string;
}) {
  const [f] = await q(`SELECT id, numero FROM fracoes WHERE numero=?`, [opts.fracaoNumero]);
  if (!f) throw new Error(`Fração ${opts.fracaoNumero} missing`);

  const [existing] = await q(
    `SELECT id FROM quotas WHERE fracao_id=? AND mes=? AND ano=? AND tipo='condominio' LIMIT 1`,
    [f.id, opts.mes, opts.ano],
  );

  let quotaId: string;
  const now = Math.floor(Date.now() / 1000);
  // data_pagamento ≈ data da TXN — buscamos date da txn
  const [txn] = await q(`SELECT date FROM bank_transactions WHERE id=?`, [opts.txnId]);
  const txTs = Number(txn?.date ?? now);

  if (existing) {
    quotaId = String(existing.id);
    await c.execute({
      sql: `UPDATE quotas SET pago=1, valor=?, data_pagamento=?, metodo_pagamento='transferência', observacoes=? WHERE id=?`,
      args: [opts.valor, txTs, opts.obs, quotaId],
    });
  } else {
    quotaId = uuid();
    await c.execute({
      sql: `INSERT INTO quotas (id, fracao_id, tipo, mes, ano, valor, fundo_reserva, pago, data_pagamento, metodo_pagamento, observacoes, created_at)
            VALUES (?, ?, 'condominio', ?, ?, ?, ?, 1, ?, 'transferência', ?, ?)`,
      args: [
        quotaId,
        f.id,
        opts.mes,
        opts.ano,
        opts.valor,
        Math.round(opts.valor * 0.1 * 100) / 100,
        txTs,
        opts.obs,
        now,
      ],
    });
  }

  await c.execute({
    sql: `UPDATE bank_transactions SET import_type='quota', imported=1, import_ref_id=?, requires_manual_review=0, status='booked' WHERE id=?`,
    args: [quotaId, opts.txnId],
  });

  // perfil pagador
  const [txnFull] = await q(
    `SELECT debtor_iban, debtor_name, description, amount FROM bank_transactions WHERE id=?`,
    [opts.txnId],
  );
  const nome =
    opts.nomeAlias ||
    String(txnFull?.debtor_name || "") ||
    String(txnFull?.description || "").replace(/^TRF[^.]*DE\s+/i, "").split("-")[0];

  if (nome) {
    const nomeN = norm(nome);
    const [perf] = await q(
      `SELECT id, confirmacoes FROM pagador_perfis WHERE fracao_numero=? AND ABS(valor-?)<0.03 AND ativo=1 LIMIT 1`,
      [opts.fracaoNumero, opts.valor],
    );
    if (perf) {
      await c.execute({
        sql: `UPDATE pagador_perfis SET confirmacoes=confirmacoes+1, nome_normalizado=COALESCE(nome_normalizado,?), fonte='manual', updated_at=? WHERE id=?`,
        args: [nomeN, now, perf.id],
      });
    } else {
      await c.execute({
        sql: `INSERT INTO pagador_perfis (id, iban, nome_normalizado, valor, fracao_id, fracao_numero, rubrica, confirmacoes, fonte, ativo, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'condominio', 1, 'manual', 1, ?, ?)`,
        args: [
          uuid(),
          txnFull?.debtor_iban ? String(txnFull.debtor_iban).replace(/\s/g, "").toUpperCase() : null,
          nomeN || null,
          opts.valor,
          f.id,
          opts.fracaoNumero,
          now,
          now,
        ],
      });
    }
  }

  console.log(`✓ TXN ${opts.txnId.slice(0, 8)}… → ${opts.fracaoNumero} quota ${opts.mes}/${opts.ano} €${opts.valor}`);
}

async function linkRateio(txnId: string, campanhaId: string) {
  const [txn] = await q(
    `SELECT amount, date, debtor_name, description FROM bank_transactions WHERE id=?`,
    [txnId],
  );
  if (!txn) return;
  const [ex] = await q(`SELECT id FROM rateio_pagamentos WHERE bank_transaction_id=?`, [txnId]);
  if (ex) {
    console.log("· Rateio já registado para", txnId.slice(0, 8));
    return;
  }
  const pagId = uuid();
  const now = Math.floor(Date.now() / 1000);
  const valor = Math.abs(Number(txn.amount));
  await c.execute({
    sql: `INSERT INTO rateio_pagamentos (id, campanha_id, bank_transaction_id, valor, debtor_name, data, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [pagId, campanhaId, txnId, valor, txn.debtor_name ?? txn.description, txn.date, now],
  });
  await c.execute({
    sql: `UPDATE rateio_campanhas SET
            quantidade_recebida = quantidade_recebida + 1,
            total_recebido = total_recebido + ?,
            status = CASE WHEN quantidade_recebida + 1 >= quantidade_esperada THEN 'completa' ELSE status END,
            updated_at = ?
          WHERE id = ?`,
    args: [valor, now, campanhaId],
  });
  await c.execute({
    sql: `UPDATE bank_transactions SET import_type='rateio', imported=1, import_ref_id=?, requires_manual_review=0, status='booked', rubrica_extra='RATEIO' WHERE id=?`,
    args: [pagId, txnId],
  });
  console.log(`✓ Campainhas rateio €${valor.toFixed(2)} registado`);
}

async function main() {
  await ensureColumn();
  await ensureRateioTables();

  // Aliases confirmados pela administração
  await setAliases("G", [
    "MARMA",
    "MARMA CONCEPT",
    "MARMA CONCEPT UNIPESSOAL LDA",
    "MARCO ANDRE MENDES MAIA",
    "MARCO MAIA",
  ]);
  await setAliases("AJ", [
    "FILIPE MIGUEL SILVA BACELO",
    "FILIPE BACELO",
  ]);
  // Nome bancário do pagador AI (e proxy AH) — reforça match por nome na AI
  await setAliases("AI", [
    "RUI PEDRO MAIA OLIVEIRA",
    "RUI CARVALHO",
  ]);

  const campId = await ensureCampainha();

  // Localizar TXNs
  const marco = await q(
    `SELECT id, amount, date FROM bank_transactions WHERE description LIKE '%MARCO ANDRE MENDES MAIA%' AND amount > 0`,
  );
  const filipe = await q(
    `SELECT id, amount, date FROM bank_transactions WHERE description LIKE '%FILIPE%BACELO%' AND amount > 0`,
  );
  const ruiAI = await q(
    `SELECT id, amount, date FROM bank_transactions WHERE description LIKE '%RUI PEDRO MAIA%' AND ABS(amount-42.76)<0.02`,
  );
  const ruiAH = await q(
    `SELECT id, amount, date FROM bank_transactions WHERE description LIKE '%RUI PEDRO MAIA%' AND ABS(amount-48.85)<0.02`,
  );
  const camp = await q(
    `SELECT id, amount, date FROM bank_transactions WHERE description LIKE '%CAMPAINH%' AND amount > 0`,
  );

  console.log("\n=== Reconciliação ===");
  console.log("Marco:", marco.length, "Filipe:", filipe.length, "RuiAI:", ruiAI.length, "RuiAH:", ruiAH.length, "Camp:", camp.length);

  for (const r of marco) {
    const d = new Date(Number(r.date) * 1000);
    await linkQuota({
      txnId: String(r.id),
      fracaoNumero: "G",
      valor: Number(r.amount),
      mes: d.getUTCMonth() + 1,
      ano: d.getUTCFullYear(),
      nomeAlias: "MARCO ANDRE MENDES MAIA",
      obs: "[reconcile] Marco Maia → G (ex-Marma)",
    });
  }

  for (const r of filipe) {
    const d = new Date(Number(r.date) * 1000);
    await linkQuota({
      txnId: String(r.id),
      fracaoNumero: "AJ",
      valor: Number(r.amount),
      mes: d.getUTCMonth() + 1,
      ano: d.getUTCFullYear(),
      nomeAlias: "FILIPE MIGUEL SILVA BACELO",
      obs: "[reconcile] Filipe Bacelo → AJ (co-proprietário)",
    });
  }

  for (const r of ruiAI) {
    const d = new Date(Number(r.date) * 1000);
    await linkQuota({
      txnId: String(r.id),
      fracaoNumero: "AI",
      valor: Number(r.amount),
      mes: d.getUTCMonth() + 1,
      ano: d.getUTCFullYear(),
      nomeAlias: "RUI PEDRO MAIA OLIVEIRA",
      obs: "[reconcile] Rui Pedro €42.76 → AI",
    });
  }

  for (const r of ruiAH) {
    const d = new Date(Number(r.date) * 1000);
    await linkQuota({
      txnId: String(r.id),
      fracaoNumero: "AH",
      valor: Number(r.amount),
      mes: d.getUTCMonth() + 1,
      ano: d.getUTCFullYear(),
      nomeAlias: "RUI PEDRO MAIA OLIVEIRA",
      obs: "[reconcile] Rui Pedro €48.85 → AH (proxy)",
    });
  }

  for (const r of camp) {
    await linkRateio(String(r.id), campId);
  }

  const [cc] = await q(`SELECT valor FROM configuracoes WHERE chave='saldo_conta_corrente'`);
  console.log("\n✅ Passo 2 concluído. saldo_conta_corrente actual (antes recalcular):", cc?.valor);
  console.log("Reinicia o dev server / clica Recalcular no dashboard para actualizar o badge.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
