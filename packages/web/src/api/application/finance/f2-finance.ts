import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import {
  accountingPeriods,
  allocations,
  constitutionFracoes,
  f2BankMovements,
  financialDocuments,
  ledgerEntries,
  memberships,
  obligations,
  payments,
  settlementPolicies,
  tenantLedgerIntegrity,
} from "../../database/schema";
import {
  ALLOCATION_STATUS,
  BANK_MOVEMENT_STATUS,
  CASH_STATUS,
  CHAIN_INTEGRITY,
  DEFAULT_SETTLEMENT_ORDER,
  FINANCIAL_DOC_TYPES,
  LEDGER_ALGORITHM_VERSION,
  LEDGER_ENTRY_TYPES,
  LEDGER_GENESIS_PREVIOUS_HASH,
  PAYMENT_METHODS,
  VERIFICATION_METHOD,
} from "../../domain/finance";
import { DomainError } from "../../domain/errors";
import { MEMBERSHIP_STATUS } from "../../domain/membership";
import { canVerifyCash } from "../../domain/roles";
import { kernelNow, type KernelDb, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { publishDomainEvent } from "../events/emit";
import { reconstructFracaoBalance } from "./f2-ledger-balance";

type Actor = {
  personId?: string | null;
  userId?: string | null;
  requestId?: string | null;
};

const LEDGER_WRITE_RETRIES = 8;

/** In-process per-tenant queue (ADR-029). Complements BEGIN IMMEDIATE:
 * local libSQL busy-waits synchronously, which would deadlock two async writers. */
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

function isUniqueConstraintError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return (
    msg.includes("unique") ||
    msg.includes("constraint failed") ||
    msg.includes("already exists")
  );
}

function isRetryableLedgerWrite(err: unknown): boolean {
  if (err instanceof DomainError && err.code === "obligation_race") return true;
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return (
    isUniqueConstraintError(err) ||
    msg.includes("busy") ||
    msg.includes("database is locked") ||
    msg.includes("cannot start a transaction")
  );
}

/**
 * ADR-029: exclusão mútua por tenant na atribuição de sequence + previous_hash.
 * libSQL `client.transaction()` default mode is `write` → `BEGIN IMMEDIATE`.
 */
async function withTenantLedgerLock<T>(
  deps: KernelDeps,
  fn: (locked: KernelDeps) => Promise<T>,
): Promise<T> {
  return deps.db.transaction(async (tx) => {
    return fn({ ...deps, db: tx as unknown as KernelDb });
  });
}

async function withTenantLedgerLockRetry<T>(
  deps: KernelDeps,
  fn: (locked: KernelDeps) => Promise<T>,
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < LEDGER_WRITE_RETRIES; attempt++) {
    try {
      return await withTenantLedgerLock(deps, fn);
    } catch (err) {
      last = err;
      if (attempt < LEDGER_WRITE_RETRIES - 1 && isRetryableLedgerWrite(err)) {
        await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw last;
}

export async function tenantHasFiscalizacao(
  deps: KernelDeps,
  tenantId: string,
): Promise<boolean> {
  const [row] = await deps.db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.roleCode, "Fiscalizacao"),
        eq(memberships.status, MEMBERSHIP_STATUS.active),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function recordKernelBankMovement(
  deps: KernelDeps,
  input: {
    tenantId: string;
    amountCents: number;
    description?: string | null;
    externalRef?: string | null;
    status?: string;
  },
) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new DomainError("invalid_amount", "amountCents inválido", 400);
  }
  const now = kernelNow(deps);
  const status = input.status ?? BANK_MOVEMENT_STATUS.reconciled;
  const [row] = await deps.db
    .insert(f2BankMovements)
    .values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      amountCents: input.amountCents,
      bookedAt: now,
      description: input.description ?? "cash deposit",
      externalRef: input.externalRef ?? null,
      status,
      createdAt: now,
    })
    .returning();
  return row!;
}

async function requireTenantBankMovement(
  deps: KernelDeps,
  input: {
    tenantId: string;
    movementId: string;
    minAmountCents: number;
    currentPaymentId?: string | null;
  },
) {
  const [movement] = await deps.db
    .select()
    .from(f2BankMovements)
    .where(
      and(
        eq(f2BankMovements.id, input.movementId),
        eq(f2BankMovements.tenantId, input.tenantId),
      ),
    )
    .limit(1);
  if (!movement) {
    throw new DomainError(
      "bank_movement_not_found",
      "Movimento bancário inexistente neste tenant",
      404,
    );
  }
  const okStatus =
    movement.status === BANK_MOVEMENT_STATUS.booked ||
    movement.status === BANK_MOVEMENT_STATUS.reconciled;
  if (!okStatus) {
    throw new DomainError(
      "bank_movement_not_reconciled",
      "Movimento bancário ainda não reconciliado",
      409,
    );
  }
  if (movement.amountCents < input.minAmountCents) {
    throw new DomainError(
      "bank_movement_amount_mismatch",
      "Montante do movimento inferior ao pagamento em dinheiro",
      400,
    );
  }
  const [used] = await deps.db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.tenantId, input.tenantId),
        eq(payments.bankMovementId, input.movementId),
      ),
    )
    .limit(1);
  if (used && used.id !== input.currentPaymentId) {
    throw new DomainError(
      "bank_movement_in_use",
      "Movimento bancário já associado a outro pagamento",
      409,
    );
  }
  return movement;
}

async function assertSecondPersonVerifier(
  deps: KernelDeps,
  input: { tenantId: string; paymentRegisteredBy: string | null; actor?: Actor },
) {
  if (!(await tenantHasFiscalizacao(deps, input.tenantId))) {
    throw new DomainError(
      "fiscalizacao_required",
      "Sem Fiscalizacao no tenant só é permitido bank_deposit — ADR-028",
      403,
    );
  }
  const verifier = input.actor?.personId ?? null;
  if (!verifier) {
    throw new DomainError("verifier_required", "Verificador (personId) obrigatório", 400);
  }
  if (input.paymentRegisteredBy && input.paymentRegisteredBy === verifier) {
    throw new DomainError(
      "self_verify_forbidden",
      "Quem regista não pode verificar (second_person) — ADR-028",
      403,
    );
  }
  const roles = await deps.db
    .select({ roleCode: memberships.roleCode })
    .from(memberships)
    .where(
      and(
        eq(memberships.personId, verifier),
        eq(memberships.tenantId, input.tenantId),
        eq(memberships.status, MEMBERSHIP_STATUS.active),
      ),
    );
  if (roles.length === 0 || !roles.some((m) => canVerifyCash(String(m.roleCode)))) {
    throw new DomainError(
      "verify_forbidden",
      "second_person exige Fiscalizacao ou gestor distinto do registante",
      403,
    );
  }
}

/** SQLite `mode: "timestamp"` guarda segundos — o hash usa o mesmo instante persistido. */
function ledgerTimestamp(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

function iso(d: Date): string {
  return ledgerTimestamp(d).toISOString();
}

/** Serialização canónica estável (ADR-029). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function writeAudit(
  deps: KernelDeps,
  input: {
    tenantId: string;
    type: string;
    entityType: string;
    entityId: string;
    actor?: Actor;
    after?: Record<string, unknown> | null;
    reason?: string | null;
  },
) {
  await createAuditEventRepo(deps.db).append({
    tenantId: input.tenantId,
    type: input.type,
    entityType: input.entityType,
    entityId: input.entityId,
    actorPersonId: input.actor?.personId ?? null,
    actorUserId: input.actor?.userId ?? null,
    requestId: input.actor?.requestId ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    source: "f2",
  });
}

async function assertChainWritable(deps: KernelDeps, tenantId: string) {
  const [row] = await deps.db
    .select()
    .from(tenantLedgerIntegrity)
    .where(eq(tenantLedgerIntegrity.tenantId, tenantId))
    .limit(1);
  if (row?.chainIntegrity === CHAIN_INTEGRITY.broken) {
    throw new DomainError(
      "ledger_chain_broken",
      "Cadeia do Ledger quebrada — escritas financeiras bloqueadas até reparação",
      409,
    );
  }
}

export async function ensureGenesisLedgerEntry(
  deps: KernelDeps,
  input: { tenantId: string; actor?: Actor },
) {
  const existing = await deps.db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.tenantId, input.tenantId))
    .orderBy(asc(ledgerEntries.sequence))
    .limit(1);
  if (existing.length > 0) return existing[0]!;

  const now = kernelNow(deps);
  const payload = {
    entry_type: LEDGER_ENTRY_TYPES.genesis,
    note: "tenant genesis anchor",
  };
  const entryId = crypto.randomUUID();
  const hashPayload = {
    algorithm_version: LEDGER_ALGORITHM_VERSION,
    created_at: iso(now),
    entry_id: entryId,
    entry_type: LEDGER_ENTRY_TYPES.genesis,
    payload,
    previous_hash: LEDGER_GENESIS_PREVIOUS_HASH,
    sequence: 0,
    tenant_id: input.tenantId,
  };
  const entryHash = sha256Hex(canonicalJson(hashPayload));

  try {
    const [row] = await deps.db
      .insert(ledgerEntries)
      .values({
        id: entryId,
        tenantId: input.tenantId,
        sequence: 0,
        entryType: LEDGER_ENTRY_TYPES.genesis,
        createdAt: now,
        payloadJson: canonicalJson(payload),
        previousHash: LEDGER_GENESIS_PREVIOUS_HASH,
        entryHash,
        algorithmVersion: LEDGER_ALGORITHM_VERSION,
        direction: null,
      })
      .returning();

    await deps.db
      .insert(tenantLedgerIntegrity)
      .values({
        tenantId: input.tenantId,
        chainIntegrity: CHAIN_INTEGRITY.ok,
        lastValidatedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: tenantLedgerIntegrity.tenantId,
        set: {
          chainIntegrity: CHAIN_INTEGRITY.ok,
          lastValidatedAt: now,
          updatedAt: now,
        },
      });

    await writeAudit(deps, {
      tenantId: input.tenantId,
      type: "ledger.genesis_created",
      entityType: "ledger_entry",
      entityId: entryId,
      actor: input.actor,
      after: { sequence: 0, entryHash },
    });

    return row!;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const [again] = await deps.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.tenantId, input.tenantId))
      .orderBy(asc(ledgerEntries.sequence))
      .limit(1);
    if (again) return again;
    throw err;
  }
}

export async function ensureDefaultSettlementPolicy(
  deps: KernelDeps,
  input: { tenantId: string; actor?: Actor },
) {
  const [existing] = await deps.db
    .select()
    .from(settlementPolicies)
    .where(
      and(
        eq(settlementPolicies.tenantId, input.tenantId),
        eq(settlementPolicies.code, "default"),
        eq(settlementPolicies.status, "active"),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const now = kernelNow(deps);
  const [row] = await deps.db
    .insert(settlementPolicies)
    .values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      code: "default",
      version: 1,
      status: "active",
      rulesJson: canonicalJson({ order: [...DEFAULT_SETTLEMENT_ORDER] }),
      legalBasisJson: canonicalJson(["DL 268/94", "CC propriedade horizontal"]),
      effectiveFrom: now,
      createdAt: now,
    })
    .returning();

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "settlement_policy.seeded",
    entityType: "settlement_policy",
    entityId: row!.id,
    actor: input.actor,
    after: { code: "default", version: 1 },
  });

  return row!;
}

export async function registerPayment(
  deps: KernelDeps,
  input: {
    tenantId: string;
    fracaoId?: string | null;
    amountCents: number;
    paymentMethod: string;
    payerReference?: string | null;
    evidenceUploadId?: string | null;
    bankMovementId?: string | null;
    candidateSource?: string | null;
    candidateConfidence?: number | null;
    externalRef?: string | null;
    allocationStatus?: string | null;
    receivedAt?: Date | null;
    actor?: Actor;
  },
) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new DomainError("invalid_amount", "amountCents inválido", 400);
  }
  const methods = Object.values(PAYMENT_METHODS) as string[];
  if (!methods.includes(input.paymentMethod)) {
    throw new DomainError("invalid_method", `paymentMethod inválido: ${input.paymentMethod}`, 400);
  }
  if (input.paymentMethod === PAYMENT_METHODS.cash && !input.evidenceUploadId) {
    throw new DomainError(
      "cash_evidence_required",
      "Pagamento em dinheiro exige evidência fotográfica (evidenceUploadId)",
      400,
    );
  }
  if (input.fracaoId) {
    const [fracao] = await deps.db
      .select()
      .from(constitutionFracoes)
      .where(
        and(
          eq(constitutionFracoes.id, input.fracaoId),
          eq(constitutionFracoes.tenantId, input.tenantId),
        ),
      )
      .limit(1);
    if (!fracao) throw new DomainError("fracao_not_found", "Fração não encontrada", 404);
  }

  await assertChainWritable(deps, input.tenantId);
  await ensureGenesisLedgerEntry(deps, { tenantId: input.tenantId, actor: input.actor });
  await ensureDefaultSettlementPolicy(deps, { tenantId: input.tenantId, actor: input.actor });

  const now = kernelNow(deps);
  const isCash = input.paymentMethod === PAYMENT_METHODS.cash;
  const allocationStatus =
    input.allocationStatus ??
    (input.fracaoId && input.candidateSource
      ? ALLOCATION_STATUS.identificado
      : ALLOCATION_STATUS.naoAlocadoPendente);
  const [row] = await deps.db
    .insert(payments)
    .values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      fracaoId: input.fracaoId ?? null,
      amountCents: input.amountCents,
      receivedAt: input.receivedAt ?? now,
      payerReference: input.payerReference ?? null,
      paymentMethod: input.paymentMethod,
      allocationStatus,
      cashStatus: isCash ? CASH_STATUS.registered : null,
      registeredByPersonId: input.actor?.personId ?? null,
      evidenceUploadId: input.evidenceUploadId ?? null,
      bankMovementId: input.bankMovementId ?? null,
      candidateSource: input.candidateSource ?? null,
      candidateConfidence: input.candidateConfidence ?? null,
      externalRef: input.externalRef ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "payment.registered",
    entityType: "payment",
    entityId: row!.id,
    actor: input.actor,
    after: {
      amountCents: row!.amountCents,
      paymentMethod: row!.paymentMethod,
      cashStatus: row!.cashStatus,
      allocationStatus: row!.allocationStatus,
    },
  });

  await publishDomainEvent(deps, {
    tenantId: input.tenantId,
    type: "PaymentRegistered",
    aggregateType: "payment",
    aggregateId: row!.id,
    payload: { amountCents: row!.amountCents, paymentMethod: row!.paymentMethod },
    correlationId: input.actor?.requestId ?? null,
  });

  return row!;
}

/**
 * Cash: registered → verified.
 * second_person: Fiscalizacao no tenant + verificador ≠ registante.
 * bank_deposit: movimento bancário tenant-scoped (não é free pass).
 */
export async function verifyCashPayment(
  deps: KernelDeps,
  input: {
    tenantId: string;
    paymentId: string;
    verificationMethod: string;
    bankMovementId?: string | null;
    actor?: Actor;
  },
) {
  const [payment] = await deps.db
    .select()
    .from(payments)
    .where(and(eq(payments.id, input.paymentId), eq(payments.tenantId, input.tenantId)))
    .limit(1);
  if (!payment) throw new DomainError("not_found", "Pagamento não encontrado", 404);
  if (payment.paymentMethod !== PAYMENT_METHODS.cash) {
    throw new DomainError("not_cash", "Só pagamentos cash usam este fluxo", 400);
  }
  if (payment.cashStatus !== CASH_STATUS.registered) {
    throw new DomainError(
      "invalid_cash_state",
      `cash_status actual = ${payment.cashStatus}; esperado registered`,
      409,
    );
  }

  const methods = Object.values(VERIFICATION_METHOD) as string[];
  if (!methods.includes(input.verificationMethod)) {
    throw new DomainError("invalid_verification", "verificationMethod inválido", 400);
  }

  let linkedMovementId = payment.bankMovementId;
  if (input.verificationMethod === VERIFICATION_METHOD.secondPerson) {
    await assertSecondPersonVerifier(deps, {
      tenantId: input.tenantId,
      paymentRegisteredBy: payment.registeredByPersonId,
      actor: input.actor,
    });
  } else if (input.verificationMethod === VERIFICATION_METHOD.bankDeposit) {
    const movementId = input.bankMovementId ?? payment.bankMovementId;
    if (!movementId) {
      throw new DomainError(
        "bank_movement_required",
        "bank_deposit exige movimento bancário reconciliado do tenant",
        400,
      );
    }
    await requireTenantBankMovement(deps, {
      tenantId: input.tenantId,
      movementId,
      minAmountCents: payment.amountCents,
      currentPaymentId: payment.id,
    });
    linkedMovementId = movementId;
  }

  const now = kernelNow(deps);
  const [updated] = await deps.db
    .update(payments)
    .set({
      cashStatus: CASH_STATUS.verified,
      verificationMethod: input.verificationMethod,
      verifiedByPersonId: input.actor?.personId ?? null,
      bankMovementId: linkedMovementId,
      updatedAt: now,
    })
    .where(eq(payments.id, payment.id))
    .returning();

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "payment.cash_verified",
    entityType: "payment",
    entityId: payment.id,
    actor: input.actor,
    after: {
      cashStatus: CASH_STATUS.verified,
      verificationMethod: input.verificationMethod,
      bankMovementId: linkedMovementId,
    },
  });

  return updated!;
}

export async function depositCashPayment(
  deps: KernelDeps,
  input: {
    tenantId: string;
    paymentId: string;
    bankMovementId?: string | null;
    actor?: Actor;
  },
) {
  const [payment] = await deps.db
    .select()
    .from(payments)
    .where(and(eq(payments.id, input.paymentId), eq(payments.tenantId, input.tenantId)))
    .limit(1);
  if (!payment) throw new DomainError("not_found", "Pagamento não encontrado", 404);
  if (payment.cashStatus !== CASH_STATUS.verified) {
    throw new DomainError(
      "invalid_cash_state",
      "Depósito só após verified — Obligation nunca liquida só com registered",
      409,
    );
  }

  const movementId = input.bankMovementId ?? payment.bankMovementId;
  if (!movementId) {
    throw new DomainError(
      "bank_movement_required",
      "Depósito exige movimento bancário tenant-scoped (bankMovementId)",
      400,
    );
  }
  await requireTenantBankMovement(deps, {
    tenantId: input.tenantId,
    movementId,
    minAmountCents: payment.amountCents,
    currentPaymentId: payment.id,
  });

  const now = kernelNow(deps);
  const [updated] = await deps.db
    .update(payments)
    .set({
      cashStatus: CASH_STATUS.deposited,
      bankMovementId: movementId,
      depositedAt: now,
      updatedAt: now,
    })
    .where(eq(payments.id, payment.id))
    .returning();

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "payment.cash_deposited",
    entityType: "payment",
    entityId: payment.id,
    actor: input.actor,
    after: { cashStatus: CASH_STATUS.deposited },
  });

  return updated!;
}

function obligationRank(kind: string, order: string[]): number {
  const mapped =
    kind === "fcr" || kind === "FCR"
      ? "fcr"
      : kind === "quota_corrente" || kind === "quotaCorrente"
        ? "quota_corrente"
        : kind === "extraordinaria"
          ? "extraordinaria"
          : "divida_antiga";
  const idx = order.indexOf(mapped);
  return idx === -1 ? order.length + 1 : idx;
}

function paymentAllocatable(payment: typeof payments.$inferSelect): boolean {
  if (payment.paymentMethod === PAYMENT_METHODS.cash) {
    return (
      payment.cashStatus === CASH_STATUS.verified ||
      payment.cashStatus === CASH_STATUS.deposited
    );
  }
  return true;
}

/**
 * Aloca Payment a Obligations abertas via SettlementPolicy.
 * Cada Allocation gera LedgerEntry na hash-chain sob BEGIN IMMEDIATE (ADR-029).
 * Cash só aloca se verified/deposited.
 */
export async function allocatePayment(
  deps: KernelDeps,
  input: {
    tenantId: string;
    paymentId: string;
    actor?: Actor;
  },
) {
  return withTenantMutex(input.tenantId, () =>
    withTenantLedgerLockRetry(deps, (locked) => allocatePaymentLocked(locked, input)),
  );
}

async function allocatePaymentLocked(
  deps: KernelDeps,
  input: {
    tenantId: string;
    paymentId: string;
    actor?: Actor;
  },
) {
  await assertChainWritable(deps, input.tenantId);

  const [payment] = await deps.db
    .select()
    .from(payments)
    .where(and(eq(payments.id, input.paymentId), eq(payments.tenantId, input.tenantId)))
    .limit(1);
  if (!payment) throw new DomainError("not_found", "Pagamento não encontrado", 404);

  if (!paymentAllocatable(payment)) {
    throw new DomainError(
      "cash_not_verified",
      "Payment cash em registered não pode liquidar Obligation — verificar primeiro",
      409,
    );
  }

  if (payment.allocationStatus === ALLOCATION_STATUS.totalmenteAlocado) {
    const existing = await deps.db
      .select()
      .from(allocations)
      .where(eq(allocations.paymentId, payment.id));
    const { enqueueReceiptForPaymentJob } = await import("./f2-jobs");
    await enqueueReceiptForPaymentJob(deps, {
      tenantId: input.tenantId,
      paymentId: payment.id,
      correlationId: input.actor?.requestId ?? null,
    });
    return { payment, allocations: existing, idempotent: true };
  }

  const policy = await ensureDefaultSettlementPolicy(deps, {
    tenantId: input.tenantId,
    actor: input.actor,
  });
  const rules = JSON.parse(policy.rulesJson) as { order?: string[] };
  const order = rules.order ?? [...DEFAULT_SETTLEMENT_ORDER];

  const openObs = await deps.db
    .select()
    .from(obligations)
    .where(and(eq(obligations.tenantId, input.tenantId), eq(obligations.status, "open")));
  const scoped = openObs
    .filter((o) => !payment.fracaoId || o.fracaoId === payment.fracaoId)
    .filter((o) => o.openAmountCents > 0)
    .sort((a, b) => {
      const ra = obligationRank(a.kind, order);
      const rb = obligationRank(b.kind, order);
      if (ra !== rb) return ra - rb;
      return a.periodYear - b.periodYear;
    });

  if (scoped.length === 0) {
    throw new DomainError("no_open_obligations", "Sem Obligations abertas para alocar", 400);
  }

  const already = await deps.db
    .select()
    .from(allocations)
    .where(eq(allocations.paymentId, payment.id));
  const alreadyAllocated = already.reduce((s, a) => s + a.amountCents, 0);
  let remaining = payment.amountCents - alreadyAllocated;
  if (remaining <= 0) {
    await deps.db
      .update(payments)
      .set({
        allocationStatus: ALLOCATION_STATUS.totalmenteAlocado,
        updatedAt: kernelNow(deps),
      })
      .where(eq(payments.id, payment.id));
    const { enqueueReceiptForPaymentJob } = await import("./f2-jobs");
    await enqueueReceiptForPaymentJob(deps, {
      tenantId: input.tenantId,
      paymentId: payment.id,
      correlationId: input.actor?.requestId ?? null,
    });
    return { payment, allocations: already, idempotent: true };
  }

  await ensureGenesisLedgerEntry(deps, { tenantId: input.tenantId, actor: input.actor });

  const created = [];
  for (const ob of scoped) {
    if (remaining <= 0) break;

    const [fresh] = await deps.db
      .select()
      .from(obligations)
      .where(and(eq(obligations.id, ob.id), eq(obligations.tenantId, input.tenantId)))
      .limit(1);
    if (!fresh || fresh.openAmountCents <= 0) continue;

    const amount = Math.min(remaining, fresh.openAmountCents);
    if (amount <= 0) continue;

    const allocationId = crypto.randomUUID();
    const now = kernelNow(deps);

    const [tip] = await deps.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.tenantId, input.tenantId))
      .orderBy(desc(ledgerEntries.sequence))
      .limit(1);
    const sequence = (tip?.sequence ?? 0) + 1;
    const previousHash = tip?.entryHash ?? LEDGER_GENESIS_PREVIOUS_HASH;
    const entryId = crypto.randomUUID();
    const payload = {
      allocation_id: allocationId,
      amount_cents: amount,
      currency: "EUR",
      direction: "credit",
      obligation_id: fresh.id,
      payment_id: payment.id,
      policy_id: policy.id,
    };
    const hashPayload = {
      algorithm_version: LEDGER_ALGORITHM_VERSION,
      created_at: iso(now),
      entry_id: entryId,
      entry_type: LEDGER_ENTRY_TYPES.allocation,
      payload,
      previous_hash: previousHash,
      sequence,
      tenant_id: input.tenantId,
    };
    const entryHash = sha256Hex(canonicalJson(hashPayload));

    const [ledger] = await deps.db
      .insert(ledgerEntries)
      .values({
        id: entryId,
        tenantId: input.tenantId,
        sequence,
        entryType: LEDGER_ENTRY_TYPES.allocation,
        createdAt: now,
        payloadJson: canonicalJson(payload),
        previousHash,
        entryHash,
        algorithmVersion: LEDGER_ALGORITHM_VERSION,
        allocationId,
        paymentId: payment.id,
        obligationId: fresh.id,
        amountCents: amount,
        direction: "credit",
      })
      .returning();

    const [alloc] = await deps.db
      .insert(allocations)
      .values({
        id: allocationId,
        tenantId: input.tenantId,
        paymentId: payment.id,
        obligationId: fresh.id,
        amountCents: amount,
        policyId: policy.id,
        confidence: 1,
        approvedByPersonId: input.actor?.personId ?? null,
        ledgerEntryId: ledger!.id,
        createdAt: now,
      })
      .returning();

    const newOpen = fresh.openAmountCents - amount;
    const [updatedOb] = await deps.db
      .update(obligations)
      .set({
        openAmountCents: newOpen,
        status: newOpen === 0 ? "paid" : "open",
      })
      .where(
        and(
          eq(obligations.id, fresh.id),
          eq(obligations.tenantId, input.tenantId),
          gte(obligations.openAmountCents, amount),
        ),
      )
      .returning();
    if (!updatedOb) {
      throw new DomainError(
        "obligation_race",
        "Obligation alterada concorrentemente — retry",
        409,
      );
    }

    remaining -= amount;
    created.push(alloc!);
  }

  const totalAllocated = alreadyAllocated + created.reduce((s, a) => s + a.amountCents, 0);
  const status =
    totalAllocated <= 0
      ? ALLOCATION_STATUS.naoAlocadoPendente
      : totalAllocated >= payment.amountCents
        ? ALLOCATION_STATUS.totalmenteAlocado
        : ALLOCATION_STATUS.parcialmenteAlocado;

  const [updatedPayment] = await deps.db
    .update(payments)
    .set({ allocationStatus: status, updatedAt: kernelNow(deps) })
    .where(eq(payments.id, payment.id))
    .returning();

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "payment.allocated",
    entityType: "payment",
    entityId: payment.id,
    actor: input.actor,
    after: {
      allocations: created.length,
      allocationStatus: status,
      remaining,
    },
  });

  await publishDomainEvent(deps, {
    tenantId: input.tenantId,
    type: "PaymentAllocated",
    aggregateType: "payment",
    aggregateId: payment.id,
    payload: { allocations: created.length, allocationStatus: status },
    correlationId: input.actor?.requestId ?? null,
  });

  const { enqueueReceiptForPaymentJob } = await import("./f2-jobs");
  await enqueueReceiptForPaymentJob(deps, {
    tenantId: input.tenantId,
    paymentId: payment.id,
    correlationId: input.actor?.requestId ?? null,
  });

  return {
    payment: updatedPayment!,
    allocations: [...already, ...created],
    idempotent: false,
  };
}

export async function validateLedgerChain(
  deps: KernelDeps,
  input: { tenantId: string; actor?: Actor },
) {
  const rows = await deps.db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.tenantId, input.tenantId))
    .orderBy(asc(ledgerEntries.sequence));

  if (rows.length === 0) {
    return { ok: true as const, entries: 0 };
  }

  let previousHash = LEDGER_GENESIS_PREVIOUS_HASH;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.sequence !== i) {
      return markBroken(deps, input.tenantId, row.sequence, "sequence_gap", input.actor);
    }
    if (row.previousHash !== previousHash) {
      return markBroken(deps, input.tenantId, row.sequence, "previous_hash_mismatch", input.actor);
    }
    const payload = JSON.parse(row.payloadJson);
    const hashPayload = {
      algorithm_version: row.algorithmVersion,
      created_at: iso(row.createdAt),
      entry_id: row.id,
      entry_type: row.entryType,
      payload,
      previous_hash: row.previousHash,
      sequence: row.sequence,
      tenant_id: row.tenantId,
    };
    const expected = sha256Hex(canonicalJson(hashPayload));
    if (expected !== row.entryHash) {
      return markBroken(deps, input.tenantId, row.sequence, "entry_hash_mismatch", input.actor);
    }
    previousHash = row.entryHash;
  }

  const now = kernelNow(deps);
  await deps.db
    .insert(tenantLedgerIntegrity)
    .values({
      tenantId: input.tenantId,
      chainIntegrity: CHAIN_INTEGRITY.ok,
      lastValidatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: tenantLedgerIntegrity.tenantId,
      set: {
        chainIntegrity: CHAIN_INTEGRITY.ok,
        lastValidatedAt: now,
        lastBreakSequence: null,
        updatedAt: now,
      },
    });

  return { ok: true as const, entries: rows.length };
}

async function markBroken(
  deps: KernelDeps,
  tenantId: string,
  sequence: number,
  reason: string,
  actor?: Actor,
) {
  const now = kernelNow(deps);
  await deps.db
    .insert(tenantLedgerIntegrity)
    .values({
      tenantId,
      chainIntegrity: CHAIN_INTEGRITY.broken,
      lastValidatedAt: now,
      lastBreakSequence: sequence,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: tenantLedgerIntegrity.tenantId,
      set: {
        chainIntegrity: CHAIN_INTEGRITY.broken,
        lastValidatedAt: now,
        lastBreakSequence: sequence,
        updatedAt: now,
      },
    });

  await writeAudit(deps, {
    tenantId,
    type: "ledger.chain_broken",
    entityType: "ledger",
    entityId: tenantId,
    actor,
    after: { sequence, reason },
    reason,
  });

  return { ok: false as const, sequence, reason };
}

export async function openAccountingPeriod(
  deps: KernelDeps,
  input: { tenantId: string; year: number; month: number; actor?: Actor },
) {
  if (input.month < 1 || input.month > 12) {
    throw new DomainError("invalid_month", "Mês inválido", 400);
  }
  const [existing] = await deps.db
    .select()
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.tenantId, input.tenantId),
        eq(accountingPeriods.year, input.year),
        eq(accountingPeriods.month, input.month),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const now = kernelNow(deps);
  const [row] = await deps.db
    .insert(accountingPeriods)
    .values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      year: input.year,
      month: input.month,
      status: "open",
      createdAt: now,
    })
    .returning();
  return row!;
}

export async function closeAccountingPeriod(
  deps: KernelDeps,
  input: { tenantId: string; year: number; month: number; actor?: Actor },
) {
  const [period] = await deps.db
    .select()
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.tenantId, input.tenantId),
        eq(accountingPeriods.year, input.year),
        eq(accountingPeriods.month, input.month),
      ),
    )
    .limit(1);
  if (!period) throw new DomainError("not_found", "Período não encontrado", 404);
  if (period.status === "closed") return { period, idempotent: true };

  const now = kernelNow(deps);
  const [updated] = await deps.db
    .update(accountingPeriods)
    .set({
      status: "closed",
      closedAt: now,
      closedByPersonId: input.actor?.personId ?? null,
    })
    .where(eq(accountingPeriods.id, period.id))
    .returning();

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "accounting_period.closed",
    entityType: "accounting_period",
    entityId: period.id,
    actor: input.actor,
    after: { year: input.year, month: input.month },
  });

  return { period: updated!, idempotent: false };
}

export async function issuePaymentNotice(
  deps: KernelDeps,
  input: {
    tenantId: string;
    fracaoId: string;
    amountCents: number;
    periodLabel: string;
    obligationIds: string[];
    actor?: Actor;
  },
) {
  if (!input.obligationIds.length) {
    throw new DomainError("empty_notice", "PaymentNotice exige obligations em generated_from", 400);
  }
  const uniqueIds = [...new Set(input.obligationIds)];
  if (uniqueIds.length !== input.obligationIds.length) {
    throw new DomainError("duplicate_obligations", "obligationIds duplicados", 400);
  }

  const [fracao] = await deps.db
    .select()
    .from(constitutionFracoes)
    .where(
      and(
        eq(constitutionFracoes.id, input.fracaoId),
        eq(constitutionFracoes.tenantId, input.tenantId),
      ),
    )
    .limit(1);
  if (!fracao) throw new DomainError("fracao_not_found", "Fração não encontrada", 404);

  const obs = await deps.db
    .select()
    .from(obligations)
    .where(and(eq(obligations.tenantId, input.tenantId), inArray(obligations.id, uniqueIds)));
  if (obs.length !== uniqueIds.length) {
    throw new DomainError(
      "obligation_not_found",
      "Obligations inexistentes ou doutro tenant",
      404,
    );
  }
  if (obs.some((o) => o.fracaoId !== input.fracaoId)) {
    throw new DomainError(
      "obligation_fracao_mismatch",
      "Obligations não pertencem à fração do aviso",
      400,
    );
  }
  const expectedCents = obs
    .filter((o) => o.openAmountCents > 0)
    .reduce((s, o) => s + o.openAmountCents, 0);
  if (expectedCents !== input.amountCents) {
    throw new DomainError(
      "notice_amount_mismatch",
      `amountCents ${input.amountCents} ≠ soma em aberto das obligations ${expectedCents}`,
      400,
    );
  }

  const now = kernelNow(deps);
  const [doc] = await deps.db
    .insert(financialDocuments)
    .values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      fracaoId: input.fracaoId,
      docType: FINANCIAL_DOC_TYPES.paymentNotice,
      periodLabel: input.periodLabel,
      issuedAt: now,
      amountCents: input.amountCents,
      status: "issued",
      documentNumber: `PN-${input.periodLabel}-${input.fracaoId.slice(0, 8)}`,
      generatedFromJson: canonicalJson({ obligationIds: input.obligationIds }),
      createdAt: now,
    })
    .returning();

  await writeAudit(deps, {
    tenantId: input.tenantId,
    type: "financial_document.issued",
    entityType: "financial_document",
    entityId: doc!.id,
    actor: input.actor,
    after: { docType: FINANCIAL_DOC_TYPES.paymentNotice, amountCents: input.amountCents },
  });

  return doc!;
}

export async function issueReceiptForPayment(
  deps: KernelDeps,
  input: { tenantId: string; paymentId: string; actor?: Actor },
) {
  const [payment] = await deps.db
    .select()
    .from(payments)
    .where(and(eq(payments.id, input.paymentId), eq(payments.tenantId, input.tenantId)))
    .limit(1);
  if (!payment) throw new DomainError("not_found", "Pagamento não encontrado", 404);
  if (payment.allocationStatus === ALLOCATION_STATUS.naoAlocadoPendente) {
    throw new DomainError("empty_receipt", "Recibo nunca é emitido sem Allocation", 409);
  }

  const allocs = await deps.db
    .select()
    .from(allocations)
    .where(eq(allocations.paymentId, payment.id));
  if (allocs.length === 0) {
    throw new DomainError("empty_receipt", "Recibo nunca é emitido sem Allocation", 409);
  }

  const [existing] = await deps.db
    .select()
    .from(financialDocuments)
    .where(
      and(
        eq(financialDocuments.tenantId, input.tenantId),
        eq(financialDocuments.docType, FINANCIAL_DOC_TYPES.receipt),
        eq(financialDocuments.sourcePaymentId, payment.id),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const now = kernelNow(deps);
  try {
    const [doc] = await deps.db
      .insert(financialDocuments)
      .values({
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        fracaoId: payment.fracaoId,
        docType: FINANCIAL_DOC_TYPES.receipt,
        issuedAt: now,
        amountCents: payment.amountCents,
        status: "issued",
        documentNumber: `RC-${payment.id.slice(0, 8)}`,
        generatedFromJson: canonicalJson({
          paymentId: payment.id,
          allocationIds: allocs.map((a) => a.id),
        }),
        sourcePaymentId: payment.id,
        createdAt: now,
      })
      .returning();

    await writeAudit(deps, {
      tenantId: input.tenantId,
      type: "financial_document.issued",
      entityType: "financial_document",
      entityId: doc!.id,
      actor: input.actor,
      after: { docType: FINANCIAL_DOC_TYPES.receipt, paymentId: payment.id },
    });

    return doc!;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const [again] = await deps.db
      .select()
      .from(financialDocuments)
      .where(
        and(
          eq(financialDocuments.tenantId, input.tenantId),
          eq(financialDocuments.docType, FINANCIAL_DOC_TYPES.receipt),
          eq(financialDocuments.sourcePaymentId, payment.id),
        ),
      )
      .limit(1);
    if (again) return again;
    throw err;
  }
}

/** Extrato sob pedido — representação imutável reconstruída do Ledger (ADR-015). */
export async function issueAccountStatement(
  deps: KernelDeps,
  input: { tenantId: string; fracaoId: string; periodLabel?: string | null; actor?: Actor },
) {
  const balance = await reconstructFracaoBalance(deps, {
    tenantId: input.tenantId,
    fracaoId: input.fracaoId,
  });
  const now = kernelNow(deps);
  const periodLabel =
    input.periodLabel?.trim() ||
    `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  const existingWhere = and(
    eq(financialDocuments.tenantId, input.tenantId),
    eq(financialDocuments.fracaoId, input.fracaoId),
    eq(financialDocuments.docType, FINANCIAL_DOC_TYPES.accountStatement),
    eq(financialDocuments.periodLabel, periodLabel),
  );
  const [existing] = await deps.db.select().from(financialDocuments).where(existingWhere).limit(1);
  if (existing) return existing;

  const obligationIds = balance.debts.map((d) => d.obligationId);
  const entries =
    obligationIds.length === 0
      ? []
      : await deps.db
          .select({ id: ledgerEntries.id })
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.tenantId, input.tenantId),
              inArray(ledgerEntries.obligationId, obligationIds),
            ),
          );

  try {
    const [doc] = await deps.db
      .insert(financialDocuments)
      .values({
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        fracaoId: input.fracaoId,
        docType: FINANCIAL_DOC_TYPES.accountStatement,
        periodLabel,
        issuedAt: now,
        amountCents: balance.openCents,
        status: "issued",
        documentNumber: `EX-${periodLabel}-${input.fracaoId.slice(0, 8)}-${now.getTime().toString(36)}`,
        generatedFromJson: canonicalJson({
          obligationIds,
          ledgerEntryIds: entries.map((e) => e.id),
          originalCents: balance.originalCents,
          allocatedCents: balance.allocatedCents,
          adjustmentCents: balance.adjustmentCents,
          openCents: balance.openCents,
        }),
        createdAt: now,
      })
      .returning();

    await writeAudit(deps, {
      tenantId: input.tenantId,
      type: "financial_document.issued",
      entityType: "financial_document",
      entityId: doc!.id,
      actor: input.actor,
      after: { docType: FINANCIAL_DOC_TYPES.accountStatement, amountCents: balance.openCents },
    });

    return doc!;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const [again] = await deps.db.select().from(financialDocuments).where(existingWhere).limit(1);
    if (again) return again;
    throw err;
  }
}

export async function listFinancialDocumentsForFracoes(
  deps: KernelDeps,
  input: { tenantId: string; fracaoIds: string[] },
) {
  if (input.fracaoIds.length === 0) return [];
  return deps.db
    .select()
    .from(financialDocuments)
    .where(
      and(
        eq(financialDocuments.tenantId, input.tenantId),
        inArray(financialDocuments.fracaoId, input.fracaoIds),
      ),
    );
}

export async function getFinancialDocumentInTenant(
  deps: KernelDeps,
  input: { tenantId: string; documentId: string },
) {
  const [doc] = await deps.db
    .select()
    .from(financialDocuments)
    .where(
      and(eq(financialDocuments.id, input.documentId), eq(financialDocuments.tenantId, input.tenantId)),
    )
    .limit(1);
  return doc ?? null;
}
