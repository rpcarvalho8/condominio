import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DomainError } from "../domain/errors";

const DEFAULT_ROOT =
  String(process.env.CONTENT_BLOB_ROOT ?? "").trim() ||
  path.join(process.cwd(), "data", "content");

function tenantDir(root: string, tenantId: string): string {
  const safe = tenantId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(root, safe);
}

export function contentBlobPath(
  tenantId: string,
  contentHash: string,
  root = DEFAULT_ROOT,
): string {
  return path.join(tenantDir(root, tenantId), `${contentHash}.bin`);
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
  const root = input.root ?? DEFAULT_ROOT;
  const absolutePath = contentBlobPath(tenantId, contentHash, root);
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
  const absolutePath = contentBlobPath(
    input.tenantId,
    input.contentHash.trim().toLowerCase(),
    input.root ?? DEFAULT_ROOT,
  );
  if (!fs.existsSync(absolutePath)) {
    throw new DomainError("blob_missing", "Conteúdo do ficheiro não encontrado em disco", 404);
  }
  return fs.readFileSync(absolutePath);
}
