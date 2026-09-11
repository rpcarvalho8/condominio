/**
 * Payments candidatos a partir de CSV / movimentos / identity-matrix (kernel F2).
 * Resultado = Payment válido sem Allocation (ADR-012). Nunca toca Quota.pago.
 */
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { f2BankMovements, payments } from "../../database/schema";
import {
  ALLOCATION_STATUS,
  BANK_MOVEMENT_STATUS,
  CANDIDATE_SOURCES,
  PAYMENT_METHODS,
  type CandidateSource,
} from "../../domain/finance";
import { DomainError } from "../../domain/errors";
import { kernelNow, type KernelDb, type KernelDeps } from "../../infra/kernel-deps";
import { parseBankCsvCredits } from "./f2-csv-movements";
import { matchCandidateIdentity } from "./f2-identity";
import { registerPayment } from "./f2-finance";

type Actor = {
  personId?: string | null;
  userId?: string | null;
  requestId?: string | null;
};

/** Caps for POST /payments/candidates — reject 400 before parse/insert. */
export const MAX_CANDIDATE_CSV_CHARS = 512_000;
export const MAX_CANDIDATE_MOVEMENTS = 500;

const INGEST_UNIQUE_RETRIES = 8;

/** In-process per-tenant queue. Complements UNIQUE(tenant_id, external_ref):
 * local libSQL busy-waits synchronously and would deadlock two async writers. */
const tenantMutexes = new Map<string, Promise<void>>();

async function withTenantMutex<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tenantMutexes.get(tenantId) ?? Promise.resolve();
  let unlock: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  tenantMutexes.set(
    tenantId,
    prev.catch(() => undefined).then(() => held),
  );
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    unlock();
  }
}

export type CandidateMovementInput = {
  amountCents: number;
  description?: string | null;
  debtorName?: string | null;
  counterpartyIban?: string | null;
  externalRef?: string | null;
  bookedAt?: Date | string | null;
  source?: CandidateSource;
};

export type CandidateIngestResult = {
  paymentId: string;
  bankMovementId: string;
  fracaoId: string | null;
  allocationStatus: string;
  confidence: number;
  criteria: string[];
  created: boolean;
  externalRef: string;
};

function movementExternalRef(tenantId: string, mov: CandidateMovementInput): string {
  if (mov.externalRef?.trim()) return mov.externalRef.trim();
  const raw = [
    tenantId,
    String(mov.amountCents),
    mov.description ?? "",
    mov.debtorName ?? "",
    mov.bookedAt ? String(mov.bookedAt) : "",
    mov.counterpartyIban ?? "",
  ].join("|");
  return `cand-${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32)}`;
}

function parseBooked(value: Date | string | null | undefined, fallback: Date): Date {
  if (!value) return fallback;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function isUniqueOrBusyError(err: unknown): boolean {
  const anyErr = err as { message?: string; code?: string };
  const msg = String(anyErr?.message ?? err).toLowerCase();
  const code = String(anyErr?.code ?? "").toLowerCase();
  return (
    code.includes("busy") ||
    code.includes("constraint") ||
    msg.includes("unique") ||
    msg.includes("constraint failed") ||
    msg.includes("already exists") ||
    msg.includes("busy") ||
    msg.includes("database is locked") ||
    msg.includes("cannot start a transaction")
  );
}

function assertCsvTextSize(csvText: string) {
  if (csvText.length > MAX_CANDIDATE_CSV_CHARS) {
    throw new DomainError(
      "payload_too_large",
      `csvText excede ${MAX_CANDIDATE_CSV_CHARS} caracteres`,
      400,
    );
  }
}

function assertMovementsLength(count: number) {
  if (count > MAX_CANDIDATE_MOVEMENTS) {
    throw new DomainError(
      "payload_too_large",
      `movements[] excede ${MAX_CANDIDATE_MOVEMENTS} itens`,
      400,
    );
  }
}

async function findPaymentByExternalRef(
  deps: KernelDeps,
  tenantId: string,
  externalRef: string,
) {
  const [row] = await deps.db
    .select()
    .from(payments)
    .where(and(eq(payments.tenantId, tenantId), eq(payments.externalRef, externalRef)))
    .limit(1);
  return row ?? null;
}

function resultFromExisting(
  existing: typeof payments.$inferSelect,
  externalRef: string,
): CandidateIngestResult {
  return {
    paymentId: existing.id,
    bankMovementId: existing.bankMovementId ?? "",
    fracaoId: existing.fracaoId,
    allocationStatus: existing.allocationStatus,
    confidence: existing.candidateConfidence ?? 0,
    criteria: ["idempotent"],
    created: false,
    externalRef,
  };
}

async function insertCandidateInTransaction(
  deps: KernelDeps,
  input: {
    tenantId: string;
    movement: CandidateMovementInput;
    actor?: Actor;
    amountCents: number;
    externalRef: string;
  },
): Promise<CandidateIngestResult> {
  return deps.db.transaction(async (tx) => {
    const txDeps: KernelDeps = { ...deps, db: tx as unknown as KernelDb };
    const existing = await findPaymentByExternalRef(txDeps, input.tenantId, input.externalRef);
    if (existing) return resultFromExisting(existing, input.externalRef);

    const match = await matchCandidateIdentity(txDeps, {
      tenantId: input.tenantId,
      description: input.movement.description,
      debtorName: input.movement.debtorName,
      amountCents: input.amountCents,
    });
    const identified = Boolean(match.fracaoId);
    const allocationStatus = identified
      ? ALLOCATION_STATUS.identificado
      : ALLOCATION_STATUS.naoAlocadoPendente;
    const now = kernelNow(txDeps);
    const bookedAt = parseBooked(input.movement.bookedAt, now);
    const source = input.movement.source ?? CANDIDATE_SOURCES.reconciliation;

    const [movement] = await txDeps.db
      .insert(f2BankMovements)
      .values({
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        amountCents: input.amountCents,
        bookedAt,
        description: input.movement.description ?? null,
        externalRef: input.externalRef,
        counterpartyIban: input.movement.counterpartyIban ?? null,
        status: BANK_MOVEMENT_STATUS.booked,
        createdAt: now,
      })
      .returning();

    const payment = await registerPayment(txDeps, {
      tenantId: input.tenantId,
      fracaoId: match.fracaoId,
      amountCents: input.amountCents,
      paymentMethod: PAYMENT_METHODS.bankTransfer,
      payerReference: match.payerName ?? input.movement.description ?? null,
      bankMovementId: movement!.id,
      candidateSource: source,
      candidateConfidence: match.confidence,
      externalRef: input.externalRef,
      allocationStatus,
      receivedAt: bookedAt,
      actor: input.actor,
    });

    return {
      paymentId: payment.id,
      bankMovementId: movement!.id,
      fracaoId: payment.fracaoId,
      allocationStatus: payment.allocationStatus,
      confidence: match.confidence,
      criteria: match.criteria,
      created: true,
      externalRef: input.externalRef,
    };
  });
}

/**
 * Cria Payment candidato + f2_bank_movement. Idempotente por external_ref.
 * Check+insert corre numa transação; conflito UNIQUE devolve o Payment existente.
 * Não chama Allocation e não escreve na tabela Fonte `quotas`.
 */
export async function ingestCandidateMovement(
  deps: KernelDeps,
  input: {
    tenantId: string;
    movement: CandidateMovementInput;
    actor?: Actor;
  },
): Promise<CandidateIngestResult> {
  const amountCents = input.movement.amountCents;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new DomainError("invalid_amount", "amountCents inválido", 400);
  }

  const externalRef = movementExternalRef(input.tenantId, input.movement);

  return withTenantMutex(input.tenantId, async () => {
    const existing = await findPaymentByExternalRef(deps, input.tenantId, externalRef);
    if (existing) return resultFromExisting(existing, externalRef);

    let last: unknown;
    for (let attempt = 0; attempt < INGEST_UNIQUE_RETRIES; attempt++) {
      try {
        return await insertCandidateInTransaction(deps, {
          tenantId: input.tenantId,
          movement: input.movement,
          actor: input.actor,
          amountCents,
          externalRef,
        });
      } catch (err) {
        last = err;
        if (!isUniqueOrBusyError(err)) throw err;
        const raced = await findPaymentByExternalRef(deps, input.tenantId, externalRef);
        if (raced) return resultFromExisting(raced, externalRef);
        if (attempt < INGEST_UNIQUE_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw last;
  });
}

export async function ingestCandidateMovements(
  deps: KernelDeps,
  input: {
    tenantId: string;
    movements: CandidateMovementInput[];
    actor?: Actor;
  },
) {
  assertMovementsLength(input.movements.length);
  const results: CandidateIngestResult[] = [];
  for (const movement of input.movements) {
    results.push(
      await ingestCandidateMovement(deps, {
        tenantId: input.tenantId,
        movement,
        actor: input.actor,
      }),
    );
  }
  return {
    created: results.filter((r) => r.created).length,
    reused: results.filter((r) => !r.created).length,
    results,
  };
}

export async function ingestCandidatesFromCsv(
  deps: KernelDeps,
  input: {
    tenantId: string;
    csvText: string;
    actor?: Actor;
  },
) {
  assertCsvTextSize(input.csvText);
  const credits = parseBankCsvCredits(input.csvText);
  if (credits.length === 0) {
    throw new DomainError("empty_csv", "CSV sem créditos reconhecidos", 400);
  }
  assertMovementsLength(credits.length);
  return ingestCandidateMovements(deps, {
    tenantId: input.tenantId,
    actor: input.actor,
    movements: credits.map((c) => ({
      amountCents: c.amountCents,
      description: c.description,
      debtorName: c.debtorName,
      counterpartyIban: c.counterpartyIban,
      externalRef: c.externalRef,
      bookedAt: c.bookedAt,
      source: CANDIDATE_SOURCES.csv,
    })),
  });
}
