/**
 * Object storage port (F1) — put/get/exists.
 *
 * Default: local content-addressed blob (`data/content` / CONTENT_BLOB_ROOT).
 * Staging/prod: `OBJECT_STORAGE_DRIVER=s3` + `S3_*` (Bun S3 client, S3-compatible).
 * Fail-closed without credentials. CI stays on local — never required.
 *
 * Do **not** statically `import … from "bun"`: Vite SSR (`ssrLoadModule`) cannot
 * resolve the Bun builtin and crashes `bun run dev` even when the driver is local.
 */
import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors";
import { storageNamespaceForTenant } from "../domain/tenant-id";
import {
  assertSha256ContentHash,
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
  /** Optional key prefix, no slashes required (`lumen-staging`). */
  prefix: string;
  /** Bun default is path-style (S3-compatible). Set true for AWS virtual-hosted. */
  virtualHostedStyle: boolean;
};

/** Injectable S3 transport so CI can stub put/get/exists without a real bucket. */
export type S3BlobClient = {
  put(objectKey: string, bytes: Buffer): Promise<void>;
  get(objectKey: string): Promise<Buffer>;
  exists(objectKey: string): Promise<boolean>;
};

function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function normalizePrefix(raw: string): string {
  return raw.trim().replace(/^\/+|\/+$/g, "");
}

export function s3ObjectKey(tenantId: string, contentHash: string, prefix = ""): string {
  const tenant = storageNamespaceForTenant(tenantId);
  const hash = assertSha256ContentHash(contentHash);
  const p = normalizePrefix(prefix);
  return p ? `${p}/${tenant}/${hash}.bin` : `${tenant}/${hash}.bin`;
}

function envFlag(raw: string | undefined): boolean | undefined {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

function s3ErrorCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const e = err as Record<string, unknown>;
  return String(e.code ?? e.name ?? e.Code ?? "").toLowerCase();
}

function s3HttpStatus(err: unknown): number {
  if (!err || typeof err !== "object") return 0;
  const e = err as Record<string, unknown>;
  const meta = e.$metadata;
  const fromMeta =
    meta && typeof meta === "object"
      ? Number((meta as { httpStatusCode?: number }).httpStatusCode ?? 0)
      : 0;
  return Number(e.status ?? e.statusCode ?? e.httpStatusCode ?? fromMeta ?? 0);
}

function isS3NoSuchBucket(err: unknown): boolean {
  return s3ErrorCode(err).includes("nosuchbucket");
}

function isS3NoSuchKey(err: unknown): boolean {
  if (isS3NoSuchBucket(err)) return false;
  const code = s3ErrorCode(err);
  if (code.includes("nosuchkey") || code === "notfound" || code === "not_found") return true;
  return s3HttpStatus(err) === 404;
}

function wrapS3Error(err: unknown, fallback: string): never {
  if (err instanceof DomainError) throw err;
  if (isS3NoSuchKey(err)) {
    throw new DomainError("blob_missing", "Conteúdo do ficheiro não encontrado", 404);
  }
  throw new DomainError("object_storage_s3_error", fallback, 502);
}

type BunS3Client = {
  write(key: string, data: Buffer, opts?: { type?: string }): Promise<unknown>;
  file(key: string): { arrayBuffer(): Promise<ArrayBuffer> };
  exists(key: string): Promise<boolean>;
};

async function loadBunS3Client(config: S3ObjectStorageConfig): Promise<BunS3Client> {
  // @vite-ignore: builtin resolved by the Bun runtime, not by Vite's module graph.
  const bunMod = (await import(/* @vite-ignore */ "bun")) as {
    S3Client: new (opts: {
      accessKeyId: string;
      secretAccessKey: string;
      bucket: string;
      endpoint: string;
      region: string;
      virtualHostedStyle: boolean;
    }) => BunS3Client;
  };
  return new bunMod.S3Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region,
    virtualHostedStyle: config.virtualHostedStyle,
  });
}

export async function createBunS3BlobClient(config: S3ObjectStorageConfig): Promise<S3BlobClient> {
  const client = await loadBunS3Client(config);
  return {
    async put(objectKey, bytes) {
      await client.write(objectKey, bytes, { type: "application/octet-stream" });
    },
    async get(objectKey) {
      return Buffer.from(await client.file(objectKey).arrayBuffer());
    },
    async exists(objectKey) {
      return client.exists(objectKey);
    },
  };
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
    return `${storageNamespaceForTenant(tenantId)}:${key.trim().toLowerCase()}`;
  }

  async put(input: { tenantId: string; bytes: Uint8Array | Buffer }): Promise<ObjectStoragePutResult> {
    const tenantId = storageNamespaceForTenant(input.tenantId);
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
 * S3-compatible driver. Fail-closed when credentials are missing.
 * Object keys stay content-addressed (`[prefix/]{tenant}/{sha256}.bin`).
 * Does not copy existing local `data/content` blobs.
 */
export class S3CompatibleObjectStorage implements ObjectStoragePort {
  readonly driver = "s3" as const;
  private cachedClient: Promise<S3BlobClient> | undefined;

  constructor(
    private readonly config: S3ObjectStorageConfig | null,
    private readonly injectedClient?: S3BlobClient,
  ) {}

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

  private client(): Promise<S3BlobClient> {
    this.assertReady();
    if (!this.cachedClient) {
      this.cachedClient = this.injectedClient
        ? Promise.resolve(this.injectedClient)
        : createBunS3BlobClient(this.config);
    }
    return this.cachedClient;
  }

  async put(input: { tenantId: string; bytes: Uint8Array | Buffer }): Promise<ObjectStoragePutResult> {
    this.assertReady();
    const tenantId = storageNamespaceForTenant(input.tenantId);
    const buf = Buffer.from(input.bytes);
    if (buf.length === 0) throw new DomainError("empty_file", "Ficheiro vazio", 400);
    const key = sha256Hex(buf);
    const objectKey = s3ObjectKey(tenantId, key, this.config.prefix);
    try {
      await (await this.client()).put(objectKey, buf);
    } catch (err) {
      wrapS3Error(err, "Falha a gravar objecto no S3");
    }
    return { key, byteSize: buf.length };
  }

  async get(input: { tenantId: string; key: string }): Promise<Buffer> {
    this.assertReady();
    const objectKey = s3ObjectKey(input.tenantId, input.key, this.config.prefix);
    try {
      return await (await this.client()).get(objectKey);
    } catch (err) {
      wrapS3Error(err, "Falha a ler objecto no S3");
    }
  }

  async exists(input: { tenantId: string; key: string }): Promise<boolean> {
    this.assertReady();
    const objectKey = s3ObjectKey(input.tenantId, input.key, this.config.prefix);
    try {
      return await (await this.client()).exists(objectKey);
    } catch (err) {
      if (isS3NoSuchKey(err)) return false;
      wrapS3Error(err, "Falha a verificar objecto no S3");
    }
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

  const virtualFromFlag = envFlag(process.env.S3_VIRTUAL_HOSTED_STYLE);
  const forcePath = envFlag(process.env.S3_FORCE_PATH_STYLE);
  const virtualHostedStyle = virtualFromFlag ?? (forcePath === undefined ? false : !forcePath);

  return {
    endpoint,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    prefix: normalizePrefix(process.env.S3_KEY_PREFIX ?? process.env.S3_PREFIX ?? ""),
    virtualHostedStyle,
  };
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
