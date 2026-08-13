/**
 * Perfis de pagador — aprendizagem genérica (multi-condomínio ready).
 *
 * Um perfil liga sinais bancários recorrentes a uma fração:
 *   (IBAN e/ou nome normalizado) + valor ≈ quota → fracaoNumero + rubrica
 *
 * Casos típicos:
 *   - Rui Carvalho: IBAN+€40,33 → AI; IBAN+€46,08 → AH (proxy)
 *   - Qualquer pagador multi-fração noutro condomínio
 *
 * Lookup prioriza IBAN+valor; fallback nome+valor.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../database";
import { pagadorPerfis, fracoes } from "../database/schema";

const VALOR_TOL = 0.02;

export type RubricaPerfil = "condominio" | "obras" | "extra" | "fundo_reserva";

export interface PagadorPerfilMatch {
  fracaoId: string;
  fracaoNumero: string;
  rubrica: RubricaPerfil;
  valor: number;
  confirmacoes: number;
  fonte: string;
  matchedBy: "iban+valor" | "nome+valor";
  confidence: number;
}

export interface LearnPagadorInput {
  iban?: string | null;
  debtorName?: string | null;
  valor: number;
  fracaoId: string;
  fracaoNumero: string;
  rubrica?: RubricaPerfil;
  fonte: "manual" | "auto";
}

function normalizeIBAN(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

/** Mesma normalização que identity-matrix (sem import circular). */
export function normalizeNomePagador(s: string): string {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function valorMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= VALOR_TOL;
}

/**
 * Procura perfil conhecido para esta transferência.
 * Retorna null se ambíguo ou inexistente.
 */
export async function lookupPagadorPerfil(input: {
  iban?: string | null;
  debtorName?: string | null;
  valor: number;
}): Promise<PagadorPerfilMatch | null> {
  const valor = Math.abs(input.valor);
  if (valor <= 0) return null;

  const iban = input.iban ? normalizeIBAN(input.iban) : null;
  const nome = input.debtorName ? normalizeNomePagador(input.debtorName) : null;

  const activos = await db
    .select()
    .from(pagadorPerfis)
    .where(eq(pagadorPerfis.ativo, true));

  if (activos.length === 0) return null;

  // 1) IBAN + valor (mais fiável)
  if (iban) {
    const byIban = activos.filter(
      (p) => p.iban && normalizeIBAN(p.iban) === iban && valorMatch(p.valor, valor),
    );
    if (byIban.length === 1) {
      const p = byIban[0];
      return {
        fracaoId: p.fracaoId,
        fracaoNumero: p.fracaoNumero,
        rubrica: (p.rubrica as RubricaPerfil) || "condominio",
        valor: p.valor,
        confirmacoes: p.confirmacoes,
        fonte: p.fonte,
        matchedBy: "iban+valor",
        confidence: Math.min(95, 70 + Math.min(p.confirmacoes, 5) * 5),
      };
    }
    // Ambíguo: vários perfis com mesmo IBAN+valor → não arriscar
    if (byIban.length > 1) return null;
  }

  // 2) Nome + valor
  if (nome && nome.length >= 4) {
    const byNome = activos.filter(
      (p) =>
        p.nomeNormalizado &&
        p.nomeNormalizado === nome &&
        valorMatch(p.valor, valor),
    );
    if (byNome.length === 1) {
      const p = byNome[0];
      return {
        fracaoId: p.fracaoId,
        fracaoNumero: p.fracaoNumero,
        rubrica: (p.rubrica as RubricaPerfil) || "condominio",
        valor: p.valor,
        confirmacoes: p.confirmacoes,
        fonte: p.fonte,
        matchedBy: "nome+valor",
        confidence: Math.min(90, 65 + Math.min(p.confirmacoes, 5) * 5),
      };
    }
  }

  return null;
}

/**
 * Upsert perfil após confirmação (manual ou automática).
 * Chave lógica: (iban|nome) + valor arredondado + fracaoNumero.
 */
export async function learnPagadorPerfil(input: LearnPagadorInput): Promise<boolean> {
  const valor = Math.round(Math.abs(input.valor) * 100) / 100;
  if (valor <= 0 || !input.fracaoNumero) return false;

  const iban = input.iban ? normalizeIBAN(input.iban) : null;
  const nome = input.debtorName ? normalizeNomePagador(input.debtorName) : null;
  if (!iban && !nome) return false;

  const rubrica = input.rubrica ?? "condominio";

  // Procurar existente: mesmo IBAN (ou nome) + valor + fração
  const existentes = await db
    .select()
    .from(pagadorPerfis)
    .where(
      and(
        eq(pagadorPerfis.fracaoNumero, input.fracaoNumero.toUpperCase()),
        eq(pagadorPerfis.ativo, true),
      ),
    );

  const match = existentes.find((p) => {
    if (!valorMatch(p.valor, valor)) return false;
    if (iban && p.iban && normalizeIBAN(p.iban) === iban) return true;
    if (nome && p.nomeNormalizado && p.nomeNormalizado === nome) return true;
    return false;
  });

  const now = new Date();

  if (match) {
    await db
      .update(pagadorPerfis)
      .set({
        confirmacoes: match.confirmacoes + 1,
        fonte: input.fonte,
        iban: iban ?? match.iban,
        nomeNormalizado: nome ?? match.nomeNormalizado,
        rubrica,
        fracaoId: input.fracaoId,
        updatedAt: now,
      })
      .where(eq(pagadorPerfis.id, match.id));
    console.log(
      `[pagador-perfis] +1 confirmação ${input.fracaoNumero} €${valor} (${input.fonte}) → ${match.confirmacoes + 1}x`,
    );
    return false; // actualizado, não novo
  }

  await db.insert(pagadorPerfis).values({
    iban,
    nomeNormalizado: nome,
    valor,
    fracaoId: input.fracaoId,
    fracaoNumero: input.fracaoNumero.toUpperCase(),
    rubrica,
    confirmacoes: 1,
    fonte: input.fonte,
    ativo: true,
    createdAt: now,
    updatedAt: now,
  });

  console.log(
    `[pagador-perfis] Novo perfil: ${nome ?? "—"} ${iban ?? "sem-iban"} €${valor} → ${input.fracaoNumero} (${input.fonte})`,
  );
  return true;
}

/** Mapeia importType / classificação UI → rubrica do perfil. */
export function rubricaFromClassificacao(classificacao: string): RubricaPerfil {
  switch (classificacao) {
    case "quota_obras":
    case "obras":
      return "obras";
    case "quota_incendio":
    case "quota_motor":
    case "extra":
      return "extra";
    case "fundo_reserva":
      return "fundo_reserva";
    default:
      return "condominio";
  }
}

/** Resolve UUID da fração a partir do número (AI, G, …). */
export async function resolveFracaoIdByNumero(numero: string): Promise<string | null> {
  const [row] = await db
    .select({ id: fracoes.id })
    .from(fracoes)
    .where(eq(fracoes.numero, numero.toUpperCase()))
    .limit(1);
  return row?.id ?? null;
}

/** Contagem rápida de perfis activos (diagnóstico / smoke). */
export async function countPagadorPerfis(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(pagadorPerfis)
    .where(eq(pagadorPerfis.ativo, true));
  return Number(row?.n ?? 0);
}
