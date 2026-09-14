import { eq } from "drizzle-orm";
import { ingestDocuments } from "../../database/schema";
import {
  EXTRACT_LINE_KINDS,
  INGEST_DOCUMENT_KINDS,
  INGEST_DOCUMENT_STATUS,
} from "../../domain/constitution";
import { DomainError } from "../../domain/errors";
import { kernelNow, type KernelDeps } from "../../infra/kernel-deps";
import { createObjectStorageFromEnv } from "../../infra/object-storage";
import { registerContentUpload } from "../uploads/register-content-upload";
import { extractDocumentLines, registerIngestDocument } from "./f1-constitution";
import { extractStructuredFromBytes } from "./extractors/structured-extractor";

type Actor = {
  personId?: string | null;
  userId?: string | null;
  requestId?: string | null;
};

/**
 * Upload real de ficheiro → object storage + content_uploads + ingest_documents.
 * CSV/Excel/texto/PDF/foto. Extração é um passo separado (nunca confirma).
 */
export async function uploadIngestDocumentFile(
  deps: KernelDeps,
  input: {
    tenantId: string;
    kind: string;
    filename: string;
    bytes: Uint8Array | Buffer;
    actor?: Actor;
  },
) {
  const storage = createObjectStorageFromEnv();
  const stored = await storage.put({
    tenantId: input.tenantId,
    bytes: input.bytes,
  });
  const { upload } = await registerContentUpload(deps, {
    tenantId: input.tenantId,
    contentHash: stored.key,
    filename: input.filename,
    byteSize: stored.byteSize,
    correlationId: input.actor?.requestId ?? null,
  });
  const doc = await registerIngestDocument(deps, {
    tenantId: input.tenantId,
    kind: input.kind,
    filename: input.filename,
    contentUploadId: upload.id,
    contentHash: stored.key,
    actor: input.actor,
  });
  return { document: doc, upload, contentHash: stored.key };
}

/**
 * Lê bytes do object storage ligado ao documento e corre extractor StructuredExtraction.
 * PDF/foto passam pelo adapter OCR (stub em CI). Falha fraca → HUMAN REVIEW; nunca confirma.
 */
export async function extractDocumentFromStoredContent(
  deps: KernelDeps,
  input: { tenantId: string; documentId: string; actor?: Actor },
) {
  const [doc] = await deps.db
    .select()
    .from(ingestDocuments)
    .where(eq(ingestDocuments.id, input.documentId))
    .limit(1);
  if (!doc || doc.tenantId !== input.tenantId) {
    throw new DomainError("not_found", "Documento não encontrado", 404);
  }
  if (!doc.contentHash) {
    throw new DomainError(
      "no_content",
      "Documento sem ficheiro armazenado — use upload multipart ou contentHash",
      400,
    );
  }

  const storage = createObjectStorageFromEnv();
  const bytes = await storage.get({
    tenantId: input.tenantId,
    key: doc.contentHash,
  });

  let extraction;
  try {
    extraction = await extractStructuredFromBytes({
      bytes,
      filename: doc.filename,
      documentKind: doc.kind,
    });
  } catch (err) {
    if (err instanceof DomainError && err.code === "already_extracted") throw err;
    const message = err instanceof Error ? err.message : "extração falhou";
    await deps.db
      .update(ingestDocuments)
      .set({
        status: INGEST_DOCUMENT_STATUS.failed,
        error: message,
        processedAt: kernelNow(deps),
      })
      .where(eq(ingestDocuments.id, doc.id));
    throw err;
  }

  if (doc.kind === INGEST_DOCUMENT_KINDS.regulamento) {
    extraction.lines = extraction.lines.filter((l) => l.kind === EXTRACT_LINE_KINDS.fracao);
  }
  if (doc.kind === INGEST_DOCUMENT_KINDS.contactos) {
    extraction.lines = extraction.lines.filter((l) => l.kind === EXTRACT_LINE_KINDS.contacto);
  }
  if (doc.kind === INGEST_DOCUMENT_KINDS.ibanProof) {
    extraction.lines = extraction.lines.filter((l) => l.kind === EXTRACT_LINE_KINDS.iban);
  }

  if (extraction.lines.length === 0) {
    const message =
      "HUMAN REVIEW: extracção sem linhas utilizáveis para este tipo de documento. Nada foi confirmado nem enviado (ADR-017).";
    await deps.db
      .update(ingestDocuments)
      .set({
        status: INGEST_DOCUMENT_STATUS.failed,
        error: message,
        processedAt: kernelNow(deps),
      })
      .where(eq(ingestDocuments.id, doc.id));
    throw new DomainError("human_review", message, 400);
  }

  return extractDocumentLines(deps, {
    tenantId: input.tenantId,
    documentId: doc.id,
    extraction,
    actor: input.actor,
  });
}
