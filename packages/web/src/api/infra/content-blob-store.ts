import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DomainError } from "../domain/errors";

export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

function defaultContentBlobRoot(): string {
  return (
    String(process.env.CONTENT_BLOB_ROOT ?? "").trim() ||
    path.join(process.cwd(), "data", "content")
  );
}

function resolveBlobRoot(root?: string): string {
  const raw = root?.trim() || defaultContentBlobRoot();
  return path.resolve(raw);
}

function tenantDir(root: string, tenantId: string): string {
  const safe = tenantId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(root, safe);
}

function assertInsideRoot(absolutePath: string, root: string): string {
  const resolved = path.resolve(absolutePath);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new DomainError("invalid_hash", "contentHash inválido", 400);
  }
  return resolved;
}

/** Rejects anything that is not a 64-char lowercase sha256 hex digest. */
export function assertSha256ContentHash(contentHash: string): string {
  const hash = contentHash.trim().toLowerCase();
  if (!SHA256_HEX_RE.test(hash)) {
    throw new DomainError("invalid_hash", "contentHash deve ser sha256 hex", 400);
  }
  return hash;
}

export function contentBlobPath(
  tenantId: string,
  contentHash: string,
  root?: string,
): string {
  const hash = assertSha256ContentHash(contentHash);
  const resolvedRoot = resolveBlobRoot(root);
  const absolutePath = path.join(tenantDir(resolvedRoot, tenantId), `${hash}.bin`);
  return assertInsideRoot(absolutePath, resolvedRoot);
}

/**
 * Guarda bytes content-addressed em disco (F1 — critério “admin sobe ficheiro”).
 * Object storage cloud fica para depois; local cumpre o critério de ingestão.
 */
export async function storeContentBlob(input: {
  tenantId: string;
  bytes: Uint8Array | Buffer;
  root?: string;
}): Promise<{ contentHash: string; byteSize: number; absolutePath: string }> {
  const tenantId = input.tenantId.trim();
  if (!tenantId) throw new DomainError("tenant_required", "tenant_id é obrigatório", 403);
  const buf = Buffer.from(input.bytes);
  if (buf.length === 0) {
    throw new DomainError("empty_file", "Ficheiro vazio", 400);
  }
  const contentHash = createHash("sha256").update(buf).digest("hex");
  const absolutePath = contentBlobPath(tenantId, contentHash, input.root);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  if (!fs.existsSync(absolutePath)) {
    fs.writeFileSync(absolutePath, buf);
  }
  return { contentHash, byteSize: buf.length, absolutePath };
}

export function readContentBlob(input: {
  tenantId: string;
  contentHash: string;
  root?: string;
}): Buffer {
  const absolutePath = contentBlobPath(input.tenantId, input.contentHash, input.root);
  if (!fs.existsSync(absolutePath)) {
    throw new DomainError("blob_missing", "Conteúdo do ficheiro não encontrado em disco", 404);
  }
  return fs.readFileSync(absolutePath);
}
