import type { KernelRoleCode } from "./roles";

export const MEMBERSHIP_STATUS = {
  active: "active",
  revoked: "revoked",
} as const;

export type MembershipStatus = (typeof MEMBERSHIP_STATUS)[keyof typeof MEMBERSHIP_STATUS];

export type Membership = {
  id: string;
  personId: string;
  tenantId: string;
  fracaoId: string | null;
  roleCode: KernelRoleCode | string;
  scope: string | null;
  status: MembershipStatus | string;
  createdAt: Date;
  createdByPersonId: string | null;
  revokedAt: Date | null;
  revokedByPersonId: string | null;
};

export function isActiveMembership(membership: Pick<Membership, "status">): boolean {
  return membership.status === MEMBERSHIP_STATUS.active;
}

export function sameFracao(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}
