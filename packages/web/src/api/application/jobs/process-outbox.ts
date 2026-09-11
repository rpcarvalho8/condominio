import { DOMAIN_EVENT_TYPES } from "../../domain/domain-event";
import { OUTBOX_JOB_TYPES, type OutboxJob } from "../../domain/outbox";
import type { KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { createContentUploadRepo } from "../../infra/repos/content-upload-repo";
import { createNotificationDeliveryRepo } from "../../infra/repos/notification-delivery-repo";
import { createOutboxRepo } from "../../infra/repos/outbox-repo";

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

const HANDLERS: Record<string, OutboxHandler> = {
  [OUTBOX_JOB_TYPES.notifyMembershipCreated]: handleNotifyMembershipCreated,
  [OUTBOX_JOB_TYPES.persistReuniaoAudit]: handlePersistReuniaoAudit,
  [OUTBOX_JOB_TYPES.registerUpload]: handleRegisterUpload,
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
      await repo.markCompleted(job.id, now);
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
