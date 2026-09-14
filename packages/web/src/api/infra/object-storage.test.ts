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
} from "./object-storage";

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
    snapshotEnv(["OBJECT_STORAGE_DRIVER"]);
    process.env.OBJECT_STORAGE_DRIVER = "s3";
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
  });
});
