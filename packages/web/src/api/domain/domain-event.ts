export type DomainEvent = {
  id: string;
  tenantId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown> | null;
  occurredAt: Date;
  correlationId: string | null;
};

export const DOMAIN_EVENT_TYPES = {
  membershipCreated: "MembershipCreated",
  membershipRevoked: "MembershipRevoked",
  auditAppendRequested: "AuditAppendRequested",
  uploadRegistered: "UploadRegistered",
  invitationCreated: "InvitationCreated",
  invitationRevoked: "InvitationRevoked",
  invitationAccepted: "InvitationAccepted",
  ticketCreated: "TicketCreated",
  adminContactCreated: "AdminContactCreated",
} as const;

export type PublishDomainEventInput = {
  tenantId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown> | null;
  occurredAt?: Date;
  correlationId?: string | null;
};
