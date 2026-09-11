import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DomainError } from "../domain/errors";
import {
  assertSha256ContentHash,
  contentBlobPath,
  readContentBlob,
  storeContentBlob,
} from "./content-blob-store";

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "f1-blob-"));
}

describe("content-blob-store hash + path safety", () => {
  const tmps: string[] = [];

  afterEach(() => {
    for (const dir of tmps.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("assertSha256ContentHash rejects traversal and non-hex", () => {
    const bad = [
      "../secret",
      "../../etc/passwd",
      "..\\..\\secret",
      "/etc/passwd",
      "a".repeat(63),
      "a".repeat(65),
      `${"a".repeat(64)}/../x`,
      "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      "",
    ];
    for (const hash of bad) {
      expect(() => assertSha256ContentHash(hash)).toThrow(DomainError);
    }
    expect(assertSha256ContentHash("A".repeat(64))).toBe("a".repeat(64));
  });

  test("crafted hashes cannot read a file outside the blob root", async () => {
    const tmp = makeTmp();
    tmps.push(tmp);
    const blobRoot = path.join(tmp, "blobs");
    const secretPath = path.join(tmp, "secret.txt");
    fs.mkdirSync(blobRoot, { recursive: true });
    fs.writeFileSync(secretPath, "TOPSECRET-SHOULD-NOT-LEAK");

    const crafted = [
      "../secret.txt",
      "../../secret.txt",
      path.join("..", "secret.txt"),
      `../`.repeat(12) + "secret.txt",
      "..%2fsecret.txt",
      "....//secret.txt",
      "/etc/passwd",
      "\\..\\secret.txt",
      `${"a".repeat(64)}/../../secret.txt`,
    ];

    for (const contentHash of crafted) {
      expect(() => contentBlobPath("tenant-f1", contentHash, blobRoot)).toThrow(DomainError);
      try {
        readContentBlob({ tenantId: "tenant-f1", contentHash, root: blobRoot });
        throw new Error(`traversal hash was readable: ${contentHash}`);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe("invalid_hash");
        expect(String((err as Error).message)).not.toContain("TOPSECRET");
      }
    }

    expect(fs.readFileSync(secretPath, "utf8")).toBe("TOPSECRET-SHOULD-NOT-LEAK");
    expect(fs.existsSync(path.join(blobRoot, "secret.txt"))).toBe(false);
  });

  test("valid sha256 path stays under the blob root", async () => {
    const tmp = makeTmp();
    tmps.push(tmp);
    const blobRoot = path.join(tmp, "blobs");
    const stored = await storeContentBlob({
      tenantId: "tenant-f1",
      bytes: Buffer.from("hello-f1"),
      root: blobRoot,
    });
    const resolvedRoot = path.resolve(blobRoot);
    expect(stored.absolutePath.startsWith(resolvedRoot + path.sep)).toBe(true);
    expect(stored.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const again = readContentBlob({
      tenantId: "tenant-f1",
      contentHash: stored.contentHash,
      root: blobRoot,
    });
    expect(again.toString("utf8")).toBe("hello-f1");
  });

  test("CONTENT_BLOB_ROOT is read at call time (not module-load const)", async () => {
    const tmp = makeTmp();
    tmps.push(tmp);
    const prev = process.env.CONTENT_BLOB_ROOT;
    process.env.CONTENT_BLOB_ROOT = tmp;
    try {
      const stored = await storeContentBlob({
        tenantId: "iso-tenant",
        bytes: Buffer.from("call-time-root"),
      });
      expect(stored.absolutePath.startsWith(path.resolve(tmp) + path.sep)).toBe(true);
      const leaked = path.join(
        process.cwd(),
        "data",
        "content",
        "iso-tenant",
        `${stored.contentHash}.bin`,
      );
      expect(fs.existsSync(leaked)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CONTENT_BLOB_ROOT;
      else process.env.CONTENT_BLOB_ROOT = prev;
    }
  });
});
