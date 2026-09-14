/**
 * Object storage port (F1) — put/get/exists.
 *
 * Default: local content-addressed blob (`data/content` / CONTENT_BLOB_ROOT).
 * Cloud: S3-compatible adapter is selectable via env, without requiring
 * credentials in CI. Production migration to cloud is out of this slice.
 */
import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors";
import {
  contentBlobExists,
  readContentBlob,
  storeContentBlob,
} from "./content-blob-store";

export type ObjectStorageDriver = "local" | "s3" | "memory";

export type ObjectStoragePutResult = {
  key: string;
  byteSize: number;
};

export type ObjectStoragePort = {
  readonly driver: ObjectStorageDriver;
  put(input: { tenantId: string; bytes: Uint8Array | Buffer }): Promise<ObjectStoragePutResult>;
  get(input: { tenantId: string; key: string }): Promise<Buffer>;
  exists(input: { tenantId: string; key: string }): Promise<boolean>;
};

export type S3ObjectStorageConfig = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

export class LocalObjectStorage implements ObjectStoragePort {
  readonly driver = "local" as const;

  constructor(private readonly root?: string) {}

  async put(input: { tenantId: string; bytes: Uint8Array | Buffer }): Promise<ObjectStoragePutResult> {
    const stored = await storeContentBlob({
      tenantId: input.tenantId,
      bytes: input.bytes,
      root: this.root,
    });
    return { key: stored.contentHash, byteSize: stored.byteSize };
  }

  async get(input: { tenantId: string; key: string }): Promise<Buffer> {
    return readContentBlob({
      tenantId: input.tenantId,
      contentHash: input.key,
      root: this.root,
    });
  }

  async exists(input: { tenantId: string; key: string }): Promise<boolean> {
    return contentBlobExists({
      tenantId: input.tenantId,
      contentHash: input.key,
      root: this.root,
    });
  }
}

/** In-memory store for tests. Same content-addressed keys as local/S3. */
export class MemoryObjectStorage implements ObjectStoragePort {
  readonly driver = "memory" as const;
  private readonly blobs = new Map<string, Buffer>();

  private mapKey(tenantId: string, key: string): string {
    return `${tenantId.trim()}:${key.trim().toLowerCase()}`;
  }

  async put(input: { tenantId: string; bytes: Uint8Array | Buffer }): Promise<ObjectStoragePutResult> {
    const tenantId = input.tenantId.trim();
    if (!tenantId) throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);
    const buf = Buffer.from(input.bytes);
    if (buf.length === 0) throw new DomainError("empty_file", "Ficheiro vazio", 400);
    const key = sha256Hex(buf);
    this.blobs.set(this.mapKey(tenantId, key), buf);
    return { key, byteSize: buf.length };
  }

  async get(input: { tenantId: string; key: string }): Promise<Buffer> {
    const found = this.blobs.get(this.mapKey(input.tenantId, input.key));
    if (!found) {
      throw new DomainError("blob_missing", "Conteúdo do ficheiro não encontrado", 404);
    }
    return found;
  }

  async exists(input: { tenantId: string; key: string }): Promise<boolean> {
    return this.blobs.has(this.mapKey(input.tenantId, input.key));
  }
}

/**
 * S3-compatible path. Fail-closed when credentials are missing.
 * This slice does not migrate production onto cloud storage.
 */
export class S3CompatibleObjectStorage implements ObjectStoragePort {
  readonly driver = "s3" as const;

  constructor(private readonly config: S3ObjectStorageConfig | null) {}

  isConfigured(): boolean {
    return this.config != null;
  }

  private assertReady(): asserts this is this & { config: S3ObjectStorageConfig } {
    if (!this.config) {
      throw new DomainError(
        "object_storage_unconfigured",
        "Object storage S3 não configurado (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY). Em dev use OBJECT_STORAGE_DRIVER=local.",
        500,
      );
    }
  }

  async put(_input: { tenantId: string; bytes: Uint8Array | Buffer }): Promise<ObjectStoragePutResult> {
    this.assertReady();
    throw new DomainError(
      "object_storage_not_wired",
      "Adapter S3-compatible está seleccionado mas a migração de produção para cloud fica fora deste slice. Use OBJECT_STORAGE_DRIVER=local.",
      501,
    );
  }

  async get(_input: { tenantId: string; key: string }): Promise<Buffer> {
    this.assertReady();
    throw new DomainError(
      "object_storage_not_wired",
      "Adapter S3-compatible está seleccionado mas a migração de produção para cloud fica fora deste slice. Use OBJECT_STORAGE_DRIVER=local.",
      501,
    );
  }

  async exists(_input: { tenantId: string; key: string }): Promise<boolean> {
    this.assertReady();
    throw new DomainError(
      "object_storage_not_wired",
      "Adapter S3-compatible está seleccionado mas a migração de produção para cloud fica fora deste slice. Use OBJECT_STORAGE_DRIVER=local.",
      501,
    );
  }
}

export function readS3ObjectStorageConfigFromEnv(): S3ObjectStorageConfig | null {
  const endpoint = String(process.env.S3_ENDPOINT ?? "").trim();
  const bucket = String(process.env.S3_BUCKET ?? "").trim();
  const accessKeyId = String(
    process.env.S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID ?? "",
  ).trim();
  const secretAccessKey = String(
    process.env.S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? "",
  ).trim();
  const region = String(process.env.S3_REGION ?? process.env.AWS_REGION ?? "auto").trim() || "auto";
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, region, accessKeyId, secretAccessKey };
}

export function objectStorageDriverFromEnv(): ObjectStorageDriver {
  const raw = String(process.env.OBJECT_STORAGE_DRIVER ?? "local")
    .trim()
    .toLowerCase();
  if (raw === "s3" || raw === "s3-compatible") return "s3";
  if (raw === "memory") return "memory";
  return "local";
}

/** Call-time factory (env is read here, not at module load). */
export function createObjectStorageFromEnv(): ObjectStoragePort {
  const driver = objectStorageDriverFromEnv();
  if (driver === "s3") {
    return new S3CompatibleObjectStorage(readS3ObjectStorageConfigFromEnv());
  }
  if (driver === "memory") {
    return new MemoryObjectStorage();
  }
  return new LocalObjectStorage();
}
