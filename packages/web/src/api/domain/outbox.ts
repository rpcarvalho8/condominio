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
  /** F2 — avisos de débito (calendário dia 1). */
  generateMonthlyPaymentNotices: "f2.generate_monthly_payment_notices",
  /** F2 — recibo após confirmação de Allocation. */
  issueReceipt: "f2.issue_receipt",
  /** F2 — sweep de recibos em falta. */
  sweepReceipts: "f2.sweep_receipts",
  /** F2 — aviso proactivo de reautorização bancária (coexiste com reauth PSD2 real). */
  bankReauthNotice: "notify.bank_reauth",
  /** F2 — sync Enable Banking → movimentos + Payments candidatos. */
  bankSync: "f2.bank_sync",
  /** F3 — envio do convite (estado observável; sem fire-and-forget). */
  notifyInvitationCreated: "notify.invitation_created",
  /** F3 — código/link de verificação de contacto (não KYC). */
  notifyInvitationVerify: "notify.invitation_verify",
  /** F3 — aviso ao admin de ticket criado no portal. */
  notifyTicketCreated: "notify.ticket_created",
  /** F3 — mensagem «contactar admin» (email primário; estado observável). */
  notifyAdminContact: "notify.admin_contact",
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
