/**
 * Dispatcher StructuredExtraction — CSV/Excel/texto determinístico + OCR/LLM de PDF/foto.
 * O contrato de saída é sempre StructuredExtraction; o provider OCR é substituível.
 */
import { type StructuredExtraction } from "../../../domain/constitution";
import { DomainError } from "../../../domain/errors";
import { f1FileExtension } from "../f1-upload-guard";
import {
  createOcrProviderFromEnv,
  extractStructuredFromVisual,
  isVisualIngestFile,
  type OcrProvider,
} from "./from-ocr";
import { extractStructuredFromTabular } from "./from-tabular";
import { extractFracoesFromPlainText } from "./from-text";

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
}): Promise<StructuredExtraction> {
  const ext = f1FileExtension(input.filename);
  const isTabular = ext === ".csv" || ext === ".xlsx" || ext === ".xls";

  if (isTabular) {
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
  }

  if (ext === ".txt") {
    return extractFracoesFromPlainText(input.bytes.toString("utf8"));
  }

  if (isVisualIngestFile(input.filename, input.mimeType)) {
    return extractStructuredFromVisual({
      bytes: input.bytes,
      filename: input.filename,
      documentKind: input.documentKind,
      mimeType: input.mimeType,
      ocr: input.ocr ?? createOcrProviderFromEnv(),
    });
  }

  if (looksLikeUtf8Text(input.bytes)) {
    return extractFracoesFromPlainText(input.bytes.toString("utf8"));
  }

  throw new DomainError(
    "unsupported_extract",
    "Formato não suportado para extração — use CSV, Excel, texto, PDF ou imagem (JPEG/PNG/WebP/GIF)",
    400,
  );
}
