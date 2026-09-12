export type AuditEvent = {
  id: string;
  tenantId: string;
  type: string;
  entityType: string;
  entityId: string;
  actorUserId: string | null;
  actorPersonId: string | null;
  payload: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  source: string | null;
  requestId: string | null;
  createdAt: Date;
};

export const AUDIT_TYPES = {
  membershipCreated: "membership.created",
  membershipRevoked: "membership.revoked",
  invitationCreated: "invitation.created",
  invitationRevoked: "invitation.revoked",
  invitationAccepted: "invitation.accepted",
  invitationContactVerified: "invitation.contact_verified",
} as const;

export type AppendAuditEventInput = {
  tenantId: string;
  type: string;
  entityType: string;
  entityId: string;
  actorUserId?: string | null;
  actorPersonId?: string | null;
  payload?: Record<string, unknown> | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  source?: string | null;
  requestId?: string | null;
};
