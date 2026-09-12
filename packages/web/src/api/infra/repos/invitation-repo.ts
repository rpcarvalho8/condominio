import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { invitations } from "../../database/schema";
import {
  INVITATION_STATUS,
  type Invitation,
  type InvitationStatus,
} from "../../domain/invitation";
import type { KernelDb } from "../kernel-deps";

function mapInvitation(row: typeof invitations.$inferSelect): Invitation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    fracaoId: row.fracaoId,
    canal: row.canal,
    contacto: row.contacto,
    personName: row.personName ?? null,
    roleCode: row.roleCode,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    status: row.status,
    usedAt: row.usedAt ?? null,
    revokedAt: row.revokedAt ?? null,
    revokedByPersonId: row.revokedByPersonId ?? null,
    loteId: row.loteId ?? null,
    contactVerifiedAt: row.contactVerifiedAt ?? null,
    verificationCodeHash: row.verificationCodeHash ?? null,
    verificationTokenHash: row.verificationTokenHash ?? null,
    verificationExpiresAt: row.verificationExpiresAt ?? null,
    verificationAttempts: row.verificationAttempts ?? 0,
    verificationRequests: row.verificationRequests ?? 0,
    createdAt: row.createdAt,
    createdByPersonId: row.createdByPersonId ?? null,
    acceptedPersonId: row.acceptedPersonId ?? null,
    acceptedMembershipId: row.acceptedMembershipId ?? null,
  };
}

export function createInvitationRepo(db: KernelDb) {
  return {
    async findById(id: string): Promise<Invitation | null> {
      const [row] = await db.select().from(invitations).where(eq(invitations.id, id)).limit(1);
      return row ? mapInvitation(row) : null;
    },
    async findByTokenHash(tokenHash: string): Promise<Invitation | null> {
      const [row] = await db
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, tokenHash))
        .limit(1);
      return row ? mapInvitation(row) : null;
    },
    async listByTenant(tenantId: string): Promise<Invitation[]> {
      const rows = await db
        .select()
        .from(invitations)
        .where(eq(invitations.tenantId, tenantId));
      return rows.map(mapInvitation);
    },
    async findPendingForContact(
      tenantId: string,
      fracaoId: string,
      contacto: string,
    ): Promise<Invitation | null> {
      const rows = await db
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.tenantId, tenantId),
            eq(invitations.fracaoId, fracaoId),
            eq(invitations.contacto, contacto),
            eq(invitations.status, INVITATION_STATUS.pending),
          ),
        );
      return rows[0] ? mapInvitation(rows[0]) : null;
    },
    async insert(input: {
      id: string;
      tenantId: string;
      fracaoId: string;
      canal: string;
      contacto: string;
      personName?: string | null;
      roleCode: string;
      tokenHash: string;
      expiresAt: Date;
      status?: InvitationStatus;
      loteId?: string | null;
      createdAt: Date;
      createdByPersonId?: string | null;
    }): Promise<Invitation> {
      const [row] = await db
        .insert(invitations)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          fracaoId: input.fracaoId,
          canal: input.canal,
          contacto: input.contacto,
          personName: input.personName ?? null,
          roleCode: input.roleCode,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          status: input.status ?? INVITATION_STATUS.pending,
          loteId: input.loteId ?? null,
          createdAt: input.createdAt,
          createdByPersonId: input.createdByPersonId ?? null,
        })
        .returning();
      return mapInvitation(row!);
    },
    async revoke(input: {
      id: string;
      revokedAt: Date;
      revokedByPersonId?: string | null;
    }): Promise<Invitation | null> {
      const [row] = await db
        .update(invitations)
        .set({
          status: INVITATION_STATUS.revoked,
          revokedAt: input.revokedAt,
          revokedByPersonId: input.revokedByPersonId ?? null,
        })
        .where(
          and(
            eq(invitations.id, input.id),
            eq(invitations.status, INVITATION_STATUS.pending),
            isNull(invitations.usedAt),
          ),
        )
        .returning();
      return row ? mapInvitation(row) : null;
    },
    async markVerificationIssued(input: {
      id: string;
      verificationCodeHash: string;
      verificationTokenHash: string;
      verificationExpiresAt: Date;
      verificationRequests: number;
    }): Promise<Invitation | null> {
      const [row] = await db
        .update(invitations)
        .set({
          verificationCodeHash: input.verificationCodeHash,
          verificationTokenHash: input.verificationTokenHash,
          verificationExpiresAt: input.verificationExpiresAt,
          verificationRequests: input.verificationRequests,
          verificationAttempts: 0,
        })
        .where(eq(invitations.id, input.id))
        .returning();
      return row ? mapInvitation(row) : null;
    },
    async incrementVerificationAttempts(id: string, attempts: number): Promise<void> {
      await db
        .update(invitations)
        .set({ verificationAttempts: attempts })
        .where(eq(invitations.id, id));
    },
    async markContactVerified(id: string, verifiedAt: Date): Promise<Invitation | null> {
      const [row] = await db
        .update(invitations)
        .set({
          contactVerifiedAt: verifiedAt,
          verificationCodeHash: null,
          verificationTokenHash: null,
        })
        .where(eq(invitations.id, id))
        .returning();
      return row ? mapInvitation(row) : null;
    },
    async markAccepted(input: {
      id: string;
      usedAt: Date;
      acceptedPersonId: string;
      acceptedMembershipId: string;
    }): Promise<Invitation | null> {
      const [row] = await db
        .update(invitations)
        .set({
          status: INVITATION_STATUS.accepted,
          usedAt: input.usedAt,
          acceptedPersonId: input.acceptedPersonId,
          acceptedMembershipId: input.acceptedMembershipId,
        })
        .where(
          and(
            eq(invitations.id, input.id),
            eq(invitations.status, INVITATION_STATUS.pending),
            isNull(invitations.usedAt),
            isNotNull(invitations.contactVerifiedAt),
          ),
        )
        .returning();
      return row ? mapInvitation(row) : null;
    },
  };
}

export type InvitationRepo = ReturnType<typeof createInvitationRepo>;
