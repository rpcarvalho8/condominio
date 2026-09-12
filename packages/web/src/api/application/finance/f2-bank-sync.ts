/**
 * Enable Banking PSD2 sobre o kernel F2.
 * Consentimento ASPSP + sync → f2_bank_movements + Payments candidatos.
 * Nunca marca Quota.pago. CSV continua o fallback quando a sessão falha / reauth.
 */
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { condoBankConnections, f2BankMovements } from "../../database/schema";
import {
  BANK_CONSENT_STATUS,
  BANK_MOVEMENT_STATUS,
  CANDIDATE_SOURCES,
} from "../../domain/finance";
import { DomainError } from "../../domain/errors";
import { normalizeIBAN } from "../../lib/iban";
import { OUTBOX_JOB_TYPES } from "../../domain/outbox";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { createDomainEventRepo } from "../../infra/repos/domain-event-repo";
import { createOutboxRepo } from "../../infra/repos/outbox-repo";
import { ingestCandidateMovement } from "./f2-candidates";
import {
  consentHasExpired,
  listBankConnections,
  upsertBankConnection,
} from "./f2-bank-connection";
import {
  createEnableBankingClientFromEnv,
  defaultAspspCountry,
  defaultAspspName,
  defaultConsentValidUntil,
  f2EnableBankingRedirectUri,
  normalizePsd2Scopes,
  parseConsentScopesJson,
  pickCondoAccount,
  sanitizeBankError,
  splitSyncDateChunks,
  type EnableBankingClient,
  type EnableBankingTransaction,
} from "./enable-banking-adapter";

type Actor = {
  personId?: string | null;
  userId?: string | null;
  requestId?: string | null;
};

type BankConnectionRow = typeof condoBankConnections.$inferSelect;

export type BankConsentState = {
  tenantId: string;
  connectionId: string;
  nonce: string;
};

function enableBankingClient(deps: KernelDeps): EnableBankingClient {
  return deps.enableBanking ?? createEnableBankingClientFromEnv();
}

function requireConfiguredClient(deps: KernelDeps): EnableBankingClient {
  const client = enableBankingClient(deps);
  if (!client.isConfigured()) {
    throw new DomainError(
      "enable_banking_not_configured",
      "Enable Banking não configurado no servidor",
      503,
    );
  }
  return client;
}

function encodeConsentState(state: BankConsentState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

/** Código curto e estável para redirects OAuth — nunca a mensagem de domínio na URL. */
export function publicBankConsentErrorCode(err: unknown): string {
  if (err instanceof DomainError) {
    switch (err.code) {
      case "bank_account_iban_required":
        return "account_iban_required";
      case "bank_account_iban_mismatch":
        return "account_mismatch";
      case "bank_consent_denied":
        return "consent_denied";
      case "bank_consent_no_code":
        return "no_code";
      case "bank_consent_invalid_state":
        return "invalid_state";
      case "bank_consent_tenant_mismatch":
        return "tenant_mismatch";
      case "enable_banking_not_configured":
        return "not_configured";
      default:
        return "consent_failed";
    }
  }
  return "consent_failed";
}

function requireCondoIban(
  requested?: string | null,
  stored?: string | null,
): string {
  const preferred = normalizeIBAN(requested) ?? normalizeIBAN(stored);
  if (!preferred) {
    throw new DomainError(
      "bank_account_iban_required",
      "IBAN da conta do condomínio é obrigatório para autorizar o ASPSP (ADR-014)",
      400,
    );
  }
  return preferred;
}

function condoOwnIbans(row: BankConnectionRow): string[] {
  const own = new Set<string>();
  const preferred = normalizeIBAN(row.accountIban);
  if (preferred) own.add(preferred);
  if (!row.accountsJson?.trim()) return [...own];
  try {
    const parsed = JSON.parse(row.accountsJson) as unknown;
    const list = Array.isArray(parsed) ? parsed : [];
    for (const item of list) {
      const rec = item && typeof item === "object" ? (item as { iban?: unknown }) : null;
      const iban = normalizeIBAN(typeof rec?.iban === "string" ? rec.iban : null);
      if (iban && (!preferred || iban === preferred)) own.add(iban);
    }
  } catch {
    /* accounts_json malformado — o IBAN persistido continua a valer */
  }
  return [...own];
}

function withoutOwnCounterparty(
  tx: EnableBankingTransaction,
  ownIbans: Iterable<string>,
): EnableBankingTransaction {
  const own = new Set(
    [...ownIbans]
      .map((iban) => normalizeIBAN(iban))
      .filter((iban): iban is string => Boolean(iban)),
  );
  const counterparty = normalizeIBAN(tx.counterpartyIban);
  if (counterparty && own.has(counterparty)) {
    return { ...tx, counterpartyIban: null };
  }
  return tx;
}

export function decodeConsentState(raw: string | null | undefined): BankConsentState | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<BankConsentState>;
    if (!parsed.tenantId || !parsed.connectionId || !parsed.nonce) return null;
    return {
      tenantId: String(parsed.tenantId),
      connectionId: String(parsed.connectionId),
      nonce: String(parsed.nonce),
    };
  } catch {
    return null;
  }
}

function isAuthProviderError(message: string): boolean {
  return /\b(401|403)\b/.test(message) || /invalid_grant|consent|expired|revoked|unauthorized/i.test(message);
}

async function loadTenantConnection(
  deps: KernelDeps,
  tenantId: string,
  connectionId?: string | null,
): Promise<BankConnectionRow> {
  const rows = await listBankConnections(deps, tenantId);
  const row = connectionId ? rows.find((r) => r.id === connectionId) : rows[0];
  if (!row) {
    throw new DomainError("bank_connection_not_found", "BankConnection inexistente neste tenant", 404);
  }
  return row;
}

function movementExternalRef(connectionId: string, tx: EnableBankingTransaction): string {
  if (tx.transactionId?.trim()) return `eb:${tx.transactionId.trim()}`;
  const day = tx.bookedAt.toISOString().slice(0, 10);
  const raw = [connectionId, String(tx.amountCents), day, tx.description, tx.debtorName ?? ""].join("|");
  return `eb:${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32)}`;
}

async function upsertDebitMovement(
  deps: KernelDeps,
  input: {
    tenantId: string;
    amountCents: number;
    bookedAt: Date;
    description: string | null;
    externalRef: string;
    counterpartyIban: string | null;
  },
) {
  const now = kernelNow(deps);
  const [existing] = await deps.db
    .select()
    .from(f2BankMovements)
    .where(
      and(eq(f2BankMovements.tenantId, input.tenantId), eq(f2BankMovements.externalRef, input.externalRef)),
    )
    .limit(1);
  if (existing) {
    const [updated] = await deps.db
      .update(f2BankMovements)
      .set({
        amountCents: input.amountCents,
        bookedAt: input.bookedAt,
        description: input.description,
        counterpartyIban: input.counterpartyIban,
      })
      .where(and(eq(f2BankMovements.id, existing.id), eq(f2BankMovements.tenantId, input.tenantId)))
      .returning();
    return { movementId: updated!.id, created: false };
  }
  const [inserted] = await deps.db
    .insert(f2BankMovements)
    .values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      amountCents: input.amountCents,
      bookedAt: input.bookedAt,
      description: input.description,
      externalRef: input.externalRef,
      counterpartyIban: input.counterpartyIban,
      status: BANK_MOVEMENT_STATUS.booked,
      createdAt: now,
    })
    .returning();
  return { movementId: inserted!.id, created: true };
}

async function applySyncedTransaction(
  deps: KernelDeps,
  input: {
    tenantId: string;
    connectionId: string;
    tx: EnableBankingTransaction;
    actor?: Actor;
  },
) {
  const externalRef = movementExternalRef(input.connectionId, input.tx);
  if (input.tx.amountCents > 0) {
    const ingested = await ingestCandidateMovement(deps, {
      tenantId: input.tenantId,
      actor: input.actor,
      movement: {
        amountCents: input.tx.amountCents,
        description: input.tx.description,
        debtorName: input.tx.debtorName,
        counterpartyIban: input.tx.counterpartyIban,
        externalRef,
        bookedAt: input.tx.bookedAt,
        source: CANDIDATE_SOURCES.enableBanking,
      },
    });
    if (!ingested.created && ingested.bankMovementId) {
      await deps.db
        .update(f2BankMovements)
        .set({
          description: input.tx.description,
          counterpartyIban: input.tx.counterpartyIban,
          bookedAt: input.tx.bookedAt,
        })
        .where(
          and(
            eq(f2BankMovements.id, ingested.bankMovementId),
            eq(f2BankMovements.tenantId, input.tenantId),
          ),
        );
    }
    return { ...ingested, kind: "credit" as const };
  }
  const debit = await upsertDebitMovement(deps, {
    tenantId: input.tenantId,
    amountCents: input.tx.amountCents,
    bookedAt: input.tx.bookedAt,
    description: input.tx.description,
    externalRef,
    counterpartyIban: input.tx.counterpartyIban,
  });
  return {
    paymentId: null as string | null,
    bankMovementId: debit.movementId,
    created: debit.created,
    externalRef,
    kind: "debit" as const,
  };
}

export async function startBankConsent(
  deps: KernelDeps,
  input: {
    tenantId: string;
    aspsp?: string | null;
    aspspCountry?: string | null;
    accountIban?: string | null;
    authorizedByMembershipId?: string | null;
    scopes?: string[] | null;
    reauthorize?: boolean;
    actor?: Actor;
  },
) {
  const client = requireConfiguredClient(deps);
  const now = kernelNow(deps);
  const scopes = normalizePsd2Scopes(input.scopes);
  const aspsp = input.aspsp?.trim() || defaultAspspName();
  const existing = (await listBankConnections(deps, input.tenantId))[0] ?? null;
  if (existing?.consentStatus === BANK_CONSENT_STATUS.revoked && !input.reauthorize) {
    throw new DomainError(
      "bank_connection_revoked",
      "BankConnection revogada — inicia nova autorização",
      409,
    );
  }
  const accountIban = requireCondoIban(input.accountIban, existing?.accountIban);

  const row = await upsertBankConnection(deps, {
    tenantId: input.tenantId,
    provider: "enable_banking",
    aspsp,
    accountIban,
    consentStatus: input.reauthorize
      ? BANK_CONSENT_STATUS.reauthorizationRequired
      : existing?.consentStatus === BANK_CONSENT_STATUS.authorized
        ? BANK_CONSENT_STATUS.authorized
        : BANK_CONSENT_STATUS.pending,
    authorizedByMembershipId: input.authorizedByMembershipId ?? existing?.authorizedByMembershipId,
    consentScopes: JSON.stringify(scopes),
    actor: input.actor,
  });

  const state = encodeConsentState({
    tenantId: input.tenantId,
    connectionId: row.id,
    nonce: crypto.randomUUID(),
  });
  const validUntil = defaultConsentValidUntil(now);
  let auth;
  try {
    auth = await client.createAuthSession({
      aspspName: aspsp,
      aspspCountry: input.aspspCountry?.trim() || defaultAspspCountry(),
      redirectUrl: f2EnableBankingRedirectUri(),
      state,
      scopes,
      validUntil,
      psuType: "business",
    });
  } catch (err) {
    const lastError = sanitizeBankError(err);
    await upsertBankConnection(deps, { tenantId: input.tenantId, lastError });
    throw new DomainError("bank_consent_start_failed", lastError, 502);
  }

  const updated = await upsertBankConnection(deps, {
    tenantId: input.tenantId,
    authState: state,
    consentStatus: input.reauthorize
      ? BANK_CONSENT_STATUS.reauthorizationRequired
      : BANK_CONSENT_STATUS.pending,
    actor: input.actor,
  });

  await createAuditEventRepo(deps.db).append({
    tenantId: input.tenantId,
    type: input.reauthorize
      ? "bank_connection.reauthorization_started"
      : "bank_connection.consent_started",
    entityType: "bank_connection",
    entityId: updated.id,
    actorPersonId: input.actor?.personId ?? null,
    actorUserId: input.actor?.userId ?? null,
    requestId: input.actor?.requestId ?? null,
    after: { aspsp, scopes, reauthorize: Boolean(input.reauthorize) },
    source: "f2",
  });

  return {
    connectionId: updated.id,
    authorizationUrl: auth.url,
    authorizationId: auth.authorizationId,
    scopes,
    reauthorize: Boolean(input.reauthorize),
  };
}

export async function startBankReauthorization(
  deps: KernelDeps,
  input: {
    tenantId: string;
    connectionId?: string | null;
    authorizedByMembershipId?: string | null;
    actor?: Actor;
  },
) {
  const row = await loadTenantConnection(deps, input.tenantId, input.connectionId);
  if (row.consentStatus === BANK_CONSENT_STATUS.revoked) {
    throw new DomainError(
      "bank_connection_revoked",
      "BankConnection revogada — inicia nova autorização",
      409,
    );
  }
  return startBankConsent(deps, {
    tenantId: input.tenantId,
    aspsp: row.aspsp,
    accountIban: row.accountIban,
    authorizedByMembershipId: input.authorizedByMembershipId ?? row.authorizedByMembershipId,
    scopes: parseConsentScopesJson(row.consentScopes),
    reauthorize: true,
    actor: input.actor,
  });
}

export async function completeBankConsent(
  deps: KernelDeps,
  input: { code?: string | null; state?: string | null; error?: string | null },
) {
  const parsed = decodeConsentState(input.state);
  if (input.error) {
    const lastError = sanitizeBankError(input.error);
    if (parsed) {
      await upsertBankConnection(deps, {
        tenantId: parsed.tenantId,
        lastError,
        consentStatus: BANK_CONSENT_STATUS.reauthorizationRequired,
      });
    }
    throw new DomainError("bank_consent_denied", lastError, 400);
  }
  if (!input.code?.trim()) {
    throw new DomainError("bank_consent_no_code", "callback sem code", 400);
  }
  if (!parsed) {
    throw new DomainError("bank_consent_invalid_state", "state de consentimento inválido", 400);
  }
  if (deps.getTenantId() && parsed.tenantId !== deps.getTenantId()) {
    throw new DomainError("bank_consent_tenant_mismatch", "state não pertence a este tenant", 403);
  }

  const [row] = await deps.db
    .select()
    .from(condoBankConnections)
    .where(
      and(
        eq(condoBankConnections.tenantId, parsed.tenantId),
        eq(condoBankConnections.id, parsed.connectionId),
      ),
    )
    .limit(1);
  if (!row || row.authState !== input.state) {
    throw new DomainError("bank_consent_invalid_state", "state de consentimento não reconhecido", 400);
  }

  const preferredIban = normalizeIBAN(row.accountIban);
  if (!preferredIban) {
    const err = new DomainError(
      "bank_account_iban_required",
      "BankConnection sem IBAN do condomínio — recusa fail-closed (ADR-014)",
      400,
    );
    await upsertBankConnection(deps, {
      tenantId: parsed.tenantId,
      lastError: sanitizeBankError(err),
      consentStatus: BANK_CONSENT_STATUS.reauthorizationRequired,
    });
    throw err;
  }

  const client = requireConfiguredClient(deps);
  try {
    const session = await client.exchangeCode(input.code.trim());
    const account = pickCondoAccount(session.accounts, preferredIban);
    if (!account) {
      throw new DomainError(
        "bank_account_iban_mismatch",
        "Nenhuma conta ASPSP corresponde ao IBAN do condomínio",
        400,
      );
    }
    const validUntil = session.accessValidUntil
      ? new Date(session.accessValidUntil)
      : defaultConsentValidUntil(kernelNow(deps));
    const updated = await upsertBankConnection(deps, {
      tenantId: parsed.tenantId,
      aspsp: row.aspsp,
      accountIban: preferredIban,
      consentStatus: BANK_CONSENT_STATUS.authorized,
      consentValidUntil: validUntil,
      sessionId: session.sessionId,
      accountUid: account.uid,
      accountsJson: JSON.stringify(session.accounts),
      authState: null,
      lastError: null,
    });
    await createAuditEventRepo(deps.db).append({
      tenantId: parsed.tenantId,
      type: "bank_connection.consent_authorized",
      entityType: "bank_connection",
      entityId: updated.id,
      after: {
        aspsp: updated.aspsp,
        accountIban: updated.accountIban,
        consentStatus: updated.consentStatus,
        consentValidUntil: validUntil.toISOString(),
      },
      source: "f2",
    });
    await createDomainEventRepo(deps.db).append({
      tenantId: parsed.tenantId,
      type: "BankConnectionAuthorized",
      aggregateType: "bank_connection",
      aggregateId: updated.id,
      payload: { aspsp: updated.aspsp, accountUid: account.uid },
    });
    return updated;
  } catch (err) {
    const lastError = sanitizeBankError(err);
    await upsertBankConnection(deps, {
      tenantId: parsed.tenantId,
      lastError,
      consentStatus: BANK_CONSENT_STATUS.reauthorizationRequired,
    });
    if (err instanceof DomainError) throw err;
    throw new DomainError("bank_consent_exchange_failed", lastError, 502);
  }
}

export async function revokeBankConnection(
  deps: KernelDeps,
  input: { tenantId: string; connectionId?: string | null; actor?: Actor },
) {
  const row = await loadTenantConnection(deps, input.tenantId, input.connectionId);
  const client = enableBankingClient(deps);
  if (row.sessionId && client.revokeSession) {
    await client.revokeSession(row.sessionId);
  }
  const updated = await upsertBankConnection(deps, {
    tenantId: input.tenantId,
    consentStatus: BANK_CONSENT_STATUS.revoked,
    sessionId: null,
    accountUid: null,
    authState: null,
    lastError: null,
    actor: input.actor,
  });
  await createAuditEventRepo(deps.db).append({
    tenantId: input.tenantId,
    type: "bank_connection.revoked",
    entityType: "bank_connection",
    entityId: updated.id,
    actorPersonId: input.actor?.personId ?? null,
    actorUserId: input.actor?.userId ?? null,
    requestId: input.actor?.requestId ?? null,
    source: "f2",
  });
  return updated;
}

export async function syncBankConnection(
  deps: KernelDeps,
  input: {
    tenantId: string;
    connectionId?: string | null;
    dateFrom?: Date | string | null;
    dateTo?: Date | string | null;
    actor?: Actor;
  },
) {
  const now = kernelNow(deps);
  const row = await loadTenantConnection(deps, input.tenantId, input.connectionId);

  if (row.consentStatus === BANK_CONSENT_STATUS.revoked || row.revokedAt) {
    const lastError = "bank_connection_revoked; use CSV fallback";
    await upsertBankConnection(deps, { tenantId: input.tenantId, lastError });
    return {
      skipped: true as const,
      reason: "revoked",
      fallback: "csv" as const,
      lastError,
      created: 0,
      reused: 0,
      debits: 0,
      credits: 0,
    };
  }

  if (
    !row.sessionId ||
    !row.accountUid ||
    consentHasExpired(row.consentValidUntil, now) ||
    row.consentStatus === BANK_CONSENT_STATUS.expired
  ) {
    const lastError = "reauthorization_required; use CSV fallback";
    await upsertBankConnection(deps, {
      tenantId: input.tenantId,
      lastError,
      consentStatus:
        consentHasExpired(row.consentValidUntil, now)
          ? BANK_CONSENT_STATUS.expired
          : BANK_CONSENT_STATUS.reauthorizationRequired,
    });
    return {
      skipped: true as const,
      reason: "reauthorization_required",
      fallback: "csv" as const,
      lastError,
      created: 0,
      reused: 0,
      debits: 0,
      credits: 0,
    };
  }

  const client = requireConfiguredClient(deps);
  const ownIbans = condoOwnIbans(row);
  const dateTo = input.dateTo ? new Date(input.dateTo) : now;
  const dateFrom = input.dateFrom
    ? new Date(input.dateFrom)
    : row.lastSyncAt
      ? new Date(row.lastSyncAt)
      : new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
  const chunks = splitSyncDateChunks(dateFrom, dateTo, { now });
  const transactions: EnableBankingTransaction[] = [];
  const syncErrors: string[] = [];

  for (const chunk of chunks) {
    try {
      const page = await client.listTransactions({
        accountUid: row.accountUid,
        dateFrom: chunk.from,
        dateTo: chunk.to,
        ownIbans,
      });
      transactions.push(...page.map((tx) => withoutOwnCounterparty(tx, ownIbans)));
    } catch (err) {
      syncErrors.push(sanitizeBankError(err));
    }
  }

  const authFailed = syncErrors.some(isAuthProviderError);
  const totalFail = transactions.length === 0 && syncErrors.length >= chunks.length && chunks.length > 0;

  if (totalFail) {
    const lastError = syncErrors[0] ?? "enable_banking_sync_failed";
    await upsertBankConnection(deps, {
      tenantId: input.tenantId,
      lastError,
      consentStatus: authFailed
        ? BANK_CONSENT_STATUS.reauthorizationRequired
        : row.consentStatus,
    });
    if (authFailed) {
      return {
        skipped: true as const,
        reason: "provider_auth_failed",
        fallback: "csv" as const,
        lastError,
        created: 0,
        reused: 0,
        debits: 0,
        credits: 0,
      };
    }
    throw new DomainError("bank_sync_failed", lastError, 502);
  }

  let created = 0;
  let reused = 0;
  let credits = 0;
  let debits = 0;
  const seenRefs = new Set<string>();
  for (const tx of transactions) {
    const ref = movementExternalRef(row.id, tx);
    if (seenRefs.has(ref)) continue;
    seenRefs.add(ref);
    const applied = await applySyncedTransaction(deps, {
      tenantId: input.tenantId,
      connectionId: row.id,
      tx,
      actor: input.actor,
    });
    if (applied.kind === "credit") credits += 1;
    else debits += 1;
    if (applied.created) created += 1;
    else reused += 1;
  }

  const lastError = syncErrors[0] ?? null;
  await upsertBankConnection(deps, {
    tenantId: input.tenantId,
    lastSyncAt: now,
    lastError,
    consentStatus: row.consentStatus,
    consentValidUntil: row.consentValidUntil,
  });

  await createAuditEventRepo(deps.db).append({
    tenantId: input.tenantId,
    type: "bank_connection.synced",
    entityType: "bank_connection",
    entityId: row.id,
    actorPersonId: input.actor?.personId ?? null,
    actorUserId: input.actor?.userId ?? null,
    requestId: input.actor?.requestId ?? null,
    after: { created, reused, credits, debits, errors: syncErrors.length },
    source: "f2",
  });

  return {
    skipped: false as const,
    fallback: null,
    lastError,
    created,
    reused,
    credits,
    debits,
    period: {
      from: chunks[0]?.from ?? dateFrom.toISOString().slice(0, 10),
      to: chunks[chunks.length - 1]?.to ?? dateTo.toISOString().slice(0, 10),
    },
  };
}

export async function enqueueBankSyncJob(
  deps: KernelDeps,
  input: {
    tenantId: string;
    connectionId?: string | null;
    correlationId?: string | null;
    dateFrom?: string | null;
    dateTo?: string | null;
  },
) {
  const now = kernelNow(deps);
  const row = await loadTenantConnection(deps, input.tenantId, input.connectionId);
  const day = now.toISOString().slice(0, 10);
  return createOutboxRepo(deps.db).enqueue({
    tenantId: input.tenantId,
    jobType: OUTBOX_JOB_TYPES.bankSync,
    idempotencyKey: `f2:bank-sync:${input.tenantId}:${row.id}:${day}`,
    payload: {
      connectionId: row.id,
      dateFrom: input.dateFrom ?? null,
      dateTo: input.dateTo ?? null,
    },
    correlationId: input.correlationId ?? null,
    availableAt: now,
  });
}

export async function enqueueAuthorizedBankSyncJobs(
  deps: KernelDeps,
  input: { tenantId: string; correlationId?: string | null },
) {
  const rows = await listBankConnections(deps, input.tenantId);
  const enqueued = [];
  for (const row of rows) {
    if (row.consentStatus !== BANK_CONSENT_STATUS.authorized) continue;
    if (!row.sessionId || !row.accountUid) continue;
    if (consentHasExpired(row.consentValidUntil, kernelNow(deps))) continue;
    enqueued.push(
      await enqueueBankSyncJob(deps, {
        tenantId: input.tenantId,
        connectionId: row.id,
        correlationId: input.correlationId,
      }),
    );
  }
  return enqueued;
}
