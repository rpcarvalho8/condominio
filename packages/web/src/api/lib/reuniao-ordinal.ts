import { eq, max } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { recordingSegments } from "../database/schema";

type DbLike = LibSQLDatabase<any> | typeof import("../database").db;

/**
 * Aloca o próximo ordinal monotónico para uma reunião.
 * Não usar count/length + 1 — inseguro sob concorrência.
 *
 * Estratégia (SQLite/libsql):
 * 1. Ler MAX(ordinal) na mesma transação quando disponível
 * 2. UNIQUE(reuniao_id, ordinal) na BD como rede de segurança
 * 3. Retry em caso de colisão UNIQUE
 */
export async function allocateNextOrdinal(
  database: DbLike,
  reuniaoId: string,
): Promise<number> {
  const [row] = await database
    .select({ maxOrdinal: max(recordingSegments.ordinal) })
    .from(recordingSegments)
    .where(eq(recordingSegments.reuniaoId, reuniaoId));
  return (row?.maxOrdinal ?? 0) + 1;
}

/** Detecta erro UNIQUE de (reuniao_id, ordinal), incluindo wrappers Drizzle. */
export function isOrdinalUniqueViolation(error: unknown): boolean {
  const parts: string[] = [];
  let cur: any = error;
  for (let i = 0; i < 5 && cur; i++) {
    parts.push(String(cur?.message ?? cur ?? ""));
    parts.push(String(cur?.code ?? ""));
    parts.push(String(cur?.cause?.message ?? ""));
    cur = cur?.cause;
  }
  const msg = parts.join(" ").toLowerCase();
  return (
    msg.includes("unique") ||
    msg.includes("constraint") ||
    msg.includes("recording_segments_reuniao_ordinal") ||
    msg.includes("sqlite_constraint")
  );
}

/**
 * Insert com retry sob colisão de ordinal (corrida entre requests).
 */
export async function insertSegmentWithOrdinalRetry<T>(
  database: DbLike,
  reuniaoId: string,
  buildValues: (ordinal: number) => Record<string, unknown>,
  insertFn: (values: Record<string, unknown>) => Promise<T[]>,
  maxAttempts = 8,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ordinal = await allocateNextOrdinal(database, reuniaoId);
    try {
      const [created] = await insertFn(buildValues(ordinal));
      if (!created) throw new Error("Insert de segmento sem retorno.");
      return created;
    } catch (e) {
      lastError = e;
      if (!isOrdinalUniqueViolation(e)) throw e;
      // backoff mínimo — deixa o outro request commitir
      await new Promise((r) => setTimeout(r, 5 + attempt * 10));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Falha ao inserir segmento após retries de ordinal.");
}

/** Variante documentada — a alocação real usa MAX+1 + UNIQUE + retry. */
export function describeOrdinalStrategy(): string {
  return "MAX(ordinal)+1 with UNIQUE(reuniao_id,ordinal) and insert retry";
}