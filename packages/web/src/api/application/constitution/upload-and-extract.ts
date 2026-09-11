import { eq } from "drizzle-orm";
import { ingestDocuments } from "../../database/schema";
import {
  EXTRACT_LINE_KINDS,
  INGEST_DOCUMENT_KINDS,
  type StructuredExtraction,
} from "../../domain/constitution";
import { DomainError } from "../../domain/errors";
import { readContentBlob, storeContentBlob } from "../../infra/content-blob-store";
import type { KernelDeps } from "../../infra/kernel-deps";
import { registerContentUpload } from "../uploads/register-content-upload";
import { extractDocumentLines, registerIngestDocument } from "./f1-constitution";
import { extractStructuredFromTabular } from "./extractors/from-tabular";
import { extractFracoesFromPlainText } from "./extractors/from-text";

type Actor = {
  personId?: string | null;
  userId?: string | null;
  requestId?: string | null;
};

/**
 * Upload real de ficheiro → content blob + content_uploads + ingest_documents.
 * Cumpre o critério F1 “admin sobe PDF/Excel/foto” no caminho Excel/CSV/texto
 * (foto/OCR e LLM real ficam para adaptador seguinte).
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
  const stored = await storeContentBlob({
    tenantId: input.tenantId,
    bytes: input.bytes,
  });
  const { upload } = await registerContentUpload(deps, {
    tenantId: input.tenantId,
    contentHash: stored.contentHash,
    filename: input.filename,
    byteSize: stored.byteSize,
    correlationId: input.actor?.requestId ?? null,
  });
  const doc = await registerIngestDocument(deps, {
    tenantId: input.tenantId,
    kind: input.kind,
    filename: input.filename,
    contentUploadId: upload.id,
    contentHash: stored.contentHash,
    actor: input.actor,
  });
  return { document: doc, upload, contentHash: stored.contentHash };
}

function buildExtractionFromBytes(input: {
  bytes: Buffer;
  filename: string;
  documentKind: string;
}): StructuredExtraction {
  const lower = input.filename.toLowerCase();
  const isTabular =
    lower.endsWith(".csv") ||
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    lower.endsWith(".txt");

  if (isTabular && (lower.endsWith(".csv") || lower.endsWith(".xlsx") || lower.endsWith(".xls"))) {
    const hint =
      input.documentKind === INGEST_DOCUMENT_KINDS.contactos
        ? "contacto"
        : input.documentKind === INGEST_DOCUMENT_KINDS.regulamento
          ? "fracao"
          : "auto";
    return extractStructuredFromTabular({
      bytes: input.bytes,
      filename: input.filename,
      kindHint: hint,
    });
  }

  if (lower.endsWith(".txt") || looksLikeUtf8Text(input.bytes)) {
    return extractFracoesFromPlainText(input.bytes.toString("utf8"));
  }

  throw new DomainError(
    "unsupported_extract",
    "Extração automática neste slice: CSV, Excel ou texto com padrões de permilagem. PDF binário/foto/OCR = adaptador LLM seguinte.",
    400,
  );
}

function looksLikeUtf8Text(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 512));
  let weird = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 7 || (b > 13 && b < 32)) weird++;
  }
  return weird / sample.length < 0.05;
}

/**
 * Lê bytes do content blob ligado ao documento e corre extractor determinístico.
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

  const bytes = readContentBlob({
    tenantId: input.tenantId,
    contentHash: doc.contentHash,
  });
  const extraction = buildExtractionFromBytes({
    bytes,
    filename: doc.filename,
    documentKind: doc.kind,
  });

  // Garantir que regulamento só produz frações neste caminho automático
  if (doc.kind === INGEST_DOCUMENT_KINDS.regulamento) {
    extraction.lines = extraction.lines.filter((l) => l.kind === EXTRACT_LINE_KINDS.fracao);
  }
  if (doc.kind === INGEST_DOCUMENT_KINDS.contactos) {
    extraction.lines = extraction.lines.filter((l) => l.kind === EXTRACT_LINE_KINDS.contacto);
  }

  return extractDocumentLines(deps, {
    tenantId: input.tenantId,
    documentId: doc.id,
    extraction,
    actor: input.actor,
  });
}
