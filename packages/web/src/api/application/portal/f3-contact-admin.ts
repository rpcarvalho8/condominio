/**
 * F3 portal — contactar admin (canal mínimo, não CRM).
 * Mensagem → AuditEvent + outbox email; estado observável no portal.
 */
import { and, desc, eq } from "drizzle-orm";
import { portalAdminContacts } from "../../database/schema";
import { AUDIT_TYPES } from "../../domain/audit";
import { DOMAIN_EVENT_TYPES } from "../../domain/domain-event";
import type { Membership } from "../../domain/membership";
import { OUTBOX_JOB_TYPES } from "../../domain/outbox";
import {
  normalizeAdminContactBody,
  normalizeAdminContactSubject,
} from "../../domain/ticket";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createAuditEventRepo } from "../../infra/repos/audit-event-repo";
import { emitAndEnqueue } from "../events/emit";
import {
  assertFracaoAuthorized,
  assertPortalMembership,
  assertPortalTenant,
  type PortalActor,
} from "./f3-portal";

const SENSITIVE_ADMIN_CONTACT_KEYS = new Set(["body"]);

export function redactAdminContactOutboxPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = SENSITIVE_ADMIN_CONTACT_KEYS.has(key) ? "[REDACTED]" : value;
  }
  return out;
}

export function isAdminContactNotifyJob(jobType: string): boolean {
  return jobType === OUTBOX_JOB_TYPES.notifyAdminContact;
}

export type PortalAdminContactView = {
  id: string;
  fracaoId: string;
  subject: string;
  body: string;
  status: string;
  createdAt: string;
};

function toView(row: typeof portalAdminContacts.$inferSelect): PortalAdminContactView {
  return {
    id: row.id,
    fracaoId: row.fracaoId,
    subject: row.subject,
    body: row.body,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createPortalAdminContact(
  deps: KernelDeps,
  input: {
    tenantId: string;
    memberships: Membership[];
    actor: PortalActor;
    fracaoId?: string | null;
    subject: string;
    body: string;
  },
): Promise<PortalAdminContactView> {
  const tenantId = assertPortalTenant(input.tenantId);
  const fracaoIds = assertPortalMembership(input.memberships);
  const fracaoId = assertFracaoAuthorized(fracaoIds, input.fracaoId ?? fracaoIds[0]);
  const subject = normalizeAdminContactSubject(input.subject);
  const body = normalizeAdminContactBody(input.body);
  const now = kernelNow(deps);
  const id = crypto.randomUUID();

  const [row] = await deps.db
    .insert(portalAdminContacts)
    .values({
      id,
      tenantId,
      fracaoId,
      createdByPersonId: input.actor.personId,
      createdByUserId: input.actor.userId ?? null,
      subject,
      body,
      status: "queued",
      createdAt: now,
    })
    .returning();

  await createAuditEventRepo(deps.db).append({
    tenantId,
    type: AUDIT_TYPES.adminContactCreated,
    entityType: "admin_contact",
    entityId: id,
    actorPersonId: input.actor.personId,
    actorUserId: input.actor.userId ?? null,
    requestId: input.actor.requestId ?? null,
    after: { fracaoId, subject },
    source: "f3-portal",
    reason: "contact_admin",
  });

  await emitAndEnqueue(
    deps,
    {
      tenantId,
      type: DOMAIN_EVENT_TYPES.adminContactCreated,
      aggregateType: "admin_contact",
      aggregateId: id,
      payload: { fracaoId },
      correlationId: input.actor.requestId ?? null,
    },
    {
      tenantId,
      jobType: OUTBOX_JOB_TYPES.notifyAdminContact,
      idempotencyKey: `notify:admin_contact:${id}:created`,
      payload: {
        contactId: id,
        fracaoId,
        subject,
        body,
      },
      correlationId: input.actor.requestId ?? null,
    },
    { drain: true },
  );

  const [fresh] = await deps.db
    .select()
    .from(portalAdminContacts)
    .where(eq(portalAdminContacts.id, id))
    .limit(1);
  return toView(fresh ?? row!);
}

export async function listPortalAdminContacts(
  deps: KernelDeps,
  input: {
    tenantId: string;
    memberships: Membership[];
    actor: PortalActor;
  },
): Promise<{ contacts: PortalAdminContactView[] }> {
  const tenantId = assertPortalTenant(input.tenantId);
  assertPortalMembership(input.memberships);
  const rows = await deps.db
    .select()
    .from(portalAdminContacts)
    .where(
      and(
        eq(portalAdminContacts.tenantId, tenantId),
        eq(portalAdminContacts.createdByPersonId, input.actor.personId),
      ),
    )
    .orderBy(desc(portalAdminContacts.createdAt));
  return { contacts: rows.map(toView) };
}
