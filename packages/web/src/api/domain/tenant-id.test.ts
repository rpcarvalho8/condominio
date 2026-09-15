/**
 * Astra A2 — canonical tenant_id is injective as a storage namespace.
 * Imports production parsers + provisionTenant + storage key builders.
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { DomainError } from "./errors";
import {
  isCanonicalTenantId,
  parseCanonicalTenantId,
  storageNamespaceForTenant,
  TENANT_ID_MAX_LENGTH,
} from "./tenant-id";
import { provisionTenant } from "../application/platform/provision-tenant";
import { applyPlatformSchema } from "../platform/apply-schema";
import { createPlatformDb } from "../platform/database";
import { contentBlobPath } from "../infra/content-blob-store";
import { s3ObjectKey } from "../infra/object-storage";

/** The pre-A2 sanitizer — documented here as the collision that creation must refuse. */
function legacySanitize(tenantId: string): string {
  return tenantId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

const HASH = "a".repeat(64);

const VALID_IDS = [
  "a",
  "A",
  "a_b",
  "a-b",
  "a.b",
  "condo-A",
  "tenant-auth",
  "901932027",
  "f1-s3-live",
  "ok-tenant",
  "x".repeat(TENANT_ID_MAX_LENGTH),
];

/** Pairs that the old `_` rewrite collapsed — first is invalid, second is a distinct valid id. */
const LEGACY_COLLISION_PAIRS: Array<[invalid: string, valid: string]> = [
  ["a/b", "a_b"],
  ["a b", "a_b"],
  ["a\\b", "a_b"],
  ["a:b", "a_b"],
  ["a@b", "a_b"],
  ["a+b", "a_b"],
  ["café", "caf_"],
];

describe("canonical tenant_id", () => {
  test("accepts existing LUMEN-style ids (NIF, kebab, underscore, dot)", () => {
    for (const id of VALID_IDS) {
      expect(isCanonicalTenantId(id)).toBe(true);
      expect(parseCanonicalTenantId(`  ${id}  `)).toBe(id);
      expect(storageNamespaceForTenant(id)).toBe(id);
    }
  });

  test("rejects empty and whitespace-only", () => {
    try {
      parseCanonicalTenantId("");
      throw new Error("expected empty parse to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("tenant_id_required");
      expect((err as DomainError).httpStatus).toBe(400);
    }
    try {
      parseCanonicalTenantId("   ");
      throw new Error("expected whitespace parse to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("tenant_id_required");
    }
    try {
      storageNamespaceForTenant("");
      throw new Error("expected empty storage tenant to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("tenant_required");
      expect((err as DomainError).httpStatus).toBe(403);
    }
  });

  test("rejects path, whitespace, unicode, leading punctuation, '..', oversize", () => {
    const invalid = [
      "a/b",
      "a\\b",
      "a b",
      "/root",
      "../escape",
      "foo..bar",
      ".hidden",
      "-leading",
      "_underscore",
      "café",
      "a:b",
      "x".repeat(TENANT_ID_MAX_LENGTH + 1),
    ];
    for (const id of invalid) {
      expect(isCanonicalTenantId(id)).toBe(false);
      try {
        parseCanonicalTenantId(id);
        throw new Error(`expected reject: ${id}`);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe("invalid_tenant_id");
        expect((err as DomainError).httpStatus).toBe(400);
      }
    }
  });
});

describe("storage namespace injectivity (production builders)", () => {
  test("legacy sanitizer collides; canonical ids + builders do not", () => {
    for (const [invalid, valid] of LEGACY_COLLISION_PAIRS) {
      expect(legacySanitize(invalid)).toBe(legacySanitize(valid));
      expect(isCanonicalTenantId(invalid)).toBe(false);
      expect(isCanonicalTenantId(valid)).toBe(true);
      expect(storageNamespaceForTenant(valid)).toBe(valid);
      expect(() => storageNamespaceForTenant(invalid)).toThrow(DomainError);
      expect(() => s3ObjectKey(invalid, HASH)).toThrow(DomainError);
      expect(() => contentBlobPath(invalid, HASH, "/tmp/blobs")).toThrow(DomainError);
      expect(s3ObjectKey(valid, HASH)).toBe(`${valid}/${HASH}.bin`);
      expect(contentBlobPath(valid, HASH, "/tmp/blobs")).toContain(`${valid}/${HASH}.bin`);
    }
  });

  test("two distinct valid tenant_ids never share a namespace (identity)", () => {
    const namespaces = VALID_IDS.map((id) => storageNamespaceForTenant(id));
    expect(namespaces).toEqual(VALID_IDS);
    expect(new Set(namespaces).size).toBe(VALID_IDS.length);

    const s3Keys = VALID_IDS.map((id) => s3ObjectKey(id, HASH, "lumen"));
    expect(new Set(s3Keys).size).toBe(VALID_IDS.length);

    const blobDirs = VALID_IDS.map((id) => contentBlobPath(id, HASH, "/tmp/blobs"));
    expect(new Set(blobDirs).size).toBe(VALID_IDS.length);
  });
});

describe("provisionTenant — invalid ids refused at creation", () => {
  test("a/b is rejected before the provisioner runs; a_b is accepted", async () => {
    const client = createClient({ url: ":memory:" });
    await applyPlatformSchema(client);
    const platformDb = createPlatformDb(client);
    const calls: string[] = [];
    const provisioner = {
      async provision(tenantId: string) {
        calls.push(tenantId);
        return {
          dbRef: `file:/tmp/${tenantId}.db`,
          client: { close() {} },
        };
      },
    };

    try {
      await provisionTenant({ platformDb, provisioner }, { tenantId: "a/b" });
      throw new Error("expected invalid tenant_id");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("invalid_tenant_id");
    }
    expect(calls).toEqual([]);

    const created = await provisionTenant({ platformDb, provisioner }, { tenantId: "a_b" });
    expect(created.created).toBe(true);
    expect(created.entry.tenantId).toBe("a_b");
    expect(calls).toEqual(["a_b"]);
    client.close();
  });
});
