/**
 * TEMPORARY adapter (F0-A / G-001).
 *
 * Fonte routes still authorize via better-auth `user.role` (`admin` | `condómino`).
 * New kernel paths MUST read Membership — do not add features on this adapter.
 */

export type LegacyAuthUser = {
  id?: string;
  role?: string | null;
} | null | undefined;

export function readLegacyUserRole(user: LegacyAuthUser): string | null {
  const role = user?.role;
  if (typeof role !== "string") return null;
  const trimmed = role.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isLegacyAdminRole(user: LegacyAuthUser): boolean {
  return readLegacyUserRole(user) === "admin";
}
