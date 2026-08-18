/**
 * Rateios / comparticipações — dinheiro transitório na Conta à Ordem.
 *
 * Fluxo (ex.: Campainhas):
 *   1. Admin cria campanha: valor unitário + N frações (ou quantidade) + keywords
 *   2. Sync bancário: créditos €47,50 com keyword → auto-registo (sem cota extra)
 *   3. Quando N recebidos → status "completa"
 *   4. Débito ≈ N×valor (ex. €332,50) → auto "paga" + despesa rateio
 *
 * Não cria linhas em `quotas` — não é quota mensal / cota extra.
 */

import { eq, sql, inArray } from "drizzle-orm";
import { db } from "../database";
import { rateioCampanhas, rateioPagamentos, fracoes } from "../database/schema";
import { getFracaoByIBAN, learnIBAN, learnAlias } from "./identity-matrix";
import { learnPagadorPerfil, lookupPagadorPerfil } from "./pagador-perfis";
import { normalizeIBAN } from "./iban";

const VALOR_TOL = 0.05;

export interface RateioMatch {
  campanhaId: string;
  nome: string;
  valorUnitario: number;
  quantidadeEsperada: number;
  quantidadeRecebida: number;
  fracoesEsperadas: string[];
}

function normDesc(s: string): string {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extrai nome do pagador do descritivo Santander (PSD2 muitas vezes não traz debtor_name/IBAN). */
export function extractPayerFromDescription(descricao?: string | null): string | null {
  if (!descricao) return null;
  const raw = descricao.trim();
  const m1 = raw.match(
    /(?:TRF\.?\s*IMED\.?|TRANSF(?:ERENCIA)?(?:\s*IMED(?:IATA)?)?)\s*DE\s+(.+?)(?:\s*[-–]\s*\d{5,}|\s*$)/i,
  );
  if (m1?.[1]) {
    const name = m1[1].replace(/\s+DA\s*$/i, "").trim();
    if (name.length >= 5) return name;
  }
  const m2 = raw.match(/^DE\s+(.+?)(?:\s*[-–]\s*\d{5,})\s*$/i);
  if (m2?.[1] && m2[1].trim().length >= 5) return m2[1].trim();
  return null;
}

function parseFracoesEsperadas(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p)) return p.map(String).map((x) => x.toUpperCase());
  } catch { /* ignore */ }
  return raw.split(/[,;\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
}

function toMatch(c: typeof rateioCampanhas.$inferSelect): RateioMatch {
  return {
    campanhaId: c.id,
    nome: c.nome,
    valorUnitario: c.valorUnitario,
    quantidadeEsperada: c.quantidadeEsperada,
    quantidadeRecebida: c.quantidadeRecebida,
    fracoesEsperadas: parseFracoesEsperadas(c.fracoesEsperadas),
  };
}

/** Campanhas ainda a receber ou à espera do fornecedor. */
async function campanhasActivas() {
  return db
    .select()
    .from(rateioCampanhas)
    .where(sql`${rateioCampanhas.status} IN ('aberta', 'completa')`);
}

/** Campanhas que ainda podem receber créditos (usa contagem real de pagamentos, não o contador denormalizado). */
async function campanhasParaCredito() {
  const rows = await db.select().from(rateioCampanhas);
  const out = [];
  for (const c of rows) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(rateioPagamentos)
      .where(eq(rateioPagamentos.campanhaId, c.id));
    if (Number(n) < c.quantidadeEsperada) out.push(c);
  }
  return out;
}

/**
 * Match de CRÉDITO → campanha aberta.
 * Prioridade: keyword+valor → valor único entre campanhas abertas.
 */
export async function matchRateioCampanha(input: {
  valor: number;
  descricao?: string | null;
}): Promise<RateioMatch | null> {
  const valor = Math.abs(input.valor);
  const desc = normDesc(input.descricao ?? "");

  const activas = await campanhasParaCredito();
  if (activas.length === 0) return null;

  const byValor = activas.filter((c) => Math.abs(c.valorUnitario - valor) <= VALOR_TOL);

  for (const c of byValor) {
    const kws = (c.keywords ?? "").split(",").map((k) => normDesc(k)).filter(Boolean);
    if (kws.length === 0 || kws.some((k) => desc.includes(k))) return toMatch(c);
  }

  if (byValor.length === 1) return toMatch(byValor[0]);

  for (const c of activas) {
    const kws = (c.keywords ?? "").split(",").map((k) => normDesc(k)).filter(Boolean);
    if (kws.length > 0 && kws.some((k) => desc.includes(k)) && Math.abs(c.valorUnitario - valor) <= VALOR_TOL) {
      return toMatch(c);
    }
  }

  return null;
}

/**
 * Match de DÉBITO → pagamento ao fornecedor.
 * Valor ≈ quantidade_esperada × valor_unitario OU total_recebido (±tol).
 */
export async function matchRateioPagamentoFornecedor(input: {
  valor: number;
  descricao?: string | null;
}): Promise<RateioMatch | null> {
  const valor = Math.abs(input.valor);
  const desc = normDesc(input.descricao ?? "");

  // Inclui 'paga' sem TXN de fornecedor ligada (backfill)
  const activas = await db
    .select()
    .from(rateioCampanhas)
    .where(sql`(
      ${rateioCampanhas.status} IN ('aberta', 'completa')
      OR (${rateioCampanhas.status} = 'paga' AND ${rateioCampanhas.pagoBankTransactionId} IS NULL)
    )`);
  if (activas.length === 0) return null;

  const scored: Array<{ c: typeof activas[0]; score: number }> = [];
  for (const c of activas) {
    const esperado = Math.round(c.valorUnitario * c.quantidadeEsperada * 100) / 100;
    const recebido = Math.round((c.totalRecebido ?? 0) * 100) / 100;
    let score = 0;
    if (Math.abs(esperado - valor) <= VALOR_TOL) score += 50;
    if (recebido > 0 && Math.abs(recebido - valor) <= VALOR_TOL) score += 40;
    const kws = (c.keywords ?? "").split(",").map((k) => normDesc(k)).filter(Boolean);
    if (kws.some((k) => desc.includes(k))) score += 30;
    if (score >= 50) scored.push({ c, score });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  return toMatch(scored[0].c);
}

/**
 * Associa pagador → fração esperada com multi-sinal:
 *   IBAN (+50) · perfil pagador (+40) · nome/alias (+35) · descritivo fração (+25)
 * Threshold: score ≥ 50 (um sinal forte) ou ≥ 35 com ≥2 critérios.
 */
export async function resolverFracaoRateio(input: {
  campanhaId: string;
  debtorName?: string | null;
  descricao?: string | null;
  iban?: string | null;
  valor?: number;
  fracaoNumero?: string | null;
}): Promise<{ fracaoId: string; fracaoNumero: string; criterios: string[] } | null> {
  if (input.fracaoNumero) {
    const [f] = await db
      .select({ id: fracoes.id, numero: fracoes.numero })
      .from(fracoes)
      .where(eq(fracoes.numero, input.fracaoNumero.toUpperCase()))
      .limit(1);
    if (f) return { fracaoId: f.id, fracaoNumero: f.numero, criterios: ["manual"] };
  }

  const [camp] = await db
    .select()
    .from(rateioCampanhas)
    .where(eq(rateioCampanhas.id, input.campanhaId))
    .limit(1);
  const esperadas = parseFracoesEsperadas(camp?.fracoesEsperadas);
  if (esperadas.length === 0) return null;

  const rows = await db
    .select({
      id: fracoes.id,
      numero: fracoes.numero,
      nome: fracoes.proprietarioNome,
      aliases: fracoes.proprietarioAliases,
      ibans: fracoes.ibansConhecidos,
    })
    .from(fracoes)
    .where(inArray(fracoes.numero, esperadas));

  const pagos = await db
    .select({ fracaoId: rateioPagamentos.fracaoId })
    .from(rateioPagamentos)
    .where(eq(rateioPagamentos.campanhaId, input.campanhaId));
  const pagosSet = new Set(pagos.map((p) => p.fracaoId).filter(Boolean) as string[]);

  const candidatos = rows.filter((r) => !pagosSet.has(r.id));
  if (candidatos.length === 0) return null;

  const extractedName = extractPayerFromDescription(input.descricao);
  const effectiveName = (input.debtorName?.trim() || extractedName || "").trim() || null;
  const blob = normDesc(`${effectiveName ?? ""} ${input.descricao ?? ""}`);
  const ibanNorm = normalizeIBAN(input.iban);

  type Cand = { id: string; numero: string; score: number; criterios: string[]; ibans: string[] };
  const scored: Cand[] = [];

  const parseIbans = (raw: string | null): string[] => {
    try {
      const p = JSON.parse(raw ?? "[]");
      if (Array.isArray(p)) {
        return p.map((i) => normalizeIBAN(String(i))).filter((i): i is string => !!i);
      }
    } catch { /* */ }
    return [];
  };

  const nomeMatch = (refs: string[], hay: string): boolean => {
    for (const ref of refs) {
      if (!hay || !ref) continue;
      if (hay === ref || hay.includes(ref) || ref.includes(hay)) return true;
      const tokens = ref.split(" ").filter((t) => t.length > 2);
      const hit = tokens.filter((t) => hay.includes(t)).length;
      if (tokens.length === 1 && tokens[0].length >= 4 && hit === 1) return true;
      if (tokens.length >= 2 && hit >= Math.max(2, Math.ceil(tokens.length * 0.5))) return true;
    }
    return false;
  };

  for (const r of candidatos) {
    let score = 0;
    const criterios: string[] = [];
    const ibans = parseIbans(r.ibans);

    if (ibanNorm && ibans.includes(ibanNorm)) {
      score += 50;
      criterios.push("iban");
    }

    const aliases: string[] = [];
    try {
      const p = JSON.parse(r.aliases ?? "[]");
      if (Array.isArray(p)) aliases.push(...p.map(String));
    } catch { /* */ }
    const refs = [r.nome ?? "", ...aliases].map(normDesc).filter(Boolean);
    if (nomeMatch(refs, blob)) {
      score += 35;
      criterios.push("nome");
    }

    if (blob && new RegExp(`\\bFRAC(?:AO|CAO)?\\s*${r.numero}\\b`).test(blob)) {
      score += 25;
      criterios.push("descricao_fracao");
    } else if (blob && new RegExp(`\\b${r.numero}\\b`).test(blob)) {
      score += 20;
      criterios.push("descricao_fracao");
    }

    if (score > 0) scored.push({ id: r.id, numero: r.numero, score, criterios, ibans });
  }

  // Perfil pagador (usa nome extraído do descritivo se PSD2 não trouxe debtor_name)
  if (input.valor && (ibanNorm || effectiveName)) {
    const perfil = await lookupPagadorPerfil({
      iban: ibanNorm,
      debtorName: effectiveName,
      valor: input.valor,
    });
    if (perfil && esperadas.includes(perfil.fracaoNumero.toUpperCase()) && !pagosSet.has(perfil.fracaoId)) {
      const existing = scored.find((s) => s.numero === perfil.fracaoNumero);
      if (existing) {
        existing.score += 40;
        existing.criterios.push("perfil_pagador");
      } else {
        const row = candidatos.find((c) => c.id === perfil.fracaoId);
        scored.push({
          id: perfil.fracaoId,
          numero: perfil.fracaoNumero,
          score: 40 + (perfil.matchedBy.startsWith("iban") ? 20 : 0),
          criterios: ["perfil_pagador"],
          ibans: parseIbans(row?.ibans ?? null),
        });
      }
    }
  }

  if (ibanNorm && !scored.some((s) => s.criterios.includes("iban"))) {
    try {
      const byIban = await getFracaoByIBAN(ibanNorm);
      for (const f of byIban) {
        if (!esperadas.includes(f.idFracao.toUpperCase())) continue;
        const row = candidatos.find((c) => c.numero.toUpperCase() === f.idFracao.toUpperCase());
        if (!row) continue;
        scored.push({ id: row.id, numero: row.numero, score: 50, criterios: ["iban"], ibans: parseIbans(row.ibans) });
      }
    } catch { /* matriz pode não estar carregada */ }
  }

  // Proxy multi-fração: nome casa com fração JÁ paga nesta campanha → irmã com mesmo IBAN ainda em falta
  if (scored.length === 0 && blob) {
    const pagosRows = rows.filter((r) => pagosSet.has(r.id));
    for (const pago of pagosRows) {
      const aliases: string[] = [];
      try {
        const p = JSON.parse(pago.aliases ?? "[]");
        if (Array.isArray(p)) aliases.push(...p.map(String));
      } catch { /* */ }
      const refs = [pago.nome ?? "", ...aliases].map(normDesc).filter(Boolean);
      if (!nomeMatch(refs, blob)) continue;
      const pagoIbans = parseIbans(pago.ibans);
      if (pagoIbans.length === 0) continue;
      const siblings = candidatos.filter((c) => {
        const ibs = parseIbans(c.ibans);
        return ibs.some((i) => pagoIbans.includes(i));
      });
      if (siblings.length === 1) {
        scored.push({
          id: siblings[0].id,
          numero: siblings[0].numero,
          score: 55,
          criterios: ["nome", "iban_irmao"],
          ibans: parseIbans(siblings[0].ibans),
        });
        break;
      }
    }
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const runner = scored[1];
  if (runner && best.score === runner.score) return null; // empate — não arriscar
  if (best.score < 35) return null;
  // Dentro das frações esperadas ainda por pagar: nome único basta (PSD2 sem IBAN)
  const nomeUnico =
    best.criterios.includes("nome") &&
    scored.filter((s) => s.criterios.includes("nome")).length === 1;
  if (best.score < 50 && best.criterios.length < 2 && !nomeUnico) return null;

  return { fracaoId: best.id, fracaoNumero: best.numero, criterios: best.criterios };
}

/** Regista crédito de rateio e actualiza contadores. */
export async function registarRateioPagamento(input: {
  campanhaId: string;
  bankTransactionId: string;
  valor: number;
  debtorName?: string | null;
  descricao?: string | null;
  iban?: string | null;
  data: Date;
  fracaoId?: string | null;
  fracaoNumero?: string | null;
}): Promise<{ pagamentoId: string; campanhaCompleta: boolean; fracaoNumero?: string }> {
  const existing = await db
    .select({ id: rateioPagamentos.id })
    .from(rateioPagamentos)
    .where(eq(rateioPagamentos.bankTransactionId, input.bankTransactionId))
    .limit(1);
  if (existing.length > 0) {
    return { pagamentoId: existing[0].id, campanhaCompleta: false };
  }

  let fracaoId = input.fracaoId ?? null;
  let fracaoNumero = input.fracaoNumero ?? undefined;
  if (!fracaoId) {
    const resolved = await resolverFracaoRateio({
      campanhaId: input.campanhaId,
      debtorName: input.debtorName,
      descricao: input.descricao,
      iban: input.iban,
      valor: input.valor,
      fracaoNumero: input.fracaoNumero,
    });
    if (resolved) {
      fracaoId = resolved.fracaoId;
      fracaoNumero = resolved.fracaoNumero;
      console.log(
        `[rateio] fração ${resolved.fracaoNumero} via [${resolved.criterios.join("+")}]`,
      );
    }
  }

  const inserted = await db
    .insert(rateioPagamentos)
    .values({
      campanhaId: input.campanhaId,
      bankTransactionId: input.bankTransactionId,
      fracaoId,
      valor: Math.abs(input.valor),
      debtorName: input.debtorName ?? null,
      data: input.data,
    })
    .returning({ id: rateioPagamentos.id });

  const [camp] = await db
    .select()
    .from(rateioCampanhas)
    .where(eq(rateioCampanhas.id, input.campanhaId))
    .limit(1);

  // Contadores a partir dos pagamentos reais (evita campanha "fechada" artificialmente)
  const [{ n: qRecRaw, t: tRecRaw }] = await db
    .select({
      n: sql<number>`count(*)`,
      t: sql<number>`coalesce(sum(${rateioPagamentos.valor}), 0)`,
    })
    .from(rateioPagamentos)
    .where(eq(rateioPagamentos.campanhaId, input.campanhaId));
  const qRec = Number(qRecRaw);
  const tRec = Math.round(Number(tRecRaw) * 100) / 100;
  const completa = qRec >= (camp?.quantidadeEsperada ?? 1);

  // Se estava "paga" mas ainda a receber backfill, só mantém "paga" quando completa + fornecedor ligado
  let nextStatus = completa ? "completa" : "aberta";
  if (camp?.status === "paga" && completa && camp.pagoBankTransactionId) nextStatus = "paga";

  await db
    .update(rateioCampanhas)
    .set({
      quantidadeRecebida: qRec,
      totalRecebido: tRec,
      status: nextStatus,
      updatedAt: new Date(),
    })
    .where(eq(rateioCampanhas.id, input.campanhaId));

  // Aprendizagem: IBAN + alias + perfil → próximos rateios/quotas sem intervenção
  if (fracaoNumero && fracaoId) {
    try {
      const learnedName =
        input.debtorName?.trim() ||
        extractPayerFromDescription(input.descricao) ||
        null;
      if (input.iban) await learnIBAN(fracaoNumero, input.iban);
      if (learnedName) await learnAlias(fracaoNumero, learnedName);
      await learnPagadorPerfil({
        iban: input.iban,
        debtorName: learnedName,
        valor: Math.abs(input.valor),
        fracaoId,
        fracaoNumero,
        rubrica: "extra",
        fonte: "auto",
      });
    } catch (e) {
      console.warn("[rateio] aprendizagem falhou:", e);
    }
  }

  console.log(
    `[rateio] +€${Math.abs(input.valor).toFixed(2)} → ${camp?.nome}` +
    `${fracaoNumero ? ` (${fracaoNumero})` : ""}` +
    ` ${qRec}/${camp?.quantidadeEsperada}${completa ? " COMPLETA" : ""}`,
  );

  return { pagamentoId: inserted[0].id, campanhaCompleta: completa, fracaoNumero };
}

/** Marca campanha como paga ao fornecedor (débito bancário). */
export async function marcarRateioPago(input: {
  campanhaId: string;
  bankTransactionId: string;
  valor: number;
  fornecedorNome?: string | null;
  data?: Date;
}): Promise<void> {
  await db
    .update(rateioCampanhas)
    .set({
      status: "paga",
      pagoValor: Math.abs(input.valor),
      pagoBankTransactionId: input.bankTransactionId,
      pagoEm: input.data ?? new Date(),
      fornecedorNome: input.fornecedorNome ?? undefined,
      updatedAt: new Date(),
    })
    .where(eq(rateioCampanhas.id, input.campanhaId));

  console.log(
    `[rateio] PAGO fornecedor €${Math.abs(input.valor).toFixed(2)} campanha=${input.campanhaId}`,
  );
}

/** Total ainda retido na CC (aberta/completa, ainda não pago ao fornecedor). */
export async function totalRateioCativo(): Promise<number> {
  const rows = await db
    .select({ total: rateioCampanhas.totalRecebido })
    .from(rateioCampanhas)
    .where(sql`${rateioCampanhas.status} IN ('aberta', 'completa')`);
  return Math.round(rows.reduce((s, r) => s + (r.totalRecebido ?? 0), 0) * 100) / 100;
}

export async function ensureRateioCampanha(input: {
  nome: string;
  valorUnitario: number;
  quantidadeEsperada: number;
  keywords: string;
  descricao?: string;
  fracoesEsperadas?: string[];
}): Promise<string> {
  const [ex] = await db
    .select({ id: rateioCampanhas.id })
    .from(rateioCampanhas)
    .where(eq(rateioCampanhas.nome, input.nome))
    .limit(1);

  const fracoesJson = input.fracoesEsperadas
    ? JSON.stringify(input.fracoesEsperadas.map((f) => f.toUpperCase()))
    : null;

  if (ex) {
    await db
      .update(rateioCampanhas)
      .set({
        valorUnitario: input.valorUnitario,
        quantidadeEsperada: input.quantidadeEsperada,
        keywords: input.keywords,
        descricao: input.descricao ?? undefined,
        fracoesEsperadas: fracoesJson ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(rateioCampanhas.id, ex.id));
    return ex.id;
  }

  const [row] = await db
    .insert(rateioCampanhas)
    .values({
      nome: input.nome,
      descricao: input.descricao ?? null,
      valorUnitario: input.valorUnitario,
      quantidadeEsperada: input.quantidadeEsperada,
      keywords: input.keywords,
      fracoesEsperadas: fracoesJson,
      status: "aberta",
    })
    .returning({ id: rateioCampanhas.id });
  return row.id;
}
