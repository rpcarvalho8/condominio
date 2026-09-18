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

/** Who acted — Person of an active Membership (human) or a documented system job. */
export type AuditActor = {
  personId?: string | null;
  userId?: string | null;
  requestId?: string | null;
  source?: string | null;
};

/** Human F2 HTTP / use-case mutations. */
export const AUDIT_SOURCE_F2 = "f2";

/** Fail-closed human F2 mutation: session has no Person with an active Membership. */
export const F2_ACTOR_REQUIRED_CODE = "actor_required";
export const F2_ACTOR_REQUIRED_MESSAGE =
  "Mutação humana F2 exige Person da Membership activa neste tenant";
/**
 * Outbox / calendar / ASPSP callback — null actor_person_id is allowed.
 * Never use this on a human HTTP mutation to skip Membership.
 */
export const AUDIT_SOURCE_F2_JOB = "f2.job";

export const AUDIT_SOURCES = {
  f2: AUDIT_SOURCE_F2,
  f2Job: AUDIT_SOURCE_F2_JOB,
} as const;

export function isSystemAuditSource(source: string | null | undefined): boolean {
  return source === AUDIT_SOURCE_F2_JOB;
}

export function systemAuditActor(requestId?: string | null): AuditActor {
  return {
    personId: null,
    userId: null,
    requestId: requestId ?? null,
    source: AUDIT_SOURCE_F2_JOB,
  };
}

export function auditActorFields(actor?: AuditActor | null) {
  return {
    actorPersonId: actor?.personId ?? null,
    actorUserId: actor?.userId ?? null,
    requestId: actor?.requestId ?? null,
    source: actor?.source?.trim() || AUDIT_SOURCE_F2,
  };
}

export const AUDIT_TYPES = {
  membershipCreated: "membership.created",
  membershipRevoked: "membership.revoked",
  invitationCreated: "invitation.created",
  invitationRevoked: "invitation.revoked",
  invitationAccepted: "invitation.accepted",
  invitationContactVerified: "invitation.contact_verified",
  portalOpened: "portal.opened",
  financialDocumentSeen: "financial_document.seen",
  ticketCreated: "ticket.created",
  adminContactCreated: "admin_contact.created",
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
