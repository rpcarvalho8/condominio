/**
 * Canonical tenant_id — injective storage / filesystem namespace (Astra A2).
 *
 * Storage adapters used to replace `[^A-Za-z0-9._-]` with `_`, so distinct ids
 * such as `a/b` and `a_b` mapped to the same prefix. That is a tenant collision.
 *
 * Valid ids are already a safe path segment: namespace = identity(tenant_id).
 * Invalid ids are rejected at **tenant creation** (and fail-closed in storage),
 * never silently rewritten.
 */
import { DomainError } from "./errors";

/** Max length of a canonical tenant_id (S3/FS path segment; sha256 key still fits). */
export const TENANT_ID_MAX_LENGTH = 64;

/**
 * Starts with alphanumeric; then `[A-Za-z0-9._-]`. Length 1–64.
 * Excludes `/`, whitespace, and other chars that the old `_` sanitizer collapsed.
 */
export const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isCanonicalTenantId(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > TENANT_ID_MAX_LENGTH) return false;
  if (value.includes("..")) return false;
  return TENANT_ID_PATTERN.test(value);
}

function assertCanonicalFormat(tenantId: string, empty: DomainError): string {
  if (!tenantId) throw empty;
  if (!isCanonicalTenantId(tenantId)) {
    throw new DomainError(
      "invalid_tenant_id",
      "tenant_id inválido: [A-Za-z0-9][A-Za-z0-9._-]{0,63}, sem '..' (recusado na criação; storage não sanitiza)",
      400,
    );
  }
  return tenantId;
}

/** Parse + validate at TenantDirectory / provision time. Empty → 400. */
export function parseCanonicalTenantId(raw: unknown): string {
  const tenantId = String(raw ?? "").trim();
  return assertCanonicalFormat(
    tenantId,
    new DomainError("tenant_id_required", "tenant_id é obrigatório", 400),
  );
}

/**
 * Storage/FS/S3 namespace for a tenant.
 * Identity of a canonical id — therefore injective on the valid set.
 * Missing tenant context → 403 (fail-closed, same as other storage ports).
 */
export function storageNamespaceForTenant(tenantId: string): string {
  const id = String(tenantId ?? "").trim();
  return assertCanonicalFormat(
    id,
    new DomainError("tenant_required", "tenant_id é obrigatório", 403),
  );
}
