import { DomainError } from "../../domain/errors";
import type { ContentUpload } from "../../domain/upload";
import { DOMAIN_EVENT_TYPES } from "../../domain/domain-event";
import { OUTBOX_JOB_TYPES } from "../../domain/outbox";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createContentUploadRepo } from "../../infra/repos/content-upload-repo";
import { emitAndEnqueue } from "../events/emit";

export type RegisterContentUploadResult = {
  upload: ContentUpload;
  created: boolean;
};

/**
 * F0 property 5 — repeated content hash does not create a second row / corrupt state.
 */
export async function registerContentUpload(
  deps: KernelDeps,
  input: {
    tenantId: string;
    contentHash: string;
    filename: string;
    byteSize: number;
    correlationId?: string | null;
  },
): Promise<RegisterContentUploadResult> {
  const tenantId = input.tenantId.trim();
  const contentHash = input.contentHash.trim().toLowerCase();
  if (!tenantId) throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new DomainError("invalid_hash", "contentHash deve ser sha256 hex", 400);
  }

  const repo = createContentUploadRepo(deps.db);
  const existing = await repo.findByHash(tenantId, contentHash);
  if (existing) {
    return { upload: existing, created: false };
  }

  const now = kernelNow(deps);
  const upload = await repo.insert({
    id: crypto.randomUUID(),
    tenantId,
    contentHash,
    filename: input.filename.trim() || "upload.bin",
    byteSize: Math.max(0, Math.floor(input.byteSize)),
    createdAt: now,
  });

  await emitAndEnqueue(
    deps,
    {
      tenantId,
      type: DOMAIN_EVENT_TYPES.uploadRegistered,
      aggregateType: "content_upload",
      aggregateId: upload.id,
      payload: { contentHash, filename: upload.filename },
      correlationId: input.correlationId ?? null,
    },
    {
      tenantId,
      jobType: OUTBOX_JOB_TYPES.registerUpload,
      idempotencyKey: `upload:${tenantId}:${contentHash}`,
      payload: {
        contentHash,
        filename: upload.filename,
        byteSize: upload.byteSize,
      },
      correlationId: input.correlationId ?? null,
    },
    { drain: true },
  );

  return { upload, created: true };
}
