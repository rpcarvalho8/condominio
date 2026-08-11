/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           MATRIZ DE IDENTIDADE — Condomínio 7663                ║
 * ║  Fonte de verdade: tabela `fracoes` (BD).                       ║
 * ║  MATRIZ_PROPRIEDADES é cache em memória — arranca vazia e é     ║
 * ║  preenchida via loadMatrizFromDB() / rehydrate no boot.         ║
 * ║  Sem PII hardcoded (GDPR). Seed: identify-data.json + seed-fracoes.║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Exports principais:
 *   MATRIZ_PROPRIEDADES   — cache mutável (vazia até loadMatrizFromDB)
 *   loadMatrizFromDB()    — SELECT fracoes → cache + índices
 *   getFracaoById()       — lookup por idFracao (cache)
 *   getFracaoByIBAN()     — lookup por IBAN (cache + BD aprendidos)
 *   learnIBAN()           — persiste novo IBAN aprendido (Auto-Learning)
 *   identifyByMultiMatch()— identifica fração via ≥2 critérios
 *   rehydrateDividasFromDB / rehydrateMatrizFromDB — alias → loadMatrizFromDB
 */

import { db } from "../database";
import { fracoes } from "../database/schema";
import { sql } from "drizzle-orm";

// ─── Tipos de Cascata ─────────────────────────────────────────────────────────

export interface CascataAplicacao {
  tipo: keyof DividasAtuais;
  valorAntes: number;
  valorAmortizado: number;
  valorDepois: number;
}

export interface CascataResult {
  idFracao: string;
  valorEntrada: number;
  quotaLiquida: number;       // absorvido pela quota mensal (condominio + fundo reserva)
  restoAmortizacao: number;   // montante que entrou na cascata
  aplicacoes: CascataAplicacao[];
  sobra: number;              // valor que ficou sem destino (crédito a favor)
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type EntradaLabel = "ENTRADA 21" | "ENTRADA 37" | "ENTRADA 39" | "GARAGEM" | "LOJAS";

export interface ValoresFixos {
  condominio: number;     // quota mensal condomínio (€)
  fundoReserva: number;   // 10% da quota (€)
}

/** Dívidas actuais — valores dinâmicos; actualizados após cada amortização.
 *  NaN / undefined = não aplicável a esta fração.
 */
export interface DividasAtuais {
  obras: number;      // Quota Extra Obras — valor em dívida
  incendio: number;   // Quota Extra Incêndio — valor em dívida
  indaqua: number;    // Quota Extra Indaqua + elevadores — valor em dívida
  motor: number;      // Quota Extra Motor Garagem — valor em dívida
}

export interface FracaoIdentidade {
  /** Identificador curto da fração: J, L, AB, AC, ... */
  idFracao: string;
  /** Entrada do edifício */
  entrada: EntradaLabel;
  /** Descrição humana: "1A + GAR 36", "LUGAR GAR. 7", etc. */
  descricao: string;
  /** Permilagem ‰ do edifício */
  permilagem: number;
  /** Nome completo do proprietário conforme Excel */
  nomeProprietario: string;
  /** IBANs conhecidos (estáticos do Excel + aprendidos em runtime) */
  ibansConhecidos: string[];
  valoresFixos: ValoresFixos;
  dividasAtuais: DividasAtuais;
  /** Tipo: habitação, loja ou garagem */
  tipo: "habitacao" | "loja" | "garagem";
}

// ─── ORÇAMENTOS APROVADOS EM ASSEMBLEIA ──────────────────────────────────────
// Fonte: Atas de Assembleia — valores com IVA, para o condomínio completo.
// Single source of truth — importar daqui em dashboard.ts e no motor LLM.
export const ORCAMENTO_MOTOR      =  707.25;   // Cota Extra Motor Garagem (portão)
export const ORCAMENTO_INCENDIO   = 2644.50;   // Cota Extra Incêndio / Seguro
export const ORCAMENTO_ELEVADORES = 6958.18;   // Cota Extra Elevadores (INDAQUA)
export const ORCAMENTO_OBRAS      = 50550.04;  // Cota Extra Obras

// ─── SALDOS ÂNCORA (15/06/2026) ──────────────────────────────────────────────
// Fonte: Extratos físicos Santander confirmados em 15/06/2026.
// NUNCA substituir por saldo_base_valor/saldo_base_data da DB (valores Enable Banking
// — produzem 3738.39€ em vez do saldo real de 1806.74€).
export const ANCORA_SALDO_CC         = 1806.74;   // Conta à Ordem ancorada a 15/06/2026
export const ANCORA_SALDO_FR         =  651.30;   // Dep. a Prazo Fundo de Reserva
export const ANCORA_SALDO_ELEVADORES =  110.45;   // Dep. a Prazo Elevadores
export const ANCORA_SALDO_OBRAS      = 21185.29;  // Dep. a Prazo Obras

// Data âncora da Conta Corrente — saldo físico confirmado nesta data.
export const ANCORA_DATA_CC         = new Date("2026-06-15T00:00:00.000Z");
// Data a partir da qual os movimentos bancários são processados pela triagem.
// Movimentos anteriores a esta data são ignorados pelo algoritmo.
export const ANCORA_DATA_MOVIMENTOS = new Date("2026-06-02T00:00:00.000Z");

// Número total de frações do condomínio (para cálculos per-capita).
export const TOTAL_FRACOES = 33;

// ─────────────────────────────────────────────────────────────────────────────
// Cache em memória — vazia até loadMatrizFromDB(). Sem PII no código-fonte.

export let MATRIZ_PROPRIEDADES: FracaoIdentidade[] = [];

// ─── Índices de acesso rápido ─────────────────────────────────────────────────

const _byId = new Map<string, FracaoIdentidade>();
/** Mapa IBAN → array de frações que o partilham (garagem associada, etc.) */
const _byIban = new Map<string, FracaoIdentidade[]>();

/** Remove espaços, uppercase */
function normalizeIBAN(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

/** Reconstrói índices a partir de MATRIZ_PROPRIEDADES. */
function rebuildIndexes(): void {
  _byId.clear();
  _byIban.clear();
  for (const fracao of MATRIZ_PROPRIEDADES) {
    _byId.set(fracao.idFracao.toUpperCase(), fracao);
    for (const iban of fracao.ibansConhecidos) {
      const norm = normalizeIBAN(iban);
      if (!_byIban.has(norm)) _byIban.set(norm, []);
      _byIban.get(norm)!.push(fracao);
    }
  }
}

type FracaoRow = typeof fracoes.$inferSelect;

const ENTRADA_LABELS = new Set<string>([
  "ENTRADA 21",
  "ENTRADA 37",
  "ENTRADA 39",
  "GARAGEM",
  "LOJAS",
]);

function parseEntradaDescricao(
  notas: string | null | undefined,
  numero: string,
): { entrada: EntradaLabel; descricao: string } {
  // Formato seed: "ENTRADA 21 · 1A + GAR 36"
  if (notas) {
    const sep = notas.indexOf(" · ");
    if (sep > 0) {
      const rawEntrada = notas.slice(0, sep).trim();
      const descricao = notas.slice(sep + 3).trim() || numero;
      const entrada = (ENTRADA_LABELS.has(rawEntrada)
        ? rawEntrada
        : "ENTRADA 21") as EntradaLabel;
      return { entrada, descricao };
    }
  }
  return { entrada: "ENTRADA 21", descricao: numero };
}

function mapTipoFromDb(tipo: string | null | undefined): FracaoIdentidade["tipo"] {
  if (tipo === "loja" || tipo === "garagem") return tipo;
  return "habitacao"; // apartamento → habitacao
}

/** Mapeia uma linha drizzle `fracoes` para FracaoIdentidade. */
export function rowToFracao(row: FracaoRow): FracaoIdentidade {
  const idFracao = row.numero;
  const { entrada, descricao } = parseEntradaDescricao(row.notas, idFracao);

  let ibansConhecidos: string[] = [];
  try {
    const parsed = JSON.parse(row.ibansConhecidos ?? "[]");
    ibansConhecidos = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    ibansConhecidos = [];
  }

  const total = Number(row.quotaMensal ?? 0);
  const condominio = Math.round((total / 1.1) * 100) / 100;
  const fundoReserva = Math.round((total - condominio) * 100) / 100;

  return {
    idFracao,
    entrada,
    descricao,
    permilagem: Number(row.permilagem ?? 0),
    nomeProprietario: row.proprietarioNome ?? "",
    ibansConhecidos,
    valoresFixos: { condominio, fundoReserva },
    dividasAtuais: {
      obras: Number(row.obrasDivida ?? 0),
      incendio: Number(row.incendioDivida ?? 0),
      indaqua: Number(row.indaquaDivida ?? 0),
      motor: Number(row.motorDivida ?? 0),
    },
    tipo: mapTipoFromDb(row.tipo),
  };
}

/**
 * Carrega todas as frações da BD para a cache em memória e reconstrói índices.
 * Fonte de verdade: tabela `fracoes`.
 */
export async function loadMatrizFromDB(): Promise<void> {
  try {
    const rows = await db.select().from(fracoes);
    MATRIZ_PROPRIEDADES = rows.map(rowToFracao);
    rebuildIndexes();
    console.log(
      `[identity-matrix] loadMatrizFromDB: ${MATRIZ_PROPRIEDADES.length} frações carregadas`,
    );
  } catch (e) {
    console.warn("[identity-matrix] loadMatrizFromDB falhou (BD indisponível?):", e);
  }
}

// ─── Lookups públicos ─────────────────────────────────────────────────────────

export function getFracaoById(id: string): FracaoIdentidade | undefined {
  return _byId.get(id.toUpperCase());
}

/**
 * Devolve frações associadas a um IBAN.
 * Procura primeiro nos IBANs da cache; se não encontrar,
 * consulta a tabela `fracoes` para IBANs aprendidos em runtime.
 */
export async function getFracaoByIBAN(iban: string): Promise<FracaoIdentidade[]> {
  const norm = normalizeIBAN(iban);

  // 1. índice em memória (instantâneo)
  const static_ = _byIban.get(norm);
  if (static_?.length) return static_;

  // 2. IBANs aprendidos em runtime (coluna ibans_conhecidos da BD)
  // SQLite: json_each precisa de estar no FROM, não no WHERE — usar db.run() manual.
  const rawRows = await db.run(
    sql`SELECT numero FROM fracoes WHERE EXISTS (
          SELECT 1 FROM json_each(ibans_conhecidos) WHERE value = ${norm}
        )`
  );

  const found: FracaoIdentidade[] = [];
  for (const row of (rawRows as any).rows ?? []) {
    const f = _byId.get((row.numero as string).toUpperCase());
    if (f) found.push(f);
  }
  return found;
}

// ─── Auto-Learning: persistência de novos IBANs ───────────────────────────────

/**
 * Resultado de uma identificação multi-critério.
 * `criterios` lista o que coincidiu (ex: "nome", "descricao", "iban", "valor").
 */
export interface IdentificacaoResult {
  fracao: FracaoIdentidade;
  confidence: number;   // 0–100
  criterios: string[];
  ibanNovoAprendido: boolean;
}

/**
 * Persiste um IBAN novo na tabela `fracoes.ibans_conhecidos` (JSON array)
 * E actualiza o índice em memória para que próximas queries o encontrem.
 *
 * @param idFracao   ID da fração (ex: "U")
 * @param ibanSender IBAN recebido na transação
 * @returns true se foi inserido novo, false se já existia
 */
export async function learnIBAN(
  idFracao: string,
  ibanSender: string
): Promise<boolean> {
  const norm = normalizeIBAN(ibanSender);
  const fracao = getFracaoById(idFracao);
  if (!fracao) return false;

  // Verificar se já existe no array em memória
  const jaExiste = fracao.ibansConhecidos.some(
    (i) => normalizeIBAN(i) === norm
  );
  if (jaExiste) return false;

  // Verificar se já existe na BD (pode ter sido aprendido noutro processo)
  const rows = await db.run(
    sql`SELECT ibans_conhecidos FROM fracoes WHERE numero = ${fracao.idFracao} LIMIT 1`
  );
  const row = (rows as any).rows?.[0];
  if (!row) {
    // Fração não existe em BD — provavelmente sistema fresh; registar apenas em memória
    fracao.ibansConhecidos.push(norm);
    _byIban.set(norm, [...(_byIban.get(norm) ?? []), fracao]);
    console.warn(`[identity-matrix] learnIBAN: fração ${idFracao} não existe em BD; IBAN guardado apenas em memória`);
    return true;
  }

  let current: string[] = [];
  try {
    current = JSON.parse(row.ibans_conhecidos as string ?? "[]");
  } catch {
    current = [];
  }

  if (current.map(normalizeIBAN).includes(norm)) return false; // já estava na BD

  current.push(norm);

  // UPSERT via UPDATE (a fração já existe)
  await db.run(
    sql`UPDATE fracoes SET ibans_conhecidos = ${JSON.stringify(current)} WHERE numero = ${fracao.idFracao}`
  );

  // Actualizar índice em memória
  fracao.ibansConhecidos.push(norm);
  const existing = _byIban.get(norm) ?? [];
  if (!existing.includes(fracao)) existing.push(fracao);
  _byIban.set(norm, existing);

  console.log(`[identity-matrix] Novo IBAN aprendido: ${norm} → fração ${idFracao} (${fracao.nomeProprietario})`);
  return true;
}

// ─── Identificação Multi-Critério ─────────────────────────────────────────────

interface MatchInput {
  /** Texto descritivo da transferência bancária */
  descricao: string;
  /** Montante (positivo) */
  amount: number;
  /** IBAN do remetente, se disponível */
  ibanSender?: string;
  /** Nome do devedor/remetente do banco, se disponível */
  debtorName?: string;
}

type MatchCriterio = "iban" | "nome" | "descricao_fracao" | "valor_fixo" | "valor_quota_extra";

/**
 * Normaliza string para comparação: uppercase, sem acentos, sem pontuação estranha.
 */
function normStr(s: string): string {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Verifica se o nome do remetente coincide com proprietário da fração.
 * Aceitamos match parcial de pelo menos 2 tokens do nome (previne falsos positivos em nomes curtos).
 */
function nomeCoincide(debtorName: string, nomeProprietario: string): boolean {
  const src = normStr(debtorName);
  const ref = normStr(nomeProprietario);

  // Match exacto
  if (src === ref) return true;

  // Match por tokens: o devedor tem pelo menos 2 tokens do nome do proprietário
  const refTokens = ref.split(" ").filter((t) => t.length > 2);
  const matchedTokens = refTokens.filter((t) => src.includes(t));

  // Exige ≥2 tokens ou ≥60% dos tokens (o que for maior)
  const minTokens = Math.max(2, Math.ceil(refTokens.length * 0.6));
  return matchedTokens.length >= minTokens;
}

/**
 * Verifica se a descrição menciona explicitamente a fração
 * (ex: "FRACAO AB", "FRACCAO AE", "AB HAB RC A", "ENTRADA 21 1A").
 */
function descricaoMencaonaFracao(descricao: string, idFracao: string): boolean {
  const d = normStr(descricao);
  const id = idFracao.toUpperCase();

  // "FRACAO X", "FRACCAO X", "FRACÃO X", "FRAÇÃO X"
  if (new RegExp(`(FRACAO|FRACCAO|FRAC[AÃ]O|FRA[CÇ][AÃ]O)\\s+${id}\\b`).test(d)) return true;
  // "AB HAB" ou "AB RC" (lojas/hab + id no início)
  if (new RegExp(`^${id}\\s+(HAB|RC|LOJA|GAR)`).test(d)) return true;
  // "ENTRADA NN XY" onde XY == idFracao (ex: ENTRADA 21 1A... but 1A != J)
  // Usamos a descricao da fração para este match
  return false;
}

/**
 * Verifica se o montante coincide com a quota mensal (±0.02€ tolerância).
 */
function valorCoincideQuota(amount: number, fracao: FracaoIdentidade): boolean {
  return Math.abs(amount - fracao.valoresFixos.condominio) <= 0.02;
}

/**
 * Verifica se o montante coincide com algum valor de quota extra em dívida (±0.05€).
 */
function valorCoincideExtra(amount: number, fracao: FracaoIdentidade): boolean {
  const { obras, incendio, indaqua, motor } = fracao.dividasAtuais;
  for (const v of [obras, incendio, indaqua, motor]) {
    if (v > 0 && Math.abs(amount - v) <= 0.05) return true;
  }
  return false;
}

// ─── Helpers de desempate IBAN ────────────────────────────────────────────────

/**
 * Score de desempate: nome do remetente vs proprietário (+35).
 * Usa a mesma lógica de tokens que nomeCoincide(), mas devolve pontos em vez de bool.
 */
function scoreDesempateNome(debtorName: string | undefined, nomeProprietario: string): number {
  if (!debtorName) return 0;
  return nomeCoincide(debtorName, nomeProprietario) ? 35 : 0;
}

/**
 * Score de desempate: descrição contém "Entrada NN Fracção X" ou "ENTRADA NN FR X" (+30).
 * Exemplo: "ENTRADA 39 AF" ou "Entrada 39 Fracção AF".
 */
function scoreDesempateEntradaFracao(
  descricao: string | undefined,
  entrada: string,
  idFracao: string,
): number {
  if (!descricao) return 0;
  const d = normStr(descricao);
  const id = idFracao.toUpperCase();
  // Extrair número da entrada, ex: "ENTRADA 39" → "39"
  const entradaNum = entrada.replace(/\D/g, "");
  if (!entradaNum) return 0;
  // "ENTRADA 39 AF" ou "ENTRADA 39 FRACAO AF" ou "ENTRADA 39 FRACCAO AF"
  const re = new RegExp(`ENTRADA\\s+${entradaNum}\\s+(FRACAO\\s+|FRACCAO\\s+|FR\\s+)?${id}\\b`);
  return re.test(d) ? 30 : 0;
}

/**
 * Score de desempate: descrição contém "Entrada NN" + texto da descrição da fração (+25).
 * Exemplo: "ENTRADA 39 2B GAR 12" vs descricao="2B + GAR 12".
 */
function scoreDesempateEntradaDescricao(
  descricao: string | undefined,
  entrada: string,
  descFracao: string,
): number {
  if (!descricao) return 0;
  const d = normStr(descricao);
  const entradaNum = entrada.replace(/\D/g, "");
  const descNorm = normStr(descFracao);
  if (!entradaNum) return 0;
  // Verificar que a descrição menciona o número de entrada
  if (!d.includes(entradaNum)) return 0;
  // Verificar que pelo menos 2 tokens da descricao da fração aparecem na descrição
  const tokens = descNorm.split(" ").filter((t) => t.length > 1);
  const matched = tokens.filter((t) => d.includes(t));
  return matched.length >= 2 ? 25 : 0;
}

/**
 * Score de desempate: descrição contém texto da descrição da fração isolada (+20).
 * Exemplo: "LUGAR GAR. 11" ou "2B + GAR 12" na descrição da TXN.
 */
function scoreDesempateDescricaoIsolada(
  descricao: string | undefined,
  descFracao: string,
): number {
  if (!descricao) return 0;
  const d = normStr(descricao);
  const descNorm = normStr(descFracao);
  const tokens = descNorm.split(" ").filter((t) => t.length > 1);
  if (tokens.length === 0) return 0;
  const matched = tokens.filter((t) => d.includes(t));
  // Exige todos os tokens (ou ≥2 se muitos)
  const minMatch = tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length * 0.7);
  return matched.length >= minMatch ? 20 : 0;
}

/**
 * Calcula score de desempate para uma fração colidida (quando IBAN → múltiplas frações).
 * Sub-critérios: nome(+35), entrada+fração(+30), entrada+desc(+25), desc isolada(+20).
 * Retorna { score, criterios }.
 */
function calcularScoreDesempate(
  input: MatchInput,
  fracao: FracaoIdentidade,
): { score: number; criterios: MatchCriterio[] } {
  let score = 0;
  const criterios: MatchCriterio[] = [];

  const sNome = scoreDesempateNome(input.debtorName, fracao.nomeProprietario);
  if (sNome > 0) { score += sNome; criterios.push("nome"); }

  const sEntFrac = scoreDesempateEntradaFracao(input.descricao, fracao.entrada, fracao.idFracao);
  if (sEntFrac > 0) { score += sEntFrac; criterios.push("descricao_fracao"); }

  const sEntDesc = scoreDesempateEntradaDescricao(input.descricao, fracao.entrada, fracao.descricao);
  if (sEntDesc > 0 && !criterios.includes("descricao_fracao")) {
    score += sEntDesc; criterios.push("descricao_fracao");
  } else if (sEntDesc > 0) {
    score += sEntDesc; // soma mesmo que criterio já contado (pontuação adicional)
  }

  const sDesc = scoreDesempateDescricaoIsolada(input.descricao, fracao.descricao);
  if (sDesc > 0 && criterios.length < 3) { score += sDesc; criterios.push("descricao_fracao"); }

  return { score, criterios };
}

/**
 * Identifica a fração a partir de ≥2 critérios de matching.
 * Se identificação for bem sucedida E o IBAN for novo → chama learnIBAN().
 *
 * Hierarquia de confiança:
 *   iban                → +50
 *   nome                → +30  (critério base, sem colisão)
 *   descricao_fracao    → +25  (critério base, sem colisão)
 *   valor_fixo          → +15
 *   valor_quota_extra   → +10
 *
 * Colisão IBAN (ibanCandidatos.length > 1):
 *   Desempate exclusivo com sub-critérios: nome(+35), entFrac(+30), entDesc(+25), descIsolada(+20)
 *   Threshold desempate: score ≥ 55 E ≥2 critérios
 *
 * Threshold geral para identificação: score ≥ 55 E ≥2 critérios
 */
export async function identifyByMultiMatch(
  input: MatchInput
): Promise<IdentificacaoResult | null> {
  const candidatos: Array<{ fracao: FracaoIdentidade; score: number; criterios: MatchCriterio[] }> = [];

  // Pre-match por IBAN (se disponível)
  let ibanCandidatos: FracaoIdentidade[] = [];
  if (input.ibanSender) {
    ibanCandidatos = await getFracaoByIBAN(input.ibanSender);
  }

  // ── Colisão IBAN: múltiplas frações com o mesmo IBAN ─────────────────────
  // Em vez de pegar a primeira (bug!), calcular score de desempate
  // apenas para as frações colididas.
  if (ibanCandidatos.length > 1) {
    const tieBreakers: Array<{ fracao: FracaoIdentidade; score: number; criterios: MatchCriterio[] }> = [];

    for (const candidato of ibanCandidatos) {
      const { score, criterios } = calcularScoreDesempate(input, candidato);
      tieBreakers.push({ fracao: candidato, score, criterios });
      console.log(
        `[identifyByMultiMatch] IBAN colisão desempate` +
        ` fração=${candidato.idFracao} score=${score} criterios=[${criterios.join(",")}]` +
        ` debtorName="${input.debtorName ?? ""}" descricao="${input.descricao ?? ""}"`,
      );
    }

    // Ordenar por score desc
    tieBreakers.sort((a, b) => b.score - a.score);
    const winner = tieBreakers[0];
    const runnerUp = tieBreakers[1];

    // Empate exacto → não arriscar
    if (winner.score === runnerUp.score) {
      console.warn(
        `[identifyByMultiMatch] IBAN colisão sem desempate claro` +
        ` (${winner.fracao.idFracao} e ${runnerUp.fracao.idFracao} empatam com score=${winner.score})`,
      );
      return null;
    }

    // Threshold: score ≥ 55 E ≥2 critérios (inclui o iban que é garantido nas colididas)
    const totalScore = 50 + winner.score; // +50 IBAN base + score desempate
    const allCriterios: MatchCriterio[] = ["iban", ...winner.criterios];

    if (totalScore < 55 || allCriterios.length < 2) {
      console.warn(
        `[identifyByMultiMatch] IBAN colisão — desempate insuficiente` +
        ` fração=${winner.fracao.idFracao} totalScore=${totalScore} criterios=[${allCriterios.join(",")}]`,
      );
      return null;
    }

    // Vencedor encontrado
    let ibanNovoAprendido = false;
    if (input.ibanSender) {
      ibanNovoAprendido = await learnIBAN(winner.fracao.idFracao, input.ibanSender);
    }

    return {
      fracao: winner.fracao,
      confidence: Math.min(100, totalScore),
      criterios: allCriterios,
      ibanNovoAprendido,
    };
  }

  // ── Sem colisão: fluxo normal ─────────────────────────────────────────────
  for (const fracao of MATRIZ_PROPRIEDADES) {
    let score = 0;
    const criterios: MatchCriterio[] = [];

    // Critério 1: IBAN
    if (input.ibanSender && ibanCandidatos.some((c) => c.idFracao === fracao.idFracao)) {
      score += 50;
      criterios.push("iban");
    }

    // Critério 2: Nome do devedor
    if (input.debtorName && nomeCoincide(input.debtorName, fracao.nomeProprietario)) {
      score += 30;
      criterios.push("nome");
    }

    // Critério 3: Menção explícita à fração na descrição
    if (descricaoMencaonaFracao(input.descricao, fracao.idFracao)) {
      score += 25;
      criterios.push("descricao_fracao");
    }

    // Critério 4: Valor coincide com quota mensal
    if (valorCoincideQuota(input.amount, fracao)) {
      score += 15;
      criterios.push("valor_fixo");
    }

    // Critério 5: Valor coincide com quota extra em dívida
    if (valorCoincideExtra(input.amount, fracao)) {
      score += 10;
      criterios.push("valor_quota_extra");
    }

    if (score >= 30 && criterios.length >= 1) {
      candidatos.push({ fracao, score, criterios });
    }
  }

  if (candidatos.length === 0) return null;

  // Ordenar por score desc — pegar o melhor
  candidatos.sort((a, b) => b.score - a.score);
  const best = candidatos[0];

  // Exigir score mínimo E pelo menos 2 critérios distintos para evitar falsos positivos
  if (best.score < 55 || best.criterios.length < 2) return null;

  // ── Auto-Learning: novo IBAN? ──────────────────────────────────────────────
  let ibanNovoAprendido = false;
  if (input.ibanSender && best.criterios.length >= 2) {
    ibanNovoAprendido = await learnIBAN(best.fracao.idFracao, input.ibanSender);
  }

  return {
    fracao: best.fracao,
    confidence: Math.min(100, best.score),
    criterios: best.criterios,
    ibanNovoAprendido,
  };
}

// ─── Helpers exportados ───────────────────────────────────────────────────────

/**
 * Rehydrata a cache em memória a partir da tabela `fracoes` (reload completo).
 * Deve ser chamada no arranque do servidor antes de qualquer operação matricial.
 */
export async function rehydrateDividasFromDB(): Promise<void> {
  await loadMatrizFromDB();
}

/** Alias explícito — mesma implementação; preferir este nome em código novo. */
export const rehydrateMatrizFromDB = rehydrateDividasFromDB;

/** Devolve todas as frações com dívidas activas */
export function getFracoesComDividas(): FracaoIdentidade[] {
  return MATRIZ_PROPRIEDADES.filter((f) => {
    const { obras, incendio, indaqua, motor } = f.dividasAtuais;
    return obras > 0 || incendio > 0 || indaqua > 0 || motor > 0;
  });
}

/** Total de dívidas por tipo no condomínio */
export function totalDividasPorTipo(): Record<keyof DividasAtuais, number> {
  return MATRIZ_PROPRIEDADES.reduce(
    (acc, f) => ({
      obras: acc.obras + f.dividasAtuais.obras,
      incendio: acc.incendio + f.dividasAtuais.incendio,
      indaqua: acc.indaqua + f.dividasAtuais.indaqua,
      motor: acc.motor + f.dividasAtuais.motor,
    }),
    { obras: 0, incendio: 0, indaqua: 0, motor: 0 }
  );
}

/** Actualiza dividasAtuais de uma fração em memória após amortização.
 *  @deprecated Usar processarCascataAmortizacao() para persistência durable.
 */
export function amortizarDivida(
  idFracao: string,
  tipo: keyof DividasAtuais,
  valorPago: number
): void {
  const fracao = getFracaoById(idFracao);
  if (!fracao) return;
  fracao.dividasAtuais[tipo] = Math.max(0, fracao.dividasAtuais[tipo] - valorPago);
}

// ─── Cascata de Amortização Dinâmica ─────────────────────────────────────────

/**
 * Processa a cascata de amortização para uma fração após recepção de pagamento.
 *
 * Ordem de prioridade (estrita): obras → indaqua → incendio → motor
 *
 * Fluxo:
 *   1. Subtrai quota mensal líquida (condominio + fundoReserva) do montante recebido.
 *   2. O restante percorre as dívidas extra por prioridade até esgotar.
 *   3. Persiste os novos saldos em BD (UPDATE fracoes SET obras_divida=... etc).
 *   4. Actualiza o objecto em memória para que lookups subsequentes sejam correctos.
 *
 * @param idFracao   ID da fração (ex: "L")
 * @param amount     Montante total recebido (€)
 * @param fracaoDB   Linha da BD (para obter fracaoId)
 * @param mes        Mês do pagamento (1-12)
 * @param ano        Ano do pagamento
 * @returns CascataResult com breakdown completo, ou null se fração não encontrada
 */
export async function processarCascataAmortizacao(
  idFracao: string,
  amount: number,
  fracaoDBId: string,
  mes: number,
  ano: number,
): Promise<CascataResult | null> {
  const fracao = getFracaoById(idFracao);
  if (!fracao) return null;

  // ── 1. Absorver quota mensal ──────────────────────────────────────────────
  const quotaLiquida = fracao.valoresFixos.condominio + fracao.valoresFixos.fundoReserva;
  let resto = Math.max(0, parseFloat((amount - quotaLiquida).toFixed(2)));

  const result: CascataResult = {
    idFracao,
    valorEntrada: amount,
    quotaLiquida,
    restoAmortizacao: resto,
    aplicacoes: [],
    sobra: 0,
  };

  if (resto <= 0) {
    result.sobra = 0;
    return result;
  }

  // ── 2. Ler dívidas actuais da BD (fonte de verdade durable) ──────────────
  const rows = await db.run(
    sql`SELECT obras_divida, incendio_divida, indaqua_divida, motor_divida
        FROM fracoes WHERE id = ${fracaoDBId} LIMIT 1`
  );
  const row = (rows as any).rows?.[0];

  // Usar BD se disponível; caso contrário cair para memória (sistema fresh/seed)
  const dividasBD: DividasAtuais = row
    ? {
        obras:    parseFloat((row.obras_divida as string | number) ?? 0) || 0,
        incendio: parseFloat((row.incendio_divida as string | number) ?? 0) || 0,
        indaqua:  parseFloat((row.indaqua_divida as string | number) ?? 0) || 0,
        motor:    parseFloat((row.motor_divida as string | number) ?? 0) || 0,
      }
    : { ...fracao.dividasAtuais };

  // ── 3. Aplicar cascata: obras → indaqua → incendio → motor ───────────────
  const ordem: Array<keyof DividasAtuais> = ["obras", "indaqua", "incendio", "motor"];

  const novasDividas = { ...dividasBD };

  for (const tipo of ordem) {
    if (resto <= 0) break;
    const divida = novasDividas[tipo];
    if (divida <= 0) continue;

    const amortizado = parseFloat(Math.min(resto, divida).toFixed(2));
    const antes = divida;
    novasDividas[tipo] = parseFloat(Math.max(0, divida - amortizado).toFixed(2));
    resto = parseFloat(Math.max(0, resto - amortizado).toFixed(2));

    result.aplicacoes.push({
      tipo,
      valorAntes: antes,
      valorAmortizado: amortizado,
      valorDepois: novasDividas[tipo],
    });
  }

  result.sobra = resto;

  // ── 4. Persistir em BD ────────────────────────────────────────────────────
  await db.run(
    sql`UPDATE fracoes
        SET obras_divida    = ${novasDividas.obras},
            incendio_divida = ${novasDividas.incendio},
            indaqua_divida  = ${novasDividas.indaqua},
            motor_divida    = ${novasDividas.motor}
        WHERE id = ${fracaoDBId}`
  );

  // ── 5. Actualizar memória ─────────────────────────────────────────────────
  fracao.dividasAtuais.obras    = novasDividas.obras;
  fracao.dividasAtuais.incendio = novasDividas.incendio;
  fracao.dividasAtuais.indaqua  = novasDividas.indaqua;
  fracao.dividasAtuais.motor    = novasDividas.motor;

  console.log(
    `[cascata] ${idFracao} — entrada €${amount.toFixed(2)}, quota €${quotaLiquida.toFixed(2)}, ` +
    `amortizações: [${result.aplicacoes.map(a => `${a.tipo} -€${a.valorAmortizado}`).join(", ")}], ` +
    `sobra €${result.sobra.toFixed(2)}`
  );

  return result;
}
