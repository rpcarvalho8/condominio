import { DOMAIN_EVENT_TYPES, type PublishDomainEventInput } from "../../domain/domain-event";
import { OUTBOX_JOB_TYPES, type EnqueueOutboxInput } from "../../domain/outbox";
import type { KernelDeps } from "../../infra/kernel-deps";
import { createDomainEventRepo } from "../../infra/repos/domain-event-repo";
import { createOutboxRepo } from "../../infra/repos/outbox-repo";
import { processOutbox } from "../jobs/process-outbox";

export async function publishDomainEvent(
  deps: KernelDeps,
  input: PublishDomainEventInput,
) {
  return createDomainEventRepo(deps.db).append(input);
}

export async function enqueueOutboxJob(deps: KernelDeps, input: EnqueueOutboxInput) {
  return createOutboxRepo(deps.db).enqueue(input);
}

/**
 * Publish event + enqueue side-effect, then optionally drain outbox inline
 * (useful until a background worker is always running).
 */
export async function emitAndEnqueue(
  deps: KernelDeps,
  event: PublishDomainEventInput,
  job: EnqueueOutboxInput,
  opts?: { drain?: boolean },
) {
  const domainEvent = await publishDomainEvent(deps, event);
  const outbox = await enqueueOutboxJob(deps, {
    ...job,
    correlationId: job.correlationId ?? event.correlationId ?? domainEvent.id,
  });
  if (opts?.drain !== false) {
    await processOutbox(deps);
  }
  return { domainEvent, outbox };
}

export { DOMAIN_EVENT_TYPES, OUTBOX_JOB_TYPES };
