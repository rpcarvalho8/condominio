/**
 * Policy Engine skeleton (F0) — hosts SettlementPolicy / ResolutionRule / AuthorityRule later.
 * No business policies implemented here.
 */

export const POLICY_KINDS = {
  settlement: "settlement",
  resolution: "resolution",
  authority: "authority",
  placeholder: "placeholder",
} as const;

export type PolicyKind = (typeof POLICY_KINDS)[keyof typeof POLICY_KINDS];

export type PolicyRecord = {
  id: string;
  tenantId: string;
  kind: PolicyKind | string;
  code: string;
  version: number;
  bodyJson: Record<string, unknown> | null;
  effectiveFrom: Date;
  supersededBy: string | null;
  createdAt: Date;
};
