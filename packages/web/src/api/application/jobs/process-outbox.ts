import { and, eq } from "drizzle-orm";
import { portalAdminContacts } from "../../database/schema";
import { DOMAIN_EVENT_TYPES } from "../../domain/domain-event";
import { OUTBOX_JOB_TYPES, type OutboxJob } from "../../domain/outbox";
import { ADMIN_CONTACT_STATUSES } from "../../domain/ticket";
import type { KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { createContentUploadRepo } from "../../infra/repos/content-upload-repo";
import { createNotificationDeliveryRepo } from "../../infra/repos/notification-delivery-repo";
import { createOutboxRepo } from "../../infra/repos/outbox-repo";
import {
  BANK_REAUTH_ADMIN_FALLBACK,
  isResolvedAdminMailbox,
  looksLikeEmail,
  resolveFinanceManagerEmails,
} from "../finance/f2-bank-connection";
import {
  isInvitationNotifyJob,
  redactInvitationOutboxPayload,
} from "../invitation/invitation-secrets";
import {
  isAdminContactNotifyJob,
  redactAdminContactOutboxPayload,
} from "../portal/f3-contact-admin";

export type OutboxHandler = (job: OutboxJob, deps: KernelDeps) => Promise<void>;

async function handleNotifyMembershipCreated(job: OutboxJob, deps: KernelDeps): Promise<void> {
  const repo = createNotificationDeliveryRepo(deps.db);
  const existing = await repo.findByIdempotency(job.tenantId, job.idempotencyKey);
  if (existing) return;

  const destination = String(job.payload.email ?? "").trim() || "unknown@invalid";
  // F0: record attempt + observability. Does NOT claim inbox delivery (ADR-035).
  await repo.insert({
    tenantId: job.tenantId,
    channel: "email",
    destination,
    template: "membership_created",
    status: "attempted",
    providerMessageId: `local-${job.id}`,
    idempotencyKey: job.idempotencyKey,
  });

  const audit = createAuditEventRepo(deps.db);
  await audit.append({
    tenantId: job.tenantId,
    type: "notification.email.attempted",
    entityType: "notification_delivery",
    entityId: job.idempotencyKey,
    payload: {
      destination,
      template: "membership_created",
      jobId: job.id,
    },
    reason: "outbox_notify_membership_created",
    source: "outbox",
    requestId: job.correlationId,
  });
}

async function handlePersistReuniaoAudit(job: OutboxJob, deps: KernelDeps): Promise<void> {
  const audit = createAuditEventRepo(deps.db);
  const existing = await audit.listByEntity("reuniao", String(job.payload.entityId ?? ""));
  const already = existing.some(
    (e) =>
      e.type === String(job.payload.type ?? "") &&
      e.requestId === job.idempotencyKey,
  );
  if (already) return;

  await audit.append({
    tenantId: job.tenantId,
    type: String(job.payload.type ?? "reuniao.unknown"),
    entityType: "reuniao",
    entityId: String(job.payload.entityId ?? ""),
    actorUserId: (job.payload.actorUserId as string | null | undefined) ?? null,
    payload: (job.payload.payload as Record<string, unknown> | null | undefined) ?? null,
    source: "outbox",
    requestId: job.idempotencyKey,
    reason: "reuniao_audit_persist",
  });
}

async function handleRegisterUpload(job: OutboxJob, deps: KernelDeps): Promise<void> {
  const repo = createContentUploadRepo(deps.db);
  const hash = String(job.payload.contentHash ?? "");
  if (!hash) throw new Error("contentHash required");
  const existing = await repo.findByHash(job.tenantId, hash);
  if (existing) return;
  await repo.insert({
    id: crypto.randomUUID(),
    tenantId: job.tenantId,
    contentHash: hash,
    filename: String(job.payload.filename ?? "unknown"),
    byteSize: Number(job.payload.byteSize ?? 0),
    createdAt: new Date(),
  });
}

async function handleBankReauthNotice(job: OutboxJob, deps: KernelDeps): Promise<void> {
  const repo = createNotificationDeliveryRepo(deps.db);
  const existing = await repo.findByIdempotency(job.tenantId, job.idempotencyKey);
  if (existing) return;

  const liveEmails = await resolveFinanceManagerEmails(deps, job.tenantId);
  const payloadEmails = Array.isArray(job.payload.notifyEmails)
    ? job.payload.notifyEmails.map((e) => String(e ?? "").trim()).filter(isResolvedAdminMailbox)
    : [];
  // Never promote BANK_REAUTH_ADMIN_FALLBACK via payloadAdmin / looksLikeEmail.
  const payloadAdmin =
    typeof job.payload.adminEmail === "string" && isResolvedAdminMailbox(job.payload.adminEmail)
      ? [job.payload.adminEmail.trim()]
      : [];
  const notifyEmails = liveEmails.length > 0 ? liveEmails : [...payloadEmails, ...payloadAdmin];
  let destination = notifyEmails[0] ?? BANK_REAUTH_ADMIN_FALLBACK;
  if (!looksLikeEmail(destination) || !isResolvedAdminMailbox(destination)) {
    destination = BANK_REAUTH_ADMIN_FALLBACK;
  }

  const iban = String(job.payload.accountIban ?? "").trim().replace(/\s/g, "");
  if (iban && destination.replace(/\s/g, "").toUpperCase() === iban.toUpperCase()) {
    destination = BANK_REAUTH_ADMIN_FALLBACK;
  }

  // Deliverable only when destination is a real manager email, never the fallback.
  const hasMailbox = isResolvedAdminMailbox(destination);
  await repo.insert({
    tenantId: job.tenantId,
    channel: "email",
    destination,
    template: "bank_reauth_required",
    status: hasMailbox ? "attempted" : "skipped",
    providerMessageId: `local-${job.id}`,
    idempotencyKey: job.idempotencyKey,
  });

  await createAuditEventRepo(deps.db).append({
    tenantId: job.tenantId,
    type: hasMailbox ? "notification.email.attempted" : "notification.email.skipped",
    entityType: "notification_delivery",
    entityId: job.idempotencyKey,
    payload: {
      destination,
      notifyEmails,
      template: "bank_reauth_required",
      jobId: job.id,
      connectionId: job.payload.connectionId ?? null,
      accountIban: job.payload.accountIban ?? null,
    },
    reason: hasMailbox ? "outbox_bank_reauth_notice" : "outbox_bank_reauth_notice_no_manager_email",
    source: "outbox",
    requestId: job.correlationId,
  });
}

async function handleIssueReceipt(job: OutboxJob, deps: KernelDeps): Promise<void> {
  const paymentId = String(job.payload.paymentId ?? "");
  if (!paymentId) throw new Error("paymentId required");
  const { issueReceiptForPayment } = await import("../finance/f2-finance");
  await issueReceiptForPayment(deps, {
    tenantId: job.tenantId,
    paymentId,
    actor: { requestId: job.correlationId },
  });
}

async function handleMonthlyPaymentNotices(job: OutboxJob, deps: KernelDeps): Promise<void> {
  const { generateMonthlyPaymentNotices } = await import("../finance/f2-jobs");
  await generateMonthlyPaymentNotices(deps, {
    tenantId: job.tenantId,
    actor: { requestId: job.correlationId },
    force: true,
  });
}

async function handleSweepReceipts(job: OutboxJob, deps: KernelDeps): Promise<void> {
  const { sweepReceiptsForAllocatedPayments } = await import("../finance/f2-jobs");
  await sweepReceiptsForAllocatedPayments(deps, {
    tenantId: job.tenantId,
    actor: { requestId: job.correlationId },
  });
}

async function handleNotifyInvitation(
  job: OutboxJob,
  deps: KernelDeps,
  template: "invitation_created" | "invitation_verify",
  reason: string,
): Promise<void> {
  const repo = createNotificationDeliveryRepo(deps.db);
  const existing = await repo.findByIdempotency(job.tenantId, job.idempotencyKey);
  if (existing) return;

  const destination = String(job.payload.destination ?? "").trim() || "unknown@invalid";
  await repo.insert({
    tenantId: job.tenantId,
    channel: String(job.payload.canal ?? "email"),
    destination,
    template,
    status: "attempted",
    providerMessageId: `local-${job.id}`,
    idempotencyKey: job.idempotencyKey,
  });

  await createAuditEventRepo(deps.db).append({
    tenantId: job.tenantId,
    type: "notification.email.attempted",
    entityType: "notification_delivery",
    entityId: job.idempotencyKey,
    payload: {
      destination,
      template,
      jobId: job.id,
      invitationId: job.payload.invitationId ?? null,
    },
    reason,
    source: "outbox",
    requestId: job.correlationId,
  });
}

async function handleNotifyAdminMailbox(
  job: OutboxJob,
  deps: KernelDeps,
  template: string,
  reason: string,
): Promise<{ destination: string; hasMailbox: boolean }> {
  const repo = createNotificationDeliveryRepo(deps.db);
  const existing = await repo.findByIdempotency(job.tenantId, job.idempotencyKey);
  if (existing) {
    return {
      destination: existing.destination,
      hasMailbox: existing.status === "attempted",
    };
  }

  const liveEmails = await resolveFinanceManagerEmails(deps, job.tenantId);
  const payloadEmails = Array.isArray(job.payload.notifyEmails)
    ? job.payload.notifyEmails.map((e) => String(e ?? "").trim()).filter(isResolvedAdminMailbox)
    : [];
  const notifyEmails = liveEmails.length > 0 ? liveEmails : payloadEmails;
  let destination = notifyEmails[0] ?? BANK_REAUTH_ADMIN_FALLBACK;
  if (!looksLikeEmail(destination) || !isResolvedAdminMailbox(destination)) {
    destination = BANK_REAUTH_ADMIN_FALLBACK;
  }
  const hasMailbox = isResolvedAdminMailbox(destination);

  await repo.insert({
    tenantId: job.tenantId,
    channel: "email",
    destination,
    template,
    status: hasMailbox ? "attempted" : "skipped",
    providerMessageId: `local-${job.id}`,
    idempotencyKey: job.idempotencyKey,
  });

  await createAuditEventRepo(deps.db).append({
    tenantId: job.tenantId,
    type: hasMailbox ? "notification.email.attempted" : "notification.email.skipped",
    entityType: "notification_delivery",
    entityId: job.idempotencyKey,
    payload: {
      destination,
      notifyEmails,
      template,
      jobId: job.id,
      ticketId: job.payload.ticketId ?? null,
      contactId: job.payload.contactId ?? null,
    },
    reason,
    source: "outbox",
    requestId: job.correlationId,
  });

  return { destination, hasMailbox };
}

async function handleNotifyTicketCreated(job: OutboxJob, deps: KernelDeps): Promise<void> {
  await handleNotifyAdminMailbox(
    job,
    deps,
    "ticket_created",
    "outbox_notify_ticket_created",
  );
}

async function handleNotifyAdminContact(job: OutboxJob, deps: KernelDeps): Promise<void> {
  const { hasMailbox } = await handleNotifyAdminMailbox(
    job,
    deps,
    "admin_contact",
    "outbox_notify_admin_contact",
  );
  const contactId = String(job.payload.contactId ?? "").trim();
  if (!contactId) return;
  await deps.db
    .update(portalAdminContacts)
    .set({
      status: hasMailbox ? ADMIN_CONTACT_STATUSES.attempted : ADMIN_CONTACT_STATUSES.skipped,
    })
    .where(
      and(eq(portalAdminContacts.id, contactId), eq(portalAdminContacts.tenantId, job.tenantId)),
    );
}

async function handleBankSync(job: OutboxJob, deps: KernelDeps): Promise<void> {
  const { syncBankConnection } = await import("../finance/f2-bank-sync");
  await syncBankConnection(deps, {
    tenantId: job.tenantId,
    connectionId: typeof job.payload.connectionId === "string" ? job.payload.connectionId : null,
    dateFrom: typeof job.payload.dateFrom === "string" ? job.payload.dateFrom : null,
    dateTo: typeof job.payload.dateTo === "string" ? job.payload.dateTo : null,
    actor: { requestId: job.correlationId },
  });
}

const HANDLERS: Record<string, OutboxHandler> = {
  [OUTBOX_JOB_TYPES.notifyMembershipCreated]: handleNotifyMembershipCreated,
  [OUTBOX_JOB_TYPES.persistReuniaoAudit]: handlePersistReuniaoAudit,
  [OUTBOX_JOB_TYPES.registerUpload]: handleRegisterUpload,
  [OUTBOX_JOB_TYPES.bankReauthNotice]: handleBankReauthNotice,
  [OUTBOX_JOB_TYPES.issueReceipt]: handleIssueReceipt,
  [OUTBOX_JOB_TYPES.generateMonthlyPaymentNotices]: handleMonthlyPaymentNotices,
  [OUTBOX_JOB_TYPES.sweepReceipts]: handleSweepReceipts,
  [OUTBOX_JOB_TYPES.bankSync]: handleBankSync,
  [OUTBOX_JOB_TYPES.notifyInvitationCreated]: (job, deps) =>
    handleNotifyInvitation(job, deps, "invitation_created", "outbox_notify_invitation_created"),
  [OUTBOX_JOB_TYPES.notifyInvitationVerify]: (job, deps) =>
    handleNotifyInvitation(job, deps, "invitation_verify", "outbox_notify_invitation_verify"),
  [OUTBOX_JOB_TYPES.notifyTicketCreated]: handleNotifyTicketCreated,
  [OUTBOX_JOB_TYPES.notifyAdminContact]: handleNotifyAdminContact,
};

export function backoffMs(attempts: number): number {
  return Math.min(60_000, 500 * 2 ** Math.max(0, attempts - 1));
}

export async function processOutbox(
  deps: KernelDeps,
  opts?: { limit?: number; now?: Date },
): Promise<{ processed: number; completed: number; failed: number; retried: number }> {
  const repo = createOutboxRepo(deps.db);
  const now = opts?.now ?? (deps.now ? deps.now() : new Date());
  const claimed = await repo.claimPending(opts?.limit ?? 20, now);
  let completed = 0;
  let failed = 0;
  let retried = 0;

  for (const job of claimed) {
    const handler = HANDLERS[job.jobType];
    if (!handler) {
      await repo.markFailed(job.id, `unknown_job_type:${job.jobType}`, { retry: false });
      failed++;
      continue;
    }
    try {
      await handler(job, deps);
      const redactedPayload = isInvitationNotifyJob(job.jobType)
        ? redactInvitationOutboxPayload(job.payload)
        : isAdminContactNotifyJob(job.jobType)
          ? redactAdminContactOutboxPayload(job.payload)
          : null;
      await repo.markCompleted(
        job.id,
        now,
        redactedPayload ? { payloadJson: JSON.stringify(redactedPayload) } : undefined,
      );
      completed++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const canRetry = job.attempts < job.maxAttempts;
      if (canRetry) {
        await repo.markFailed(job.id, message, {
          retry: true,
          availableAt: new Date(now.getTime() + backoffMs(job.attempts)),
        });
        retried++;
      } else {
        await repo.markFailed(job.id, message, { retry: false });
        failed++;
      }
    }
  }

  return { processed: claimed.length, completed, failed, retried };
}

export { DOMAIN_EVENT_TYPES };
