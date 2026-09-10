import { and, eq } from "drizzle-orm";
import { notificationDeliveries } from "../../database/schema";
import type { KernelDb } from "../kernel-deps";

export type NotificationDelivery = {
  id: string;
  tenantId: string;
  channel: string;
  destination: string;
  template: string;
  status: string;
  providerMessageId: string | null;
  idempotencyKey: string;
  error: string | null;
  createdAt: Date;
};

export function createNotificationDeliveryRepo(db: KernelDb) {
  return {
    async findByIdempotency(
      tenantId: string,
      idempotencyKey: string,
    ): Promise<NotificationDelivery | null> {
      const [row] = await db
        .select()
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.tenantId, tenantId),
            eq(notificationDeliveries.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        tenantId: row.tenantId,
        channel: row.channel,
        destination: row.destination,
        template: row.template,
        status: row.status,
        providerMessageId: row.providerMessageId ?? null,
        idempotencyKey: row.idempotencyKey,
        error: row.error ?? null,
        createdAt: row.createdAt,
      };
    },
    async insert(input: {
      tenantId: string;
      channel: string;
      destination: string;
      template: string;
      status: string;
      providerMessageId?: string | null;
      idempotencyKey: string;
      error?: string | null;
    }): Promise<NotificationDelivery> {
      const [row] = await db
        .insert(notificationDeliveries)
        .values({
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          channel: input.channel,
          destination: input.destination,
          template: input.template,
          status: input.status,
          providerMessageId: input.providerMessageId ?? null,
          idempotencyKey: input.idempotencyKey,
          error: input.error ?? null,
          createdAt: new Date(),
        })
        .returning();
      return {
        id: row!.id,
        tenantId: row!.tenantId,
        channel: row!.channel,
        destination: row!.destination,
        template: row!.template,
        status: row!.status,
        providerMessageId: row!.providerMessageId ?? null,
        idempotencyKey: row!.idempotencyKey,
        error: row!.error ?? null,
        createdAt: row!.createdAt,
      };
    },
  };
}
