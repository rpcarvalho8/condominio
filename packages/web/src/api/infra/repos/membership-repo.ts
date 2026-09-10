import { and, eq } from "drizzle-orm";
import { memberships } from "../../database/schema";
import {
  MEMBERSHIP_STATUS,
  type Membership,
  type MembershipStatus,
} from "../../domain/membership";
import type { KernelDb } from "../kernel-deps";

function mapMembership(row: typeof memberships.$inferSelect): Membership {
  return {
    id: row.id,
    personId: row.personId,
    tenantId: row.tenantId,
    fracaoId: row.fracaoId ?? null,
    roleCode: row.roleCode,
    scope: row.scope ?? null,
    status: row.status,
    createdAt: row.createdAt,
    createdByPersonId: row.createdByPersonId ?? null,
    revokedAt: row.revokedAt ?? null,
    revokedByPersonId: row.revokedByPersonId ?? null,
  };
}

export function createMembershipRepo(db: KernelDb) {
  return {
    async findById(id: string): Promise<Membership | null> {
      const [row] = await db.select().from(memberships).where(eq(memberships.id, id)).limit(1);
      return row ? mapMembership(row) : null;
    },
    async findActiveForPersonTenant(personId: string, tenantId: string): Promise<Membership[]> {
      const rows = await db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.personId, personId),
            eq(memberships.tenantId, tenantId),
            eq(memberships.status, MEMBERSHIP_STATUS.active),
          ),
        );
      return rows.map(mapMembership);
    },
    async listByPersonTenant(personId: string, tenantId: string): Promise<Membership[]> {
      const rows = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.personId, personId), eq(memberships.tenantId, tenantId)));
      return rows.map(mapMembership);
    },
    async insert(input: {
      id: string;
      personId: string;
      tenantId: string;
      fracaoId?: string | null;
      roleCode: string;
      scope?: string | null;
      status?: MembershipStatus;
      createdAt: Date;
      createdByPersonId?: string | null;
    }): Promise<Membership> {
      const [row] = await db
        .insert(memberships)
        .values({
          id: input.id,
          personId: input.personId,
          tenantId: input.tenantId,
          fracaoId: input.fracaoId ?? null,
          roleCode: input.roleCode,
          scope: input.scope ?? null,
          status: input.status ?? MEMBERSHIP_STATUS.active,
          createdAt: input.createdAt,
          createdByPersonId: input.createdByPersonId ?? null,
        })
        .returning();
      return mapMembership(row!);
    },
    async revoke(input: {
      id: string;
      revokedAt: Date;
      revokedByPersonId?: string | null;
    }): Promise<Membership | null> {
      const [row] = await db
        .update(memberships)
        .set({
          status: MEMBERSHIP_STATUS.revoked,
          revokedAt: input.revokedAt,
          revokedByPersonId: input.revokedByPersonId ?? null,
        })
        .where(eq(memberships.id, input.id))
        .returning();
      return row ? mapMembership(row) : null;
    },
  };
}

export type MembershipRepo = ReturnType<typeof createMembershipRepo>;
