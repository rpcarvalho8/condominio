/**
 * Dispatcher StructuredExtraction — CSV/Excel/texto determinístico + OCR/LLM de PDF/foto.
 * O contrato de saída é sempre StructuredExtraction; o provider OCR é substituível.
 * Texto irregular passa pela cascata de canonicalização (tabela → regex → LLM → human review).
 */
import { type StructuredExtraction } from "../../../domain/constitution";
import { DomainError } from "../../../domain/errors";
import { f1FileExtension } from "../f1-upload-guard";
import { canonicalizeIngestText } from "./canonicalize-ingest";
import type { LlmConstitutionChat } from "./from-llm-constitution";
import {
  createOcrProviderFromEnv,
  extractStructuredFromVisual,
  isVisualIngestFile,
  type OcrProvider,
} from "./from-ocr";
import { extractStructuredFromTabular, tabularFileToPlainText } from "./from-tabular";

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

export async function extractStructuredFromBytes(input: {
  bytes: Buffer;
  filename: string;
  documentKind: string;
  mimeType?: string | null;
  ocr?: OcrProvider;
  llmChat?: LlmConstitutionChat | null;
}): Promise<StructuredExtraction> {
  const ext = f1FileExtension(input.filename);
  const isTabular = ext === ".csv" || ext === ".xlsx" || ext === ".xls";
  const canonOpts = {
    documentKind: input.documentKind,
    filename: input.filename,
    llmChat: input.llmChat,
  };

  if (isTabular) {
    try {
      const hint =
        input.documentKind === "contactos"
          ? "contacto"
          : input.documentKind === "regulamento"
            ? "fracao"
            : "auto";
      return extractStructuredFromTabular({
        bytes: input.bytes,
        filename: input.filename,
        kindHint: hint,
      });
    } catch (err) {
      const text = tabularFileToPlainText(input.bytes, input.filename);
      if (text.trim()) {
        return canonicalizeIngestText({ ...canonOpts, text });
      }
      throw err;
    }
  }

  if (ext === ".txt") {
    return canonicalizeIngestText({
      ...canonOpts,
      text: input.bytes.toString("utf8"),
    });
  }

  if (isVisualIngestFile(input.filename, input.mimeType)) {
    return extractStructuredFromVisual({
      bytes: input.bytes,
      filename: input.filename,
      documentKind: input.documentKind,
      mimeType: input.mimeType,
      ocr: input.ocr ?? createOcrProviderFromEnv(),
      llmChat: input.llmChat,
    });
  }

  if (looksLikeUtf8Text(input.bytes)) {
    return canonicalizeIngestText({
      ...canonOpts,
      text: input.bytes.toString("utf8"),
    });
  }

  throw new DomainError(
    "unsupported_extract",
    "Formato não suportado para extração — use CSV, Excel, texto, PDF ou imagem (JPEG/PNG/WebP/GIF)",
    400,
  );
}
