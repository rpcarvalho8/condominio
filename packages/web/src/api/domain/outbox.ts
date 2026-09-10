export const OUTBOX_STATUS = {
  pending: "pending",
  processing: "processing",
  completed: "completed",
  failed: "failed",
} as const;

export type OutboxStatus = (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS];

export const OUTBOX_JOB_TYPES = {
  /** Side-effect after membership create — observable email attempt (no inbox guarantee). */
  notifyMembershipCreated: "notify.membership_created",
  /** Persist reunião AuditEvent via job (ADR-042 / F0 migrate one effect). */
  persistReuniaoAudit: "audit.reuniao_persist",
  /** Content-addressed upload registration. */
  registerUpload: "upload.register",
} as const;

export type OutboxJob = {
  id: string;
  tenantId: string;
  jobType: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: OutboxStatus | string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: Date;
  availableAt: Date;
  processedAt: Date | null;
  correlationId: string | null;
};

export type EnqueueOutboxInput = {
  tenantId: string;
  jobType: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  correlationId?: string | null;
  availableAt?: Date;
  maxAttempts?: number;
};
