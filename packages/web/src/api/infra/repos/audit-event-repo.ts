import { desc, eq } from "drizzle-orm";
import { auditEvents } from "../../database/schema";
import type { AppendAuditEventInput, AuditEvent } from "../../domain/audit";
import type { KernelDb } from "../kernel-deps";

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return { value };
  } catch {
    return { raw };
  }
}

function mapEvent(row: typeof auditEvents.$inferSelect): AuditEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    actorUserId: row.actorUserId ?? null,
    actorPersonId: row.actorPersonId ?? null,
    payload: parseJson(row.payloadJson ?? null),
    before: parseJson(row.beforeJson ?? null),
    after: parseJson(row.afterJson ?? null),
    reason: row.reason ?? null,
    source: row.source ?? null,
    requestId: row.requestId ?? null,
    createdAt: row.createdAt,
  };
}

export function createAuditEventRepo(db: KernelDb) {
  return {
    async append(input: AppendAuditEventInput): Promise<AuditEvent> {
      const [row] = await db
        .insert(auditEvents)
        .values({
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          type: input.type,
          entityType: input.entityType,
          entityId: input.entityId,
          actorUserId: input.actorUserId ?? null,
          actorPersonId: input.actorPersonId ?? null,
          payloadJson: input.payload ? JSON.stringify(input.payload) : null,
          beforeJson: input.before ? JSON.stringify(input.before) : null,
          afterJson: input.after ? JSON.stringify(input.after) : null,
          reason: input.reason ?? null,
          source: input.source ?? null,
          requestId: input.requestId ?? null,
        })
        .returning();
      return mapEvent(row!);
    },
    async listByEntity(entityType: string, entityId: string): Promise<AuditEvent[]> {
      const rows = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, entityId))
        .orderBy(desc(auditEvents.createdAt));
      return rows.filter((r) => r.entityType === entityType).map(mapEvent);
    },
  };
}

export type AuditEventRepo = ReturnType<typeof createAuditEventRepo>;
