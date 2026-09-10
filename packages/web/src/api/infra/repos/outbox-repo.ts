import { and, asc, eq, lte } from "drizzle-orm";
import { outboxJobs } from "../../database/schema";
import {
  OUTBOX_STATUS,
  type EnqueueOutboxInput,
  type OutboxJob,
} from "../../domain/outbox";
import type { KernelDb } from "../kernel-deps";

function parsePayload(raw: string): Record<string, unknown> {
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

function mapJob(row: typeof outboxJobs.$inferSelect): OutboxJob {
  return {
    id: row.id,
    tenantId: row.tenantId,
    jobType: row.jobType,
    idempotencyKey: row.idempotencyKey,
    payload: parsePayload(row.payloadJson),
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt,
    availableAt: row.availableAt,
    processedAt: row.processedAt ?? null,
    correlationId: row.correlationId ?? null,
  };
}

export function createOutboxRepo(db: KernelDb) {
  return {
    async enqueue(input: EnqueueOutboxInput): Promise<{ job: OutboxJob; created: boolean }> {
      const existing = await db
        .select()
        .from(outboxJobs)
        .where(
          and(
            eq(outboxJobs.tenantId, input.tenantId),
            eq(outboxJobs.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing[0]) {
        return { job: mapJob(existing[0]), created: false };
      }
      try {
        const [row] = await db
          .insert(outboxJobs)
          .values({
            id: crypto.randomUUID(),
            tenantId: input.tenantId,
            jobType: input.jobType,
            idempotencyKey: input.idempotencyKey,
            payloadJson: JSON.stringify(input.payload),
            status: OUTBOX_STATUS.pending,
            attempts: 0,
            maxAttempts: input.maxAttempts ?? 8,
            createdAt: new Date(),
            availableAt: input.availableAt ?? new Date(),
            correlationId: input.correlationId ?? null,
          })
          .returning();
        return { job: mapJob(row!), created: true };
      } catch {
        const [race] = await db
          .select()
          .from(outboxJobs)
          .where(
            and(
              eq(outboxJobs.tenantId, input.tenantId),
              eq(outboxJobs.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (race) return { job: mapJob(race), created: false };
        throw new Error("outbox_enqueue_failed");
      }
    },
    async claimPending(limit = 20, now = new Date()): Promise<OutboxJob[]> {
      const rows = await db
        .select()
        .from(outboxJobs)
        .where(
          and(eq(outboxJobs.status, OUTBOX_STATUS.pending), lte(outboxJobs.availableAt, now)),
        )
        .orderBy(asc(outboxJobs.availableAt))
        .limit(limit);

      const claimed: OutboxJob[] = [];
      for (const row of rows) {
        const [updated] = await db
          .update(outboxJobs)
          .set({
            status: OUTBOX_STATUS.processing,
            attempts: row.attempts + 1,
          })
          .where(and(eq(outboxJobs.id, row.id), eq(outboxJobs.status, OUTBOX_STATUS.pending)))
          .returning();
        if (updated) claimed.push(mapJob(updated));
      }
      return claimed;
    },
    async markCompleted(id: string, processedAt = new Date()): Promise<void> {
      await db
        .update(outboxJobs)
        .set({
          status: OUTBOX_STATUS.completed,
          processedAt,
          lastError: null,
        })
        .where(eq(outboxJobs.id, id));
    },
    async markFailed(
      id: string,
      error: string,
      opts: { retry: boolean; availableAt?: Date },
    ): Promise<void> {
      await db
        .update(outboxJobs)
        .set({
          status: opts.retry ? OUTBOX_STATUS.pending : OUTBOX_STATUS.failed,
          lastError: error.slice(0, 2000),
          availableAt: opts.availableAt ?? new Date(),
          processedAt: opts.retry ? null : new Date(),
        })
        .where(eq(outboxJobs.id, id));
    },
    async findByIdempotency(tenantId: string, key: string): Promise<OutboxJob | null> {
      const [row] = await db
        .select()
        .from(outboxJobs)
        .where(and(eq(outboxJobs.tenantId, tenantId), eq(outboxJobs.idempotencyKey, key)))
        .limit(1);
      return row ? mapJob(row) : null;
    },
  };
}

export type OutboxRepo = ReturnType<typeof createOutboxRepo>;
