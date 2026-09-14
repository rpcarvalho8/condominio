import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DomainError } from "../domain/errors";
import {
  createObjectStorageFromEnv,
  LocalObjectStorage,
  MemoryObjectStorage,
  objectStorageDriverFromEnv,
  readS3ObjectStorageConfigFromEnv,
  S3CompatibleObjectStorage,
  s3ObjectKey,
  type S3BlobClient,
  type S3ObjectStorageConfig,
} from "./object-storage";

function memoryS3(): S3BlobClient & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  return {
    store,
    async put(objectKey, bytes) {
      store.set(objectKey, Buffer.from(bytes));
    },
    async get(objectKey) {
      const found = store.get(objectKey);
      if (!found) {
        const err = new Error("NoSuchKey");
        (err as { code?: string; status?: number }).code = "NoSuchKey";
        (err as { status?: number }).status = 404;
        throw err;
      }
      return found;
    },
    async exists(objectKey) {
      return store.has(objectKey);
    },
  };
}

function stubConfig(over: Partial<S3ObjectStorageConfig> = {}): S3ObjectStorageConfig {
  return {
    endpoint: "https://s3.example.test",
    bucket: "lumen-test",
    region: "auto",
    accessKeyId: "key",
    secretAccessKey: "secret",
    prefix: "",
    virtualHostedStyle: false,
    ...over,
  };
}

describe("object-storage port", () => {
  const tmps: string[] = [];
  const prev: Record<string, string | undefined> = {};

  function snapshotEnv(keys: string[]) {
    for (const key of keys) prev[key] = process.env[key];
  }
  function restoreEnv() {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const k of Object.keys(prev)) delete prev[k];
  }

  afterEach(() => {
    restoreEnv();
    for (const dir of tmps.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("local put/get/exists is content-addressed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "f1-obj-"));
    tmps.push(root);
    const storage = new LocalObjectStorage(root);
    const bytes = Buffer.from("object-storage-local");
    const put = await storage.put({ tenantId: "t1", bytes });
    expect(put.key).toMatch(/^[a-f0-9]{64}$/);
    expect(put.byteSize).toBe(bytes.length);
    expect(await storage.exists({ tenantId: "t1", key: put.key })).toBe(true);
    expect(await storage.exists({ tenantId: "t1", key: "a".repeat(64) })).toBe(false);
    const got = await storage.get({ tenantId: "t1", key: put.key });
    expect(got.toString("utf8")).toBe("object-storage-local");
  });

  test("memory adapter isolates tenants", async () => {
    const storage = new MemoryObjectStorage();
    const put = await storage.put({ tenantId: "a", bytes: Buffer.from("secret-a") });
    expect(await storage.exists({ tenantId: "b", key: put.key })).toBe(false);
    await expect(storage.get({ tenantId: "b", key: put.key })).rejects.toBeInstanceOf(DomainError);
  });

  test("factory defaults to local without cloud credentials", () => {
    snapshotEnv(["OBJECT_STORAGE_DRIVER", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
    delete process.env.OBJECT_STORAGE_DRIVER;
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    expect(objectStorageDriverFromEnv()).toBe("local");
    expect(readS3ObjectStorageConfigFromEnv()).toBeNull();
    const storage = createObjectStorageFromEnv();
    expect(storage.driver).toBe("local");
  });

  test("S3 adapter without credentials fails closed on use, not on construct", async () => {
    snapshotEnv([
      "OBJECT_STORAGE_DRIVER",
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]);
    process.env.OBJECT_STORAGE_DRIVER = "s3";
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    const storage = createObjectStorageFromEnv();
    expect(storage.driver).toBe("s3");
    expect((storage as S3CompatibleObjectStorage).isConfigured()).toBe(false);
    try {
      await storage.exists({ tenantId: "t", key: "a".repeat(64) });
      throw new Error("expected fail-closed");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("object_storage_unconfigured");
    }
    try {
      await storage.put({ tenantId: "t", bytes: Buffer.from("x") });
      throw new Error("expected fail-closed put");
    } catch (err) {
      expect((err as DomainError).code).toBe("object_storage_unconfigured");
    }
  });

  test("S3 config is null when any required var is missing", () => {
    snapshotEnv(["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_REGION"]);
    process.env.S3_ENDPOINT = "https://s3.example.test";
    process.env.S3_BUCKET = "bucket";
    process.env.S3_ACCESS_KEY_ID = "id";
    delete process.env.S3_SECRET_ACCESS_KEY;
    expect(readS3ObjectStorageConfigFromEnv()).toBeNull();
  });

  test("S3 factory is configured from env without talking to the network", () => {
    snapshotEnv([
      "OBJECT_STORAGE_DRIVER",
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_REGION",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_KEY_PREFIX",
      "S3_FORCE_PATH_STYLE",
      "S3_VIRTUAL_HOSTED_STYLE",
    ]);
    process.env.OBJECT_STORAGE_DRIVER = "s3";
    process.env.S3_ENDPOINT = "https://s3.example.test";
    process.env.S3_BUCKET = "lumen-staging";
    process.env.S3_REGION = "auto";
    process.env.S3_ACCESS_KEY_ID = "id";
    process.env.S3_SECRET_ACCESS_KEY = "secret";
    process.env.S3_KEY_PREFIX = "lumen/staging";
    process.env.S3_FORCE_PATH_STYLE = "1";
    const cfg = readS3ObjectStorageConfigFromEnv();
    expect(cfg).not.toBeNull();
    expect(cfg?.bucket).toBe("lumen-staging");
    expect(cfg?.prefix).toBe("lumen/staging");
    expect(cfg?.virtualHostedStyle).toBe(false);
    const storage = createObjectStorageFromEnv();
    expect(storage.driver).toBe("s3");
    expect((storage as S3CompatibleObjectStorage).isConfigured()).toBe(true);
  });

  test("S3 stub put/get/exists matches local contract (content-addressed, tenant-scoped)", async () => {
    const s3 = memoryS3();
    const storage = new S3CompatibleObjectStorage(stubConfig({ prefix: "lumen-ci" }), s3);
    const bytes = Buffer.from("object-storage-s3-stub");
    const put = await storage.put({ tenantId: "t1", bytes });
    expect(put.key).toMatch(/^[a-f0-9]{64}$/);
    expect(put.byteSize).toBe(bytes.length);
    expect(s3.store.has(s3ObjectKey("t1", put.key, "lumen-ci"))).toBe(true);
    expect(await storage.exists({ tenantId: "t1", key: put.key })).toBe(true);
    expect(await storage.exists({ tenantId: "t1", key: "a".repeat(64) })).toBe(false);
    expect(await storage.exists({ tenantId: "other", key: put.key })).toBe(false);
    const got = await storage.get({ tenantId: "t1", key: put.key });
    expect(got.toString("utf8")).toBe("object-storage-s3-stub");
    try {
      await storage.get({ tenantId: "t1", key: "b".repeat(64) });
      throw new Error("expected missing blob");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("blob_missing");
      expect((err as DomainError).httpStatus).toBe(404);
    }
  });

  test("S3 object key stays under prefix and rejects traversal hashes", () => {
    expect(s3ObjectKey("tenant-a", "a".repeat(64), "prod")).toBe(`prod/tenant-a/${"a".repeat(64)}.bin`);
    expect(() => s3ObjectKey("t", "../secret")).toThrow(DomainError);
  });

  test("S3 driver stays s3 with invalid endpoint and fails closed (no local fallback)", async () => {
    snapshotEnv([
      "OBJECT_STORAGE_DRIVER",
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_REGION",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_KEY_PREFIX",
      "S3_FORCE_PATH_STYLE",
      "S3_VIRTUAL_HOSTED_STYLE",
    ]);
    process.env.OBJECT_STORAGE_DRIVER = "s3";
    process.env.S3_ENDPOINT = "http://127.0.0.1:1";
    process.env.S3_BUCKET = "lumen-dev";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = "id";
    process.env.S3_SECRET_ACCESS_KEY = "secret";
    process.env.S3_KEY_PREFIX = "lumen-dev";
    process.env.S3_FORCE_PATH_STYLE = "1";
    delete process.env.S3_VIRTUAL_HOSTED_STYLE;
    const storage = createObjectStorageFromEnv();
    expect(storage.driver).toBe("s3");
    expect(storage).toBeInstanceOf(S3CompatibleObjectStorage);
    expect(storage).not.toBeInstanceOf(LocalObjectStorage);
    try {
      await storage.put({ tenantId: "t", bytes: Buffer.from("no-silent-local-fallback") });
      throw new Error("expected fail-closed put on invalid S3 endpoint");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("object_storage_s3_error");
    }
    expect(storage.driver).toBe("s3");
  });

  test("S3 NoSuchBucket fails closed instead of exists=false", async () => {
    const client: S3BlobClient = {
      async put() {
        throw Object.assign(new Error("NoSuchBucket"), { code: "NoSuchBucket", status: 404 });
      },
      async get() {
        throw Object.assign(new Error("NoSuchBucket"), { code: "NoSuchBucket", status: 404 });
      },
      async exists() {
        throw Object.assign(new Error("NoSuchBucket"), { code: "NoSuchBucket", status: 404 });
      },
    };
    const storage = new S3CompatibleObjectStorage(stubConfig(), client);
    try {
      await storage.exists({ tenantId: "t", key: "a".repeat(64) });
      throw new Error("expected fail-closed NoSuchBucket");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("object_storage_s3_error");
    }
  });

  const live =
    process.env.OBJECT_STORAGE_LIVE_S3 === "1" && readS3ObjectStorageConfigFromEnv() != null;

  test.skipIf(!live)("S3 live put/get/exists (opt-in OBJECT_STORAGE_LIVE_S3=1)", async () => {
    const storage = new S3CompatibleObjectStorage(readS3ObjectStorageConfigFromEnv());
    const bytes = Buffer.from(`f1-s3-live-${Date.now()}`);
    const put = await storage.put({ tenantId: "f1-s3-live", bytes });
    expect(put.key).toMatch(/^[a-f0-9]{64}$/);
    expect(await storage.exists({ tenantId: "f1-s3-live", key: put.key })).toBe(true);
    const got = await storage.get({ tenantId: "f1-s3-live", key: put.key });
    expect(got.equals(bytes)).toBe(true);
  });
});
