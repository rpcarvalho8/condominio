/**
 * Relatório Mensal do Condomínio
 * Gera PDF do relatório mensal (tipo "Relatório Março 2026")
 * e envia por email no último dia do mês.
 *
 * Routes:
 *   POST /api/relatorio/gerar   { mes, ano } → gera e envia PDF
 *   GET  /api/relatorio         → lista relatórios gerados
 *   GET  /api/relatorio/:mes/:ano/pdf → download PDF
 */

import { Hono } from "hono";
import { requireAdmin } from "../middleware/auth";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, and, sql } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { htmlToPdf } from "../lib/html-to-pdf";

// ─── Config ─────────────────────────────────────────────────────────────────
const CONDOMINIO = {
  nome: "Condomínio Urbanização da Fonte",
  morada: "Rua Poeta António Boto, n.ºs 21, 37 e 39",
  localidade: "4785-390 Trofa",
  nif: "901932027",
  email: "urbanizacaofonte@gmail.com",
  iban: "PT50 0018 0003 4978 3806 0206 5",
};

const MESES = [
  "", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const PDF_DIR = path.join(process.cwd(), "data", "relatorios");
fs.mkdirSync(PDF_DIR, { recursive: true });

const LOGO_PATH = path.join(process.cwd(), "public", "logo_condominio.png");
let LOGO_B64 = "";
try { LOGO_B64 = fs.readFileSync(LOGO_PATH).toString("base64"); } catch {}

// ─── Orçamento anual 2026 ────────────────────────────────────────────────────
const ORCAMENTO_MENSAL_2026: Record<string, number> = {
  eletricidade: 200.00,
  agua:         150.00,
  limpeza:      150.00,
  lavagem_exterior: 8.33,
  lavagem_garagem:  20.00,
  jardim:       130.00,
  elevadores:   150.00,
  despesas_bancarias: 20.00,
  honorarios:   138.00,
  diversos:      62.50,
};

const ORCAMENTO_LABEL: Record<string, string> = {
  eletricidade: "Eletricidade",
  agua:         "Água",
  limpeza:      "Limpeza",
  lavagem_exterior: "Lavagem/manutenção exterior",
  lavagem_garagem:  "Lavagem garagem",
  jardim:       "Jardim",
  elevadores:   "Elevadores",
  despesas_bancarias: "Despesas bancárias",
  honorarios:   "Honorários Administração",
  diversos:     "Diversos",
};

function fmt(v: number): string {
  return v.toFixed(2).replace(".", ",") + " €";
}
function fmtNum(v: number): string {
  return v.toFixed(2).replace(".", ",");
}
function pct(v: number, total: number): string {
  if (total === 0) return "0%";
  return ((v / total) * 100).toFixed(1) + "%";
}

// ─── Defaults ─────────────────────────────────────────────────────────────────
const SALDO_DEFAULTS: Record<string, number> = {
  saldo_conta_corrente: 1487.50,
  saldo_obras: 27222.44,
  saldo_fundo_reserva: 463.12,
  saldo_quota_extra: 2440.06,
  saldo_incendio: 0,
};

async function getSaldos(): Promise<Record<string, number>> {
  try {
    const rows = await db.select().from(schema.configuracoes);
    const r: Record<string, number> = { ...SALDO_DEFAULTS };
    for (const row of rows) {
      const v = parseFloat(row.valor);
      if (!isNaN(v)) r[row.chave] = v;
    }
    return r;
  } catch { return { ...SALDO_DEFAULTS }; }
}

// ─── Data aggregation ─────────────────────────────────────────────────────────
async function calcularRelatorio(mes: number, ano: number) {
  const saldos = await getSaldos();

  // --- ENTRADAS (quotas pagas / em atraso até este mês) ---

  // 1. Condomínio (tipo="condominio")
  const qCond = await db.select().from(schema.quotas).where(
    and(eq(schema.quotas.tipo, "condominio"), eq(schema.quotas.mes, mes), eq(schema.quotas.ano, ano))
  );
  const condTotal = qCond.reduce((s, q) => s + q.valor + (q.fundoReserva ?? 0), 0);
  const condPago = qCond.filter(q => q.pago).reduce((s, q) => s + q.valor, 0);
  const condAtraso = qCond.filter(q => !q.pago).reduce((s, q) => s + q.valor, 0);

  // Fundo reserva separado (10% da quota condomínio)
  const frTotal = qCond.reduce((s, q) => s + (q.fundoReserva ?? 0), 0);
  const frPago = qCond.filter(q => q.pago).reduce((s, q) => s + (q.fundoReserva ?? 0), 0);
  const frAtraso = qCond.filter(q => !q.pago).reduce((s, q) => s + (q.fundoReserva ?? 0), 0);

  // 2. Obras (tipo="obras") - YTD
  const qObras = await db.select().from(schema.quotas).where(eq(schema.quotas.tipo, "obras"));
  const obrasTotal = qObras.reduce((s, q) => s + q.valor, 0);
  const obrasPago = qObras.filter(q => q.pago).reduce((s, q) => s + q.valor, 0);
  const obrasAtraso = qObras.filter(q => !q.pago).reduce((s, q) => s + q.valor, 0);

  // 3. Extras por tipo - YTD
  const quotaTiposList = await db.select().from(schema.quotaTipos).where(eq(schema.quotaTipos.tipo, "extra"));
  const extrasData = await Promise.all(quotaTiposList.map(async (qt) => {
    const qs = await db.select().from(schema.quotas).where(
      and(eq(schema.quotas.tipo, "extra"), eq(schema.quotas.quotaTipoId, qt.id))
    );
    return {
      nome: qt.nome,
      total: qs.reduce((s, q) => s + q.valor, 0),
      pago: qs.filter(q => q.pago).reduce((s, q) => s + q.valor, 0),
      atraso: qs.filter(q => !q.pago).reduce((s, q) => s + q.valor, 0),
    };
  }));

  // --- SAÍDAS (despesas Jan até este mês do ano) ---
  const inicioAno = new Date(ano, 0, 1);
  const fimMes = new Date(ano, mes, 0, 23, 59, 59);

  const despesasYTD = await db.select().from(schema.despesas).where(
    and(
      sql`${schema.despesas.data} >= ${Math.floor(inicioAno.getTime() / 1000)}`,
      sql`${schema.despesas.data} <= ${Math.floor(fimMes.getTime() / 1000)}`
    )
  );

  // Agrupar por mês
  const despesasPorMes: Record<string, Record<string, number>> = {};
  for (let m = 1; m <= mes; m++) {
    despesasPorMes[m] = {};
  }
  for (const d of despesasYTD) {
    const dm = d.data.getMonth() + 1;
    const cat = d.categoria?.toLowerCase() ?? "outros";
    if (!despesasPorMes[dm]) despesasPorMes[dm] = {};
    despesasPorMes[dm][cat] = (despesasPorMes[dm][cat] ?? 0) + d.valor;
  }

  // Totais YTD por categoria
  const totaisYTD: Record<string, number> = {};
  for (const d of despesasYTD) {
    const cat = d.categoria?.toLowerCase() ?? "outros";
    totaisYTD[cat] = (totaisYTD[cat] ?? 0) + d.valor;
  }
  const totalDespesasYTD = despesasYTD.reduce((s, d) => s + d.valor, 0);

  // Morosos condomínio (todas as quotas em atraso)
  const todasEmAtraso = await db
    .select({ q: schema.quotas, f: schema.fracoes })
    .from(schema.quotas)
    .leftJoin(schema.fracoes, eq(schema.quotas.fracaoId, schema.fracoes.id))
    .where(and(eq(schema.quotas.tipo, "condominio"), eq(schema.quotas.pago, false)));

  // Agrupar por fração
  const morososMap = new Map<string, { fracao: any; meses: string[]; total: number }>();
  for (const row of todasEmAtraso) {
    if (!row.f) continue;
    const id = row.f.id;
    if (!morososMap.has(id)) morososMap.set(id, { fracao: row.f, meses: [], total: 0 });
    morososMap.get(id)!.meses.push(`${MESES[row.q.mes]}/${row.q.ano}`);
    morososMap.get(id)!.total += row.q.valor;
  }
  const morosos = Array.from(morososMap.values()).sort((a, b) => b.total - a.total);

  return {
    mes, ano,
    condTotal, condPago, condAtraso,
    frTotal, frPago, frAtraso,
    obrasTotal, obrasPago, obrasAtraso,
    extrasData,
    despesasPorMes, totaisYTD, totalDespesasYTD,
    morosos,
    saldos,
  };
}

// ─── HTML Template ────────────────────────────────────────────────────────────
function buildRelatorioHtml(data: Awaited<ReturnType<typeof calcularRelatorio>>): string {
  const { mes, ano, saldos, extrasData, morosos } = data;
  const mesNome = MESES[mes];
  const logoSrc = LOGO_B64 ? `data:image/png;base64,${LOGO_B64}` : "";

  // Rows para tabela ENTRADAS
  const entradas = [
    { nome: "Obras - Incêndio", total: 0, pago: 0, atraso: saldos.saldo_incendio > 0 ? 157.98 : 0 },
    ...extrasData.map(e => ({ nome: e.nome, total: e.total, pago: e.pago, atraso: e.atraso })),
    { nome: "Obras", total: data.obrasTotal, pago: data.obrasPago, atraso: data.obrasAtraso },
  ];
  const totalEntradas = entradas.reduce((s, e) => s + e.total, 0);
  const totalEntradasPago = entradas.reduce((s, e) => s + e.pago, 0);
  const totalEntradasAtraso = entradas.reduce((s, e) => s + e.atraso, 0);

  const totalSaldo = (saldos.saldo_conta_corrente ?? 0)
    + (saldos.saldo_obras ?? 0)
    + (saldos.saldo_fundo_reserva ?? 0)
    + (saldos.saldo_quota_extra ?? 0);

  // Orçamento table rows (all categories)
  const allCats = Object.keys(ORCAMENTO_MENSAL_2026);
  const orcRows = allCats.map(cat => {
    const mensal = ORCAMENTO_MENSAL_2026[cat];
    const anual = mensal * 12;
    const ytd: number[] = [];
    for (let m = 1; m <= 12; m++) {
      ytd.push(m <= mes ? (data.despesasPorMes[m]?.[cat] ?? 0) : -1);
    }
    const gasto = ytd.filter(v => v >= 0).reduce((s, v) => s + v, 0);
    const diferenca = anual - gasto;
    return { cat, label: ORCAMENTO_LABEL[cat] ?? cat, mensal, anual, ytd, gasto, diferenca };
  });
  const totalOrcMensal = Object.values(ORCAMENTO_MENSAL_2026).reduce((s, v) => s + v, 0);
  const totalOrcAnual = totalOrcMensal * 12;
  const totalGasto = data.totalDespesasYTD;
  const totalDif = totalOrcAnual - totalGasto;

  // Build month columns header
  const monthHeaders = MESES.slice(1).map((m, i) => `<th>${m.slice(0, 3)}</th>`).join("");

  // Build month data cells per row
  function cellsForRow(ytd: number[]): string {
    return ytd.map(v => v < 0
      ? `<td class="center">-</td>`
      : v === 0
        ? `<td class="center dim">-€</td>`
        : `<td class="center">${fmtNum(v)} €</td>`
    ).join("");
  }

  const orcTableRows = orcRows.map(r =>
    `<tr>
      <td>${r.label}</td>
      <td class="right">${fmtNum(r.anual)} €</td>
      <td class="right">${fmtNum(r.mensal)} €</td>
      ${cellsForRow(r.ytd)}
      <td class="right ${r.diferenca < 0 ? 'red' : ''}">${fmtNum(r.diferenca)} €</td>
    </tr>`
  ).join("");

  const entradasRows = entradas.map(e =>
    `<tr>
      <td>${e.nome}</td>
      <td class="right">${e.total > 0 ? fmt(e.total) : "-"}</td>
      <td class="right">${fmt(e.pago)}</td>
      <td class="right ${e.atraso > 0 ? 'red' : ''}">${fmt(e.atraso)}</td>
    </tr>`
  ).join("");

  const morososRows = morosos.slice(0, 20).map(m =>
    `<tr>
      <td>${m.fracao.numero}</td>
      <td>${m.fracao.proprietarioNome ?? "—"}</td>
      <td>${m.meses.join(", ")}</td>
      <td class="right red">${fmt(m.total)}</td>
    </tr>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "Calibri", "Arial", sans-serif;
    font-size: 9.5pt;
    color: #1a1a1a;
    background: white;
    padding: 15mm 12mm 15mm 12mm;
  }

  .page-break { page-break-before: always; }

  .corner-tl {
    position: fixed; top: 0; left: 0;
    width: 0; height: 0; border-style: solid;
    border-width: 50px 50px 0 0;
    border-color: #b5a99a transparent transparent transparent;
    opacity: 0.5;
  }
  .corner-br {
    position: fixed; bottom: 0; right: 0;
    width: 0; height: 0; border-style: solid;
    border-width: 0 0 50px 50px;
    border-color: transparent transparent #b5a99a transparent;
    opacity: 0.5;
  }
  .sidebar-line {
    position: fixed; top: 0; right: 14mm;
    width: 1.5px; height: 100%;
    background: #b5a99a; opacity: 0.35;
  }
  .page-num {
    position: fixed; bottom: 8mm; right: 18mm;
    font-size: 8pt; color: #888;
  }

  /* Header */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 12px;
    border-bottom: 2px solid #b5a99a;
    padding-bottom: 8px;
  }
  .header .title h1 {
    font-size: 16pt;
    font-weight: 700;
    color: #3a3128;
    letter-spacing: 0.5px;
  }
  .header .title .subtitle {
    font-size: 10pt;
    color: #888;
    margin-top: 2px;
  }
  .header img { width: 110px; opacity: 0.9; }

  /* Section heading */
  .section-title {
    font-size: 11pt;
    font-weight: 700;
    color: #3a3128;
    border-bottom: 1px solid #ddd;
    padding-bottom: 4px;
    margin: 16px 0 8px 0;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  /* Info grid */
  .info-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 24px;
    font-size: 9pt;
    margin-bottom: 10px;
  }
  .info-grid .row { display: flex; gap: 6px; }
  .info-grid .lbl { color: #666; min-width: 120px; }
  .info-grid .val { font-weight: 600; }

  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 8.5pt;
    margin-bottom: 8px;
  }
  thead tr { background: #3a3128; color: white; }
  thead th {
    padding: 5px 6px;
    font-weight: 600;
    text-align: left;
    font-size: 8pt;
    white-space: nowrap;
  }
  thead th.right, tbody td.right { text-align: right; }
  thead th.center, tbody td.center { text-align: center; }
  tbody tr:nth-child(even) { background: #f9f7f5; }
  tbody tr:last-child { font-weight: 700; border-top: 1.5px solid #3a3128; }
  tbody td { padding: 4px 6px; vertical-align: top; }
  .red { color: #dc2626; }
  .green { color: #16a34a; }
  .dim { color: #aaa; }

  /* Saldos box */
  .saldos-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-bottom: 12px;
  }
  .saldo-card {
    border: 1px solid #ddd;
    border-radius: 6px;
    padding: 8px 10px;
    background: #faf9f8;
  }
  .saldo-card .label { font-size: 8.5pt; color: #666; }
  .saldo-card .valor { font-size: 13pt; font-weight: 700; color: #3a3128; margin-top: 2px; }
  .saldo-card .tipo { font-size: 7.5pt; color: #999; }

  /* Condomínio info box */
  .condo-box {
    border: 1px solid #e0d9d2;
    border-radius: 6px;
    padding: 10px 12px;
    background: #fdfcfb;
    margin-bottom: 10px;
    font-size: 9pt;
  }
  .condo-box strong { font-size: 10.5pt; display: block; margin-bottom: 4px; }
  .condo-box .row { margin-bottom: 2px; }
  .condo-box .lbl { color: #666; display: inline-block; min-width: 90px; }

  .morosos-atraso {
    font-size: 8pt;
    color: #666;
    margin-bottom: 4px;
  }
  .highlight-box {
    background: #fef2f2;
    border: 1px solid #fca5a5;
    border-radius: 6px;
    padding: 8px 12px;
    margin-bottom: 8px;
    font-size: 9pt;
  }
  .note { font-size: 8pt; color: #666; margin-top: 6px; font-style: italic; }
</style>
</head>
<body>
  <div class="corner-tl"></div>
  <div class="corner-br"></div>
  <div class="sidebar-line"></div>
  <div class="page-num">Relatório mensal | ${mesNome} ${ano}</div>

  <!-- HEADER -->
  <div class="header">
    <div class="title">
      <h1>Relatório mensal | ${mesNome} ${ano}</h1>
      <div class="subtitle">${CONDOMINIO.nome}</div>
    </div>
    ${logoSrc ? `<img src="${logoSrc}" />` : ""}
  </div>

  <!-- INFO GERAL -->
  <div class="section-title">Informação Geral</div>
  <div class="condo-box">
    <strong>${CONDOMINIO.nome}</strong>
    <div class="row"><span class="lbl">Contribuinte:</span> ${CONDOMINIO.nif}</div>
    <div class="row"><span class="lbl">Morada:</span> ${CONDOMINIO.morada}, ${CONDOMINIO.localidade}</div>
    <div class="row"><span class="lbl">N.º Frações:</span> 33 [22 habitação + 5 comércio + 6 garagem]</div>
    <div class="row"><span class="lbl">IBAN:</span> ${CONDOMINIO.iban}</div>
  </div>

  <!-- SALDOS -->
  <div class="section-title">Saldos em Conta</div>
  <div class="saldos-grid">
    <div class="saldo-card">
      <div class="tipo">Depósito à Ordem</div>
      <div class="label">Conta Corrente (Condomínio)</div>
      <div class="valor">${fmt(saldos.saldo_conta_corrente ?? 0)}</div>
    </div>
    <div class="saldo-card">
      <div class="tipo">Depósito à Ordem</div>
      <div class="label">Fundo de Reserva</div>
      <div class="valor">${fmt(saldos.saldo_fundo_reserva ?? 0)}</div>
    </div>
    <div class="saldo-card">
      <div class="tipo">Depósito a Prazo</div>
      <div class="label">Quota Extra</div>
      <div class="valor">${fmt(saldos.saldo_quota_extra ?? 0)}</div>
    </div>
    <div class="saldo-card">
      <div class="tipo">Depósito a Prazo</div>
      <div class="label">Obras / Fundo Obras</div>
      <div class="valor">${fmt(saldos.saldo_obras ?? 0)}</div>
    </div>
  </div>
  <div style="text-align:right; font-size:9pt; font-weight:700; margin-bottom:12px;">
    Total em conta: ${fmt(totalSaldo)}
  </div>

  <!-- ENTRADAS -->
  <div class="section-title">Entradas</div>
  <table>
    <thead>
      <tr>
        <th>Designação</th>
        <th class="right">Valor a Receber</th>
        <th class="right">Montante Recebido até ${fmtNum(mes).padStart(2,"0")}/${ano}</th>
        <th class="right">Valor em Atraso</th>
      </tr>
    </thead>
    <tbody>
      ${entradasRows}
      <tr>
        <td>Total</td>
        <td class="right">${fmt(totalEntradas)}</td>
        <td class="right">${fmt(totalEntradasPago)}</td>
        <td class="right ${totalEntradasAtraso > 0 ? 'red' : ''}">${fmt(totalEntradasAtraso)}</td>
      </tr>
    </tbody>
  </table>

  <!-- Condomínio + Fundo Reserva em atraso (este mês) -->
  ${data.condAtraso + data.frAtraso > 0 ? `
  <div class="highlight-box">
    <strong>Quotas em Atraso (${mesNome} ${ano})</strong><br>
    Condomínio: <strong class="red">${fmt(data.condAtraso)}</strong> &nbsp;·&nbsp;
    Fundo de Reserva: <strong class="red">${fmt(data.frAtraso)}</strong>
  </div>
  ` : ""}

  <!-- MOROSOS -->
  <div class="section-title">Morosos — Condomínio em Atraso</div>
  ${morosos.length === 0 ? `<p style="color:#16a34a; font-size:9pt;">✓ Sem morosos em atraso.</p>` : `
  <table>
    <thead>
      <tr>
        <th style="width:8%">Fração</th>
        <th>Proprietário</th>
        <th>Meses em Atraso</th>
        <th class="right">Total em Dívida</th>
      </tr>
    </thead>
    <tbody>
      ${morososRows}
      <tr>
        <td colspan="3">Total em dívida</td>
        <td class="right red">${fmt(morosos.reduce((s, m) => s + m.total, 0))}</td>
      </tr>
    </tbody>
  </table>
  `}

  <!-- SAÍDAS / ORÇAMENTO -->
  <div class="page-break"></div>
  <div class="corner-tl"></div>
  <div class="corner-br"></div>
  <div class="sidebar-line"></div>
  <div class="page-num">Relatório mensal | ${mesNome} ${ano}</div>

  <div class="header" style="margin-top:0;">
    <div class="title">
      <h1>Saídas — Execução Orçamental</h1>
      <div class="subtitle">${mesNome} ${ano} · Jan–${MESES[mes].slice(0, 3)} ${ano}</div>
    </div>
    ${logoSrc ? `<img src="${logoSrc}" />` : ""}
  </div>

  <table>
    <thead>
      <tr>
        <th>Rubricas Orçamentadas</th>
        <th class="right">Orçamento ${ano}</th>
        <th class="right">V. Mensal</th>
        ${MESES.slice(1).map((m, i) => `<th class="center" style="font-size:7.5pt;">${m.slice(0, 3)}</th>`).join("")}
        <th class="right">Diferença</th>
      </tr>
    </thead>
    <tbody>
      ${orcTableRows}
      <tr>
        <td>Total das Despesas</td>
        <td class="right">${fmtNum(totalOrcAnual)} €</td>
        <td class="right">${fmtNum(totalOrcMensal)} €</td>
        ${Array.from({ length: 12 }, (_, i) => {
          const m = i + 1;
          if (m > mes) return `<td class="center dim">-</td>`;
          const v = Object.values(data.despesasPorMes[m] ?? {}).reduce((s: number, x) => s + (x as number), 0);
          return `<td class="center">${v > 0 ? fmtNum(v) : "-"} €</td>`;
        }).join("")}
        <td class="right ${totalDif < 0 ? 'red' : 'green'}">${fmtNum(totalDif)} €</td>
      </tr>
    </tbody>
  </table>

  <p class="note">* Valores das despesas importados do extracto bancário Santander. Saldos actualizados manualmente.</p>

</body>
</html>`;
}

// ─── Email ────────────────────────────────────────────────────────────────────
async function enviarRelatorioEmail(params: {
  mes: number; ano: number; pdfPath: string;
}): Promise<void> {
  const mesNome = MESES[params.mes];
  const subject = `Relatório Mensal — ${mesNome} ${params.ano}`;
  const html = `
    <p>Boa tarde,</p>
    <p>Segue em anexo o <strong>Relatório Mensal de ${mesNome} ${params.ano}</strong> do ${CONDOMINIO.nome}.</p>
    <p>Este relatório inclui o estado das entradas, morosos, execução orçamental e saldos das contas.</p>
    <br>
    <p>Com os melhores cumprimentos,</p>
    <p><strong>A Administração do Condomínio</strong><br>${CONDOMINIO.nome}</p>
  `;
  const tmpHtml = path.join(PDF_DIR, `_email_${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html, "utf8");
  await new Promise<void>((resolve, reject) => {
    const cmd = `cat "${tmpHtml}" | send-email --to "${CONDOMINIO.email}" --subject "${subject}" --html - --attach "${params.pdfPath}"`;
    exec(cmd, (err, _stdout, stderr) => {
      fs.unlinkSync(tmpHtml);
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

// ─── Core: gerar relatório ────────────────────────────────────────────────────
export async function gerarRelatorioMensal(mes: number, ano: number, sendEmail = true): Promise<{
  pdfPath: string;
  filename: string;
  emailEnviado: boolean;
}> {
  const dados = await calcularRelatorio(mes, ano);
  const html = buildRelatorioHtml(dados);
  const filename = `relatorio_${ano}_${String(mes).padStart(2, "0")}.pdf`;
  const pdfPath = path.join(PDF_DIR, filename);
  await htmlToPdf(html, pdfPath, { landscape: true });

  let emailEnviado = false;
  if (sendEmail) {
    try {
      await enviarRelatorioEmail({ mes, ano, pdfPath });
      emailEnviado = true;
    } catch (e) {
      console.error("[relatorio] Erro email:", e);
    }
  }

  return { pdfPath, filename, emailEnviado };
}

// ─── Routes ──────────────────────────────────────────────────────────────────
export const relatorioRoutes = new Hono()

  .post("/gerar", requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const now = new Date();
    const mes = Number(body.mes ?? now.getMonth() + 1);
    const ano = Number(body.ano ?? now.getFullYear());
    const sendEmail = body.sendEmail !== false;

    if (mes < 1 || mes > 12) return c.json({ error: "mes inválido" }, 400);

    const result = await gerarRelatorioMensal(mes, ano, sendEmail);
    return c.json({
      ok: true,
      filename: result.filename,
      pdfUrl: `/api/relatorio/pdf/${result.filename}`,
      emailEnviado: result.emailEnviado,
    });
  })

  .get("/pdf/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (filename.includes("..") || filename.includes("/")) return c.text("Not found", 404);
    const p = path.join(PDF_DIR, filename);
    if (!fs.existsSync(p)) return c.text("Not found", 404);
    const buf = fs.readFileSync(p);
    return new Response(buf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
      },
    });
  })

  .get("/", requireAdmin, async (c) => {
    const files = fs.readdirSync(PDF_DIR)
      .filter(f => f.startsWith("relatorio_") && f.endsWith(".pdf"))
      .map(f => {
        const parts = f.replace("relatorio_", "").replace(".pdf", "").split("_");
        const ano = parseInt(parts[0]);
        const mes = parseInt(parts[1]);
        const stat = fs.statSync(path.join(PDF_DIR, f));
        return {
          filename: f,
          mes, ano,
          mesNome: MESES[mes] ?? "?",
          pdfUrl: `/api/relatorio/pdf/${f}`,
          geradoEm: stat.mtime.toISOString(),
          tamanho: stat.size,
        };
      })
      .sort((a, b) => b.ano - a.ano || b.mes - a.mes);
    return c.json(files);
  });

// ─── Cron: último dia do mês ─────────────────────────────────────────────────
export function scheduleRelatoriosCron() {
  function msUntilLastDayOfMonth(): number {
    const now = new Date();
    // Last day at 23:00
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 0, 0, 0);
    if (lastDay <= now) {
      const nextLast = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 0, 0, 0);
      return nextLast.getTime() - now.getTime();
    }
    return lastDay.getTime() - now.getTime();
  }

  function scheduleNext() {
    const ms = msUntilLastDayOfMonth();
    console.log(`[relatorio-cron] Próximo relatório em ${Math.round(ms / 60000)} min`);
    setTimeout(async () => {
      const now = new Date();
      const mes = now.getMonth() + 1;
      const ano = now.getFullYear();
      console.log(`[relatorio-cron] Gerando relatório ${mes}/${ano}...`);
      try {
        const r = await gerarRelatorioMensal(mes, ano, true);
        console.log(`[relatorio-cron] Gerado: ${r.filename}, email: ${r.emailEnviado}`);
      } catch (e) {
        console.error("[relatorio-cron] Erro:", e);
      }
      scheduleNext();
    }, ms);
  }

  scheduleNext();
}
