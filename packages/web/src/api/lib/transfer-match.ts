/**
 * Matching transversal de transferências — identidade + finalidade.
 *
 * Usado por sync (via process-staged), process-staged, reavaliação de rateios
 * e classificação manual. Não é um patch pontual: a mesma função decide
 * pagador (IBAN extraído do payload/coluna → fracoes.ibansConhecidos / alias /
 * nome / localização) e propósito (keywords de quota_tipos + valor vs quotas
 * em aberto, depois cascata).
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../database";
import {
  bankTransactions,
  fracoes,
  quotaTipos,
  quotas,
  rateioCampanhas,
  rateioPagamentos,
} from "../database/schema";
import {
  extractPayerFromDescription,
  getFracaoById,
  identifyByMultiMatch,
  learnAlias,
  learnIBAN,
  loadMatrizFromDB,
  MATRIZ_PROPRIEDADES,
  processarCascataAmortizacao,
  type FracaoIdentidade,
  type IdentificacaoResult,
  normStr,
} from "./identity-matrix";
import { learnPagadorPerfil } from "./pagador-perfis";
import { extractDebtorIbanFromBankTxn, normalizeIBAN } from "./iban";

const VALOR_TOL = 0.05;

export interface TransferSignals {
  descricao: string;
  amount: number;
  ibanSender?: string | null;
  debtorName?: string | null;
}

/** Sinais de um `bank_transactions` — IBAN da coluna OU do payload raw. */
export function signalsFromBankTransaction(
  txn: {
    description?: string | null;
    amount?: number | null;
    debtorIban?: string | null;
    debtorName?: string | null;
    rawData?: string | null;
  },
): TransferSignals {
  return {
    descricao: txn.description ?? "",
    amount: Math.abs(txn.amount ?? 0),
    ibanSender: extractDebtorIbanFromBankTxn(txn),
    debtorName: txn.debtorName ?? extractPayerFromDescription(txn.description),
  };
}

export interface TransferPurpose {
  kind: "extra" | "condominio" | "unknown";
  quotaTipoId?: string;
  quotaTipoNome?: string;
  quotaId?: string;
  criterios: string[];
}

export interface TransferMatch {
  identity: IdentificacaoResult | null;
  purpose: TransferPurpose;
  confidence: number;
  criterios: string[];
}

export interface AplicarResult {
  applied: boolean;
  quotaId?: string;
  fracao?: string;
  motivo: string;
}

type QuotaTipoRow = typeof quotaTipos.$inferSelect;
type OpenExtra = {
  id: string;
  fracaoId: string;
  fracaoNumero: string;
  valor: number;
  quotaTipoId: string | null;
};

let _tiposCache: QuotaTipoRow[] | null = null;

export async function loadQuotaTiposExtras(): Promise<QuotaTipoRow[]> {
  const rows = await db.select().from(quotaTipos);
  _tiposCache = rows.filter((t) => t.tipo === "extra" && t.ativo !== false);
  return _tiposCache;
}

function extraTipos(): QuotaTipoRow[] {
  return _tiposCache ?? [];
}

/** Keyword mais longa do tipo que aparece no descritivo (≥4 chars). */
export function bestKeywordHit(descricao: string, keywords: string | null | undefined): string | null {
  if (!keywords) return null;
  const d = normStr(descricao);
  let best: string | null = null;
  for (const raw of keywords.split(",")) {
    const k = normStr(raw);
    if (k.length < 4) continue;
    if (d.includes(k) && (!best || k.length > best.length)) best = k;
  }
  return best;
}

export function matchExtraTipoByKeyword(descricao: string, tipos?: QuotaTipoRow[]): QuotaTipoRow | null {
  const list = tipos ?? extraTipos();
  let best: { tipo: QuotaTipoRow; len: number } | null = null;
  for (const t of list) {
    const hit = bestKeywordHit(descricao, t.keywords);
    if (hit && (!best || hit.length > best.len)) best = { tipo: t, len: hit.length };
  }
  return best?.tipo ?? null;
}

async function loadOpenExtras(): Promise<OpenExtra[]> {
  const rows = await db
    .select({
      id: quotas.id,
      fracaoId: quotas.fracaoId,
      fracaoNumero: fracoes.numero,
      valor: quotas.valor,
      quotaTipoId: quotas.quotaTipoId,
    })
    .from(quotas)
    .innerJoin(fracoes, eq(quotas.fracaoId, fracoes.id))
    .where(and(eq(quotas.pago, false), eq(quotas.tipo, "extra")));
  return rows.map((r) => ({
    id: r.id,
    fracaoId: r.fracaoId,
    fracaoNumero: (r.fracaoNumero ?? "").toUpperCase(),
    valor: Number(r.valor),
    quotaTipoId: r.quotaTipoId,
  }));
}

function amountMatches(a: number, b: number): boolean {
  return Math.abs(a - b) <= VALOR_TOL;
}

function identificarFinalidade(opts: {
  descricao: string;
  amount: number;
  idFracao?: string;
  openExtras: OpenExtra[];
  tipos: QuotaTipoRow[];
}): TransferPurpose {
  const { descricao, amount, idFracao, openExtras, tipos } = opts;
  const kwTipo = matchExtraTipoByKeyword(descricao, tipos);

  const daFracao = idFracao
    ? openExtras.filter((e) => e.fracaoNumero === idFracao.toUpperCase())
    : [];

  if (kwTipo) {
    const daTipo = daFracao.filter(
      (e) => e.quotaTipoId === kwTipo.id && amountMatches(e.valor, amount),
    );
    return {
      kind: "extra",
      quotaTipoId: kwTipo.id,
      quotaTipoNome: kwTipo.nome,
      quotaId: daTipo[0]?.id,
      criterios: ["keyword", ...(daTipo[0] ? ["valor_quota_extra"] : [])],
    };
  }

  if (idFracao) {
    const porValor = daFracao.filter((e) => amountMatches(e.valor, amount));
    const tiposUnicos = new Set(porValor.map((e) => e.quotaTipoId).filter(Boolean));
    if (porValor.length >= 1 && tiposUnicos.size === 1) {
      const hit = porValor[0];
      const tipo = tipos.find((t) => t.id === hit.quotaTipoId);
      return {
        kind: "extra",
        quotaTipoId: hit.quotaTipoId ?? undefined,
        quotaTipoNome: tipo?.nome,
        quotaId: hit.id,
        criterios: ["valor_quota_extra"],
      };
    }
  }

  return { kind: "unknown", criterios: [] };
}

/**
 * Identifica pagador + finalidade. `identityOverride` = fração já conhecida
 * (LLM ou classificação manual).
 */
export async function matchTransferencia(
  input: TransferSignals & { identityOverride?: FracaoIdentidade | null },
): Promise<TransferMatch> {
  if (MATRIZ_PROPRIEDADES.length === 0) await loadMatrizFromDB();
  const tipos = extraTipos().length > 0 ? extraTipos() : await loadQuotaTiposExtras();
  const openExtras = await loadOpenExtras();
  const extrasEmAberto = openExtras.map((e) => ({ idFracao: e.fracaoNumero, valor: e.valor }));

  let identity: IdentificacaoResult | null = null;
  if (input.identityOverride) {
    identity = {
      fracao: input.identityOverride,
      confidence: 100,
      criterios: ["override"],
      ibanNovoAprendido: false,
    };
  } else {
    identity = await identifyByMultiMatch({
      descricao: input.descricao ?? "",
      amount: Math.abs(input.amount),
      ibanSender: input.ibanSender ?? undefined,
      debtorName: input.debtorName ?? undefined,
      extrasEmAberto,
    });
  }

  const purpose = identificarFinalidade({
    descricao: input.descricao ?? "",
    amount: Math.abs(input.amount),
    idFracao: identity?.fracao.idFracao,
    openExtras,
    tipos,
  });

  const criterios = [
    ...(identity?.criterios ?? []),
    ...purpose.criterios.filter((c) => !(identity?.criterios ?? []).includes(c)),
  ];

  return {
    identity,
    purpose,
    confidence: identity?.confidence ?? (purpose.kind === "extra" ? 40 : 0),
    criterios,
  };
}

function txDate(raw: unknown): Date {
  if (raw instanceof Date) return raw;
  if (typeof raw === "number") {
    return raw > 1e12 ? new Date(raw) : new Date(raw * 1000);
  }
  return new Date();
}

function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/** Mesmo descritivo + valor + dia já importado (duplicado Santander / re-sync). */
export async function findCreditoDuplicado(txn: {
  id: string;
  amount: number | null;
  description: string | null;
  date: Date | number | null;
}): Promise<{ id: string } | null> {
  const amount = txn.amount ?? 0;
  const desc = (txn.description ?? "").trim();
  if (!desc || amount === 0) return null;
  const day = txDate(txn.date);

  const rows = await db
    .select({
      id: bankTransactions.id,
      description: bankTransactions.description,
      amount: bankTransactions.amount,
      date: bankTransactions.date,
      importType: bankTransactions.importType,
      status: bankTransactions.status,
    })
    .from(bankTransactions)
    .where(and(
      eq(bankTransactions.imported, 1),
      sql`abs(${bankTransactions.amount} - ${amount}) < ${VALOR_TOL}`,
    ));

  const hit = rows.find(
    (r) =>
      r.id !== txn.id &&
      (r.description ?? "").trim() === desc &&
      sameUtcDay(txDate(r.date), day) &&
      r.status !== "ignored" &&
      r.importType != null,
  );
  return hit ? { id: hit.id } : null;
}

async function desligarRateio(txnId: string): Promise<void> {
  const existing = await db
    .select()
    .from(rateioPagamentos)
    .where(eq(rateioPagamentos.bankTransactionId, txnId))
    .limit(1);
  if (existing.length === 0) return;
  const campId = existing[0].campanhaId;
  await db.delete(rateioPagamentos).where(eq(rateioPagamentos.id, existing[0].id));

  const [{ n, t }] = await db
    .select({
      n: sql<number>`count(*)`,
      t: sql<number>`coalesce(sum(${rateioPagamentos.valor}), 0)`,
    })
    .from(rateioPagamentos)
    .where(eq(rateioPagamentos.campanhaId, campId));
  const qRec = Number(n);
  const tRec = Math.round(Number(t) * 100) / 100;
  const [camp] = await db.select().from(rateioCampanhas).where(eq(rateioCampanhas.id, campId)).limit(1);
  let status = camp?.status ?? "aberta";
  if (status !== "paga") status = qRec >= (camp?.quantidadeEsperada ?? 1) ? "completa" : "aberta";
  await db
    .update(rateioCampanhas)
    .set({ quantidadeRecebida: qRec, totalRecebido: tRec, status, updatedAt: new Date() })
    .where(eq(rateioCampanhas.id, campId));
}

async function fracaoDbId(numero: string): Promise<string | null> {
  const [row] = await db
    .select({ id: fracoes.id })
    .from(fracoes)
    .where(eq(fracoes.numero, numero))
    .limit(1);
  return row?.id ?? null;
}

/** IBAN partilhado: se a extra da fração já está paga, irmã com o mesmo IBAN ainda em dívida. */
async function siblingComExtraAberta(
  idFracao: string,
  quotaTipoId: string,
  amount: number,
): Promise<{ numero: string; quotaId: string; fracaoDbId: string } | null> {
  const origem = getFracaoById(idFracao);
  if (!origem || origem.ibansConhecidos.length === 0) return null;

  const ibans = new Set(
    origem.ibansConhecidos.map((i) => normalizeIBAN(i)).filter((i): i is string => !!i),
  );
  const irmas = MATRIZ_PROPRIEDADES.filter((f) => {
    if (f.idFracao === idFracao) return false;
    return f.ibansConhecidos.some((i) => {
      const n = normalizeIBAN(i);
      return n != null && ibans.has(n);
    });
  });
  if (irmas.length === 0) return null;

  const open = await loadOpenExtras();
  const hits: Array<{ numero: string; quotaId: string; fracaoDbId: string }> = [];
  for (const irma of irmas) {
    const extra = open.find(
      (e) =>
        e.fracaoNumero === irma.idFracao.toUpperCase() &&
        e.quotaTipoId === quotaTipoId &&
        amountMatches(e.valor, amount),
    );
    if (!extra) continue;
    hits.push({ numero: irma.idFracao, quotaId: extra.id, fracaoDbId: extra.fracaoId });
  }
  return hits.length === 1 ? hits[0] : null;
}

async function siblingExtraPorValor(
  idFracao: string,
  amount: number,
): Promise<{ numero: string; quotaId: string; fracaoDbId: string } | null> {
  const origem = getFracaoById(idFracao);
  if (!origem || origem.ibansConhecidos.length === 0) return null;
  const ibans = new Set(
    origem.ibansConhecidos.map((i) => normalizeIBAN(i)).filter((i): i is string => !!i),
  );
  const irmas = MATRIZ_PROPRIEDADES.filter((f) => {
    if (f.idFracao === idFracao) return false;
    return f.ibansConhecidos.some((i) => {
      const n = normalizeIBAN(i);
      return n != null && ibans.has(n);
    });
  });
  const open = await loadOpenExtras();
  const hits: Array<{ numero: string; quotaId: string; fracaoDbId: string }> = [];
  for (const irma of irmas) {
    const extras = open.filter(
      (e) => e.fracaoNumero === irma.idFracao.toUpperCase() && amountMatches(e.valor, amount),
    );
    if (extras.length === 1) {
      hits.push({ numero: irma.idFracao, quotaId: extras[0].id, fracaoDbId: extras[0].fracaoId });
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

async function marcarQuotaPaga(
  quotaId: string,
  date: Date,
  observacoes: string,
): Promise<void> {
  await db
    .update(quotas)
    .set({
      pago: true,
      dataPagamento: date,
      metodoPagamento: "transferência",
      observacoes,
    })
    .where(eq(quotas.id, quotaId));
}

async function marcarTxnProcessada(opts: {
  txnId: string;
  quotaId: string;
  observacoesPrefix?: string;
}): Promise<void> {
  await db
    .update(bankTransactions)
    .set({
      imported: 1,
      status: "processed",
      importType: "quota",
      importRefId: opts.quotaId,
      requiresManualReview: 0,
    })
    .where(eq(bankTransactions.id, opts.txnId));
}

/**
 * Aplica o match: paga extra identificada ou corre a cascata.
 * Converte rateio sem fração para quota extra quando o match chega.
 */
export async function aplicarMatchTransferencia(input: {
  txnId: string;
  description: string;
  amount: number;
  date: Date;
  ibanSender?: string | null;
  debtorName?: string | null;
  match: TransferMatch;
  observacoesPrefix?: string;
}): Promise<AplicarResult> {
  const identity = input.match.identity;
  if (!identity || identity.confidence < 55) {
    return { applied: false, motivo: "identidade insuficiente" };
  }

  const fracaoDBId = await fracaoDbId(identity.fracao.idFracao);
  if (!fracaoDBId) {
    return { applied: false, motivo: `fração ${identity.fracao.idFracao} sem UUID na BD` };
  }

  const prefix = input.observacoesPrefix ?? "[motor]";
  const obs =
    `${prefix} ${identity.confidence}% criterios:${input.match.criterios.join("+")}` +
    (identity.ibanNovoAprendido ? " [IBAN aprendido]" : "");
  const valor = Math.abs(input.amount);
  const mes = input.date.getMonth() + 1;
  const ano = input.date.getFullYear();

  let quotaId: string | undefined = input.match.purpose.quotaId;
  let fracaoNumero = identity.fracao.idFracao;
  let fracaoUuid = fracaoDBId;
  let purposeTipoId = input.match.purpose.quotaTipoId;

  if (input.match.purpose.kind === "extra" && purposeTipoId) {
    if (!quotaId) {
      const sibling = await siblingComExtraAberta(fracaoNumero, purposeTipoId, valor);
      if (sibling) {
        quotaId = sibling.quotaId;
        fracaoNumero = sibling.numero;
        fracaoUuid = sibling.fracaoDbId;
      }
    }
    if (quotaId) {
      const [q] = await db.select({ valor: quotas.valor }).from(quotas).where(eq(quotas.id, quotaId)).limit(1);
      const extraValor = Number(q?.valor ?? valor);
      await marcarQuotaPaga(quotaId, input.date, obs);
      const resto = parseFloat(Math.max(0, valor - extraValor).toFixed(2));
      if (resto > VALOR_TOL) {
        await processarCascataAmortizacao(fracaoNumero, resto, fracaoUuid, mes, ano, {
          dataPagamento: input.date,
          observacoes: obs,
        });
      }
    } else {
      const cascata = await processarCascataAmortizacao(fracaoNumero, valor, fracaoUuid, mes, ano, {
        dataPagamento: input.date,
        observacoes: obs,
        preferQuotaTipoId: purposeTipoId,
      });
      quotaId = cascata?.quotasPagas[0];
      if (!quotaId) {
        const inserted = await db
          .insert(quotas)
          .values({
            fracaoId: fracaoUuid,
            tipo: "extra",
            quotaTipoId: purposeTipoId,
            mes,
            ano,
            valor,
            fundoReserva: 0,
            pago: true,
            dataPagamento: input.date,
            metodoPagamento: "transferência",
            observacoes: obs,
          })
          .returning({ id: quotas.id });
        quotaId = inserted[0].id;
      }
    }
  } else {
    const sibling = await siblingExtraPorValor(fracaoNumero, valor);
    if (sibling) {
      quotaId = sibling.quotaId;
      fracaoNumero = sibling.numero;
      fracaoUuid = sibling.fracaoDbId;
      await marcarQuotaPaga(quotaId, input.date, obs);
    }
  }

  if (!quotaId) {
    const cascata = await processarCascataAmortizacao(fracaoNumero, valor, fracaoUuid, mes, ano, {
      dataPagamento: input.date,
      observacoes: obs,
    });
    quotaId = cascata?.quotasPagas[0];
    if (!quotaId) {
      const existing = await db
        .select({ id: quotas.id })
        .from(quotas)
        .where(and(
          eq(quotas.fracaoId, fracaoUuid),
          eq(quotas.mes, mes),
          eq(quotas.ano, ano),
          eq(quotas.tipo, "condominio"),
        ))
        .limit(1);
      if (existing.length > 0) {
        await marcarQuotaPaga(existing[0].id, input.date, obs);
        quotaId = existing[0].id;
      } else {
        const inserted = await db
          .insert(quotas)
          .values({
            fracaoId: fracaoUuid,
            tipo: "condominio",
            mes,
            ano,
            valor,
            fundoReserva: parseFloat((valor * 0.1).toFixed(2)),
            pago: true,
            dataPagamento: input.date,
            metodoPagamento: "transferência",
            observacoes: obs,
          })
          .returning({ id: quotas.id });
        quotaId = inserted[0].id;
      }
    }
  }

  if (!quotaId) return { applied: false, motivo: "sem quota para associar", fracao: fracaoNumero };

  await marcarTxnProcessada({ txnId: input.txnId, quotaId });
  await desligarRateio(input.txnId);

  const nome = input.debtorName?.trim() || extractPayerFromDescription(input.description);
  try {
    if (input.ibanSender) await learnIBAN(fracaoNumero, input.ibanSender);
    if (nome) await learnAlias(fracaoNumero, nome);
    await learnPagadorPerfil({
      iban: input.ibanSender,
      debtorName: nome,
      valor,
      fracaoId: fracaoUuid,
      fracaoNumero,
      rubrica: input.match.purpose.kind === "extra" ? "extra" : "condominio",
      fonte: "auto",
    });
  } catch (e) {
    console.warn("[transfer-match] learnPagadorPerfil falhou:", e);
  }

  return {
    applied: true,
    quotaId,
    fracao: fracaoNumero,
    motivo: input.match.criterios.join("+") || "match",
  };
}

export async function marcarDuplicadoIgnorado(txnId: string, originalId: string): Promise<void> {
  await db
    .update(bankTransactions)
    .set({
      imported: 1,
      status: "ignored",
      importType: null,
      requiresManualReview: 0,
    })
    .where(eq(bankTransactions.id, txnId));
  console.log(`[transfer-match] duplicado ${txnId} ignorado (já existe ${originalId})`);
}

/**
 * Candidatos ao matcher:
 *  - staging novo (imported=0, ainda não em revisão)
 *  - revisão só se keyword+valor extra (ex. duplicado campainhas) — NÃO as ~48 reviews
 *  - rateio importado sem fração (reavaliar extras como Campainhas)
 */
export async function selectTransacoesParaMatch(): Promise<Array<typeof bankTransactions.$inferSelect>> {
  const tipos = extraTipos().length > 0 ? extraTipos() : await loadQuotaTiposExtras();

  const stagingNovo = await db
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.imported, 0), eq(bankTransactions.requiresManualReview, 0)));

  const emReview = await db
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.imported, 0), eq(bankTransactions.requiresManualReview, 1)));

  const reviewExtra = emReview.filter((t) => {
    if ((t.amount ?? 0) <= 0) return false;
    const tipo = matchExtraTipoByKeyword(t.description ?? "", tipos);
    if (!tipo) return false;
    if (tipo.valorBase != null && amountMatches(Math.abs(t.amount ?? 0), Number(tipo.valorBase))) return true;
    return true;
  });

  const rateioJoin = await db
    .select({ txn: bankTransactions })
    .from(bankTransactions)
    .innerJoin(rateioPagamentos, eq(rateioPagamentos.bankTransactionId, bankTransactions.id))
    .where(and(
      eq(bankTransactions.imported, 1),
      eq(bankTransactions.importType, "rateio"),
      isNull(rateioPagamentos.fracaoId),
      sql`${bankTransactions.amount} > 0`,
    ));
  const rateioRows = rateioJoin.map((r) => r.txn);

  const seen = new Set<string>();
  const out: Array<typeof bankTransactions.$inferSelect> = [];
  for (const t of [...stagingNovo, ...reviewExtra, ...rateioRows]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}
