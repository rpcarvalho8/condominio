import { desc, eq } from "drizzle-orm";
import { domainEvents } from "../../database/schema";
import type { DomainEvent, PublishDomainEventInput } from "../../domain/domain-event";
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

function mapEvent(row: typeof domainEvents.$inferSelect): DomainEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    type: row.type,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: parseJson(row.payloadJson ?? null),
    occurredAt: row.occurredAt,
    correlationId: row.correlationId ?? null,
  };
}

export function createDomainEventRepo(db: KernelDb) {
  return {
    async append(input: PublishDomainEventInput): Promise<DomainEvent> {
      const [row] = await db
        .insert(domainEvents)
        .values({
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          type: input.type,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          payloadJson: input.payload ? JSON.stringify(input.payload) : null,
          occurredAt: input.occurredAt ?? new Date(),
          correlationId: input.correlationId ?? null,
        })
        .returning();
      return mapEvent(row!);
    },
    async listByAggregate(aggregateType: string, aggregateId: string): Promise<DomainEvent[]> {
      const rows = await db
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.aggregateId, aggregateId))
        .orderBy(desc(domainEvents.occurredAt));
      return rows.filter((r) => r.aggregateType === aggregateType).map(mapEvent);
    },
  };
}

export type DomainEventRepo = ReturnType<typeof createDomainEventRepo>;
