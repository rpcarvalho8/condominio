import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  accountingPeriods,
  allocations,
  constitutionFracoes,
  financialDocuments,
  ledgerEntries,
  obligations,
  payments,
  settlementPolicies,
  tenantLedgerIntegrity,
} from "../../database/schema";
import {
  ALLOCATION_STATUS,
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
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { publishDomainEvent } from "../events/emit";

type Actor = {
  personId?: string | null;
  userId?: string | null;
  requestId?: string | null;
};

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
  const [row] = await deps.db
    .insert(payments)
    .values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      fracaoId: input.fracaoId ?? null,
      amountCents: input.amountCents,
      receivedAt: now,
      payerReference: input.payerReference ?? null,
      paymentMethod: input.paymentMethod,
      allocationStatus: ALLOCATION_STATUS.naoAlocadoPendente,
      cashStatus: isCash ? CASH_STATUS.registered : null,
      registeredByPersonId: input.actor?.personId ?? null,
      evidenceUploadId: input.evidenceUploadId ?? null,
      bankMovementId: input.bankMovementId ?? null,
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
 * second_person exige verificador ≠ registante.
 */
export async function verifyCashPayment(
  deps: KernelDeps,
  input: {
    tenantId: string;
    paymentId: string;
    verificationMethod: string;
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

  if (input.verificationMethod === VERIFICATION_METHOD.secondPerson) {
    const verifier = input.actor?.personId ?? null;
    if (!verifier) {
      throw new DomainError("verifier_required", "Verificador (personId) obrigatório", 400);
    }
    if (payment.registeredByPersonId && payment.registeredByPersonId === verifier) {
      throw new DomainError(
        "self_verify_forbidden",
        "Quem regista não pode verificar (second_person) — ADR-028",
        403,
      );
    }
  }

  const now = kernelNow(deps);
  const [updated] = await deps.db
    .update(payments)
    .set({
      cashStatus: CASH_STATUS.verified,
      verificationMethod: input.verificationMethod,
      verifiedByPersonId: input.actor?.personId ?? null,
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

  const now = kernelNow(deps);
  const [updated] = await deps.db
    .update(payments)
    .set({
      cashStatus: CASH_STATUS.deposited,
      bankMovementId: input.bankMovementId ?? payment.bankMovementId,
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
 * Cada Allocation gera LedgerEntry na hash-chain.
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
    return { payment, allocations: already, idempotent: true };
  }

  const created = [];
  for (const ob of scoped) {
    if (remaining <= 0) break;
    const amount = Math.min(remaining, ob.openAmountCents);
    if (amount <= 0) continue;

    const allocationId = crypto.randomUUID();
    const now = kernelNow(deps);

    const [tip] = await deps.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.tenantId, input.tenantId))
      .orderBy(desc(ledgerEntries.sequence))
      .limit(1);
    if (!tip) {
      await ensureGenesisLedgerEntry(deps, { tenantId: input.tenantId, actor: input.actor });
    }
    const [tip2] = await deps.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.tenantId, input.tenantId))
      .orderBy(desc(ledgerEntries.sequence))
      .limit(1);
    const sequence = (tip2?.sequence ?? 0) + 1;
    const previousHash = tip2?.entryHash ?? LEDGER_GENESIS_PREVIOUS_HASH;
    const entryId = crypto.randomUUID();
    const payload = {
      allocation_id: allocationId,
      amount_cents: amount,
      currency: "EUR",
      direction: "credit",
      obligation_id: ob.id,
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
        obligationId: ob.id,
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
        obligationId: ob.id,
        amountCents: amount,
        policyId: policy.id,
        confidence: 1,
        approvedByPersonId: input.actor?.personId ?? null,
        ledgerEntryId: ledger!.id,
        createdAt: now,
      })
      .returning();

    const newOpen = ob.openAmountCents - amount;
    await deps.db
      .update(obligations)
      .set({
        openAmountCents: newOpen,
        status: newOpen === 0 ? "paid" : "open",
      })
      .where(eq(obligations.id, ob.id));

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

  const now = kernelNow(deps);
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
}
