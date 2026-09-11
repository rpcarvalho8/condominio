import { db } from "../database";
import { getCurrentTenantId } from "./tenant";
import { OUTBOX_JOB_TYPES } from "../domain/outbox";
import { enqueueOutboxJob } from "../application/events/emit";
import { processOutbox } from "../application/jobs/process-outbox";
import type { KernelDeps } from "../infra/kernel-deps";

export type ReuniaoAuditType =
  | "meeting_opened"
  | "recording_segment_started"
  | "recording_segment_closed"
  | "recording_interrupted"
  | "recording_resumed"
  | "recording_upload_failed"
  | "recording_processing_started"
  | "recording_processing_failed"
  | "recording_processing_completed"
  | "meeting_ended";

/**
 * F0-C: reunião audit goes through the outbox (one migrated effect).
 * Drain runs inline so HTTP paths stay consistent without a separate worker process.
 */
export async function writeReuniaoAudit(input: {
  type: ReuniaoAuditType;
  reuniaoId: string;
  actorUserId?: string | null;
  payload?: Record<string, unknown>;
  tenantId?: string;
}): Promise<void> {
  const tenantId = input.tenantId ?? getCurrentTenantId();
  const deps: KernelDeps = { db: db as KernelDeps["db"], getTenantId: () => tenantId };
  const idempotencyKey = `reuniao-audit:${tenantId}:${input.reuniaoId}:${input.type}:${
    input.payload?.ordinal ?? input.payload?.generation ?? "0"
  }`;

  try {
    await enqueueOutboxJob(deps, {
      tenantId,
      jobType: OUTBOX_JOB_TYPES.persistReuniaoAudit,
      idempotencyKey,
      payload: {
        type: input.type,
        entityId: input.reuniaoId,
        actorUserId: input.actorUserId ?? null,
        payload: input.payload ?? null,
      },
    });
    await processOutbox(deps);
  } catch (e) {
    // Auditoria nunca deve derrubar o fluxo de negócio; logar e continuar.
    console.error("[audit] falha ao enfileirar/processar evento", input.type, e);
  }
}
