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
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { parseBankCsvCredits } from "./f2-csv-movements";
import { matchCandidateIdentity } from "./f2-identity";
import { registerPayment } from "./f2-finance";

type Actor = {
  personId?: string | null;
  userId?: string | null;
  requestId?: string | null;
};

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

/**
 * Cria Payment candidato + f2_bank_movement. Idempotente por external_ref.
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
  const existing = await findPaymentByExternalRef(deps, input.tenantId, externalRef);
  if (existing) {
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

  const match = await matchCandidateIdentity(deps, {
    tenantId: input.tenantId,
    description: input.movement.description,
    debtorName: input.movement.debtorName,
    amountCents,
  });
  const identified = Boolean(match.fracaoId);
  const allocationStatus = identified
    ? ALLOCATION_STATUS.identificado
    : ALLOCATION_STATUS.naoAlocadoPendente;
  const now = kernelNow(deps);
  const bookedAt = parseBooked(input.movement.bookedAt, now);
  const source = input.movement.source ?? CANDIDATE_SOURCES.reconciliation;

  const [movement] = await deps.db
    .insert(f2BankMovements)
    .values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      amountCents,
      bookedAt,
      description: input.movement.description ?? null,
      externalRef,
      counterpartyIban: input.movement.counterpartyIban ?? null,
      status: BANK_MOVEMENT_STATUS.booked,
      createdAt: now,
    })
    .returning();

  const payment = await registerPayment(deps, {
    tenantId: input.tenantId,
    fracaoId: match.fracaoId,
    amountCents,
    paymentMethod: PAYMENT_METHODS.bankTransfer,
    payerReference: match.payerName ?? input.movement.description ?? null,
    bankMovementId: movement!.id,
    candidateSource: source,
    candidateConfidence: match.confidence,
    externalRef,
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
    externalRef,
  };
}

export async function ingestCandidateMovements(
  deps: KernelDeps,
  input: {
    tenantId: string;
    movements: CandidateMovementInput[];
    actor?: Actor;
  },
) {
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
  const credits = parseBankCsvCredits(input.csvText);
  if (credits.length === 0) {
    throw new DomainError("empty_csv", "CSV sem créditos reconhecidos", 400);
  }
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
