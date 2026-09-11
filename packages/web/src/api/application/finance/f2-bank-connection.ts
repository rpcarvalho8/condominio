/**
 * BankConnection — ciclo de vida na conta do condomínio (ADR-014).
 * Este slice fecha o critério F2 com aviso proactivo de reautorização.
 * Sync Enable Banking / PSD2 fica para depois dos testes adversariais do kernel.
 */
import { and, eq } from "drizzle-orm";
import { condoBankConnections, memberships, persons } from "../../database/schema";
import {
  BANK_CONSENT_STATUS,
  BANK_REAUTH_LEAD_DAYS,
} from "../../domain/finance";
import { DomainError } from "../../domain/errors";
import { MEMBERSHIP_STATUS } from "../../domain/membership";
import { canManageFinance } from "../../domain/roles";
import { OUTBOX_JOB_TYPES } from "../../domain/outbox";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { createDomainEventRepo } from "../../infra/repos/domain-event-repo";
import { createOutboxRepo } from "../../infra/repos/outbox-repo";

type Actor = {
  personId?: string | null;
  userId?: string | null;
  requestId?: string | null;
};

function asConsent(value: string | undefined): string {
  const allowed = Object.values(BANK_CONSENT_STATUS) as string[];
  const v = value ?? BANK_CONSENT_STATUS.pending;
  if (!allowed.includes(v)) {
    throw new DomainError("invalid_consent_status", `consentStatus inválido: ${v}`, 400);
  }
  return v;
}

function parseUntil(value: Date | string | number | null | undefined): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function consentNeedsReauth(validUntil: Date | null, now: Date): boolean {
  if (!validUntil) return false;
  const leadMs = BANK_REAUTH_LEAD_DAYS * 24 * 60 * 60 * 1000;
  return validUntil.getTime() - now.getTime() <= leadMs;
}

function noticeKey(tenantId: string, connectionId: string, validUntil: Date | null): string {
  const until = validUntil ? validUntil.toISOString().slice(0, 10) : "none";
  return `f2:reauth:${tenantId}:${connectionId}:${until}`;
}

/**
 * Fallback explícito quando não há Membership Admin/gestor activa com email.
 * Endereço inválido de propósito — nunca um IBAN da conta do condomínio.
 */
export const BANK_REAUTH_ADMIN_FALLBACK = "admin@invalid";

export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  if (!v.includes("@") || /\s/.test(v)) return false;
  // IBAN (PTxx…) must never be treated as a mailbox.
  if (/^[A-Z]{2}\d{2}/i.test(v.replace(/\s/g, ""))) return false;
  return true;
}

/** Active Admin / PlatformAdmin emails for the tenant — never IBAN. */
export async function resolveFinanceManagerEmails(
  deps: KernelDeps,
  tenantId: string,
): Promise<string[]> {
  const rows = await deps.db
    .select({
      email: persons.email,
      roleCode: memberships.roleCode,
    })
    .from(memberships)
    .innerJoin(persons, eq(persons.id, memberships.personId))
    .where(
      and(eq(memberships.tenantId, tenantId), eq(memberships.status, MEMBERSHIP_STATUS.active)),
    );
  const emails = rows
    .filter((r) => canManageFinance(String(r.roleCode)))
    .map((r) => String(r.email ?? "").trim())
    .filter(looksLikeEmail);
  return [...new Set(emails)];
}

async function assertAuthorizedMembership(
  deps: KernelDeps,
  tenantId: string,
  membershipId: string,
) {
  const [row] = await deps.db
    .select()
    .from(memberships)
    .where(eq(memberships.id, membershipId))
    .limit(1);
  if (!row || row.tenantId !== tenantId) {
    throw new DomainError(
      "membership_not_found",
      "authorizedByMembershipId inexistente neste tenant",
      400,
    );
  }
  if (row.status !== MEMBERSHIP_STATUS.active) {
    throw new DomainError(
      "membership_inactive",
      "authorizedByMembershipId não está activo",
      403,
    );
  }
  // Gestor da conta do condomínio = Admin/PlatformAdmin. Owner de fração não autoriza (ADR-014).
  if (!canManageFinance(String(row.roleCode))) {
    throw new DomainError(
      "authorizer_role_forbidden",
      "authorizedByMembershipId exige papel de gestor (Admin/PlatformAdmin)",
      403,
    );
  }
}

export async function upsertBankConnection(
  deps: KernelDeps,
  input: {
    tenantId: string;
    provider?: string;
    aspsp?: string | null;
    accountIban?: string | null;
    consentStatus?: string;
    consentValidUntil?: Date | string | number | null;
    authorizedByMembershipId?: string | null;
    lastSyncAt?: Date | null;
    lastError?: string | null;
    actor?: Actor;
  },
) {
  const now = kernelNow(deps);
  const consentStatus = asConsent(input.consentStatus);
  const consentValidUntil = parseUntil(input.consentValidUntil);
  const needs = consentNeedsReauth(consentValidUntil, now);
  const status =
    consentStatus === BANK_CONSENT_STATUS.revoked
      ? BANK_CONSENT_STATUS.revoked
      : needs
        ? BANK_CONSENT_STATUS.reauthorizationRequired
        : consentStatus;

  const authorizedBy = input.authorizedByMembershipId?.trim() || null;
  if (authorizedBy) {
    await assertAuthorizedMembership(deps, input.tenantId, authorizedBy);
  }

  const existing = await deps.db
    .select()
    .from(condoBankConnections)
    .where(eq(condoBankConnections.tenantId, input.tenantId))
    .limit(1);

  const values = {
    provider: input.provider ?? "enable_banking",
    aspsp: input.aspsp ?? null,
    accountIban: input.accountIban ?? null,
    consentStatus: status,
    consentValidUntil,
    reauthorizationRequired: needs && consentStatus !== BANK_CONSENT_STATUS.revoked ? 1 : 0,
    authorizedByMembershipId: authorizedBy ?? existing[0]?.authorizedByMembershipId ?? null,
    lastSyncAt: input.lastSyncAt ?? existing[0]?.lastSyncAt ?? null,
    lastError: input.lastError ?? null,
    revokedAt: consentStatus === BANK_CONSENT_STATUS.revoked ? now : null,
    updatedAt: now,
  };

  let row;
  if (existing[0]) {
    [row] = await deps.db
      .update(condoBankConnections)
      .set(values)
      .where(eq(condoBankConnections.id, existing[0].id))
      .returning();
  } else {
    [row] = await deps.db
      .insert(condoBankConnections)
      .values({
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        createdAt: now,
        lastReauthNoticeAt: null,
        ...values,
      })
      .returning();
  }

  await createAuditEventRepo(deps.db).append({
    tenantId: input.tenantId,
    type: "bank_connection.upserted",
    entityType: "bank_connection",
    entityId: row!.id,
    actorPersonId: input.actor?.personId ?? null,
    actorUserId: input.actor?.userId ?? null,
    requestId: input.actor?.requestId ?? null,
    after: {
      accountIban: row!.accountIban,
      consentStatus: row!.consentStatus,
      reauthorizationRequired: row!.reauthorizationRequired,
    },
    source: "f2",
  });

  return row!;
}

export async function listBankConnections(deps: KernelDeps, tenantId: string) {
  return deps.db
    .select()
    .from(condoBankConnections)
    .where(eq(condoBankConnections.tenantId, tenantId));
}

async function issueReauthNotice(
  deps: KernelDeps,
  input: {
    tenantId: string;
    connection: typeof condoBankConnections.$inferSelect;
    actor?: Actor;
  },
) {
  const now = kernelNow(deps);
  const notifyEmails = await resolveFinanceManagerEmails(deps, input.tenantId);
  const key = noticeKey(input.tenantId, input.connection.id, input.connection.consentValidUntil);
  const outbox = await createOutboxRepo(deps.db).enqueue({
    tenantId: input.tenantId,
    jobType: OUTBOX_JOB_TYPES.bankReauthNotice,
    idempotencyKey: key,
    payload: {
      connectionId: input.connection.id,
      accountIban: input.connection.accountIban,
      adminEmail: notifyEmails[0] ?? BANK_REAUTH_ADMIN_FALLBACK,
      notifyEmails,
      authorizedByMembershipId: input.connection.authorizedByMembershipId,
      consentValidUntil: input.connection.consentValidUntil?.toISOString() ?? null,
      leadDays: BANK_REAUTH_LEAD_DAYS,
    },
    correlationId: input.actor?.requestId ?? null,
    availableAt: now,
  });

  if (outbox.created) {
    await deps.db
      .update(condoBankConnections)
      .set({
        reauthorizationRequired: 1,
        consentStatus: BANK_CONSENT_STATUS.reauthorizationRequired,
        lastReauthNoticeAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(condoBankConnections.id, input.connection.id),
          eq(condoBankConnections.tenantId, input.tenantId),
        ),
      );

    await createAuditEventRepo(deps.db).append({
      tenantId: input.tenantId,
      type: "bank_connection.reauthorization_notice",
      entityType: "bank_connection",
      entityId: input.connection.id,
      actorPersonId: input.actor?.personId ?? null,
      actorUserId: input.actor?.userId ?? null,
      requestId: input.actor?.requestId ?? null,
      after: {
        consentValidUntil: input.connection.consentValidUntil?.toISOString() ?? null,
        leadDays: BANK_REAUTH_LEAD_DAYS,
      },
      reason: "aviso proactivo de reautorização (critério F2; sync PSD2 posterior)",
      source: "f2",
    });

    await createDomainEventRepo(deps.db).append({
      tenantId: input.tenantId,
      type: "BankReauthorizationRequired",
      aggregateType: "bank_connection",
      aggregateId: input.connection.id,
      payload: {
        consentValidUntil: input.connection.consentValidUntil?.toISOString() ?? null,
      },
      correlationId: input.actor?.requestId ?? null,
    });
  }

  return { connectionId: input.connection.id, noticed: outbox.created, idempotencyKey: key };
}

/**
 * Sweep: ligações com consentimento a expirar (ou já expirado) → aviso proactivo.
 * Não sincroniza movimentos bancários.
 */
export async function sweepBankReauthNotices(
  deps: KernelDeps,
  input: { tenantId: string; actor?: Actor },
) {
  const now = kernelNow(deps);
  const rows = await listBankConnections(deps, input.tenantId);
  const noticed = [];
  const skipped = [];
  for (const row of rows) {
    if (row.consentStatus === BANK_CONSENT_STATUS.revoked || row.revokedAt) {
      skipped.push({ id: row.id, reason: "revoked" });
      continue;
    }
    if (!consentNeedsReauth(row.consentValidUntil, now)) {
      skipped.push({ id: row.id, reason: "not_due" });
      continue;
    }
    noticed.push(await issueReauthNotice(deps, { tenantId: input.tenantId, connection: row, actor: input.actor }));
  }
  return { noticed, skipped, leadDays: BANK_REAUTH_LEAD_DAYS };
}
