import {
  EXTRACT_LINE_KINDS,
  type StructuredExtraction,
} from "../../../domain/constitution";
import { DomainError } from "../../../domain/errors";

/**
 * Extracção heurística de texto (PDF convertido a texto ou .txt).
 * Procura padrões "código — N‰" / "Fração X: N permilagem".
 * Fotos/OCR real ficam de fora deste slice.
 */
export function extractFracoesFromPlainText(text: string): StructuredExtraction {
  const lines: StructuredExtraction["lines"] = [];
  const patterns = [
    /(?:fra[cç][aã]o\s*)?([A-Za-z0-9\/\-]+)\s*[—\-–:]\s*(\d{1,4})\s*‰/gi,
    /(?:fra[cç][aã]o\s*)?([A-Za-z0-9\/\-]+)\s*[—\-–:]\s*(\d{1,4})\s*perm/gi,
  ];
  const seen = new Set<string>();
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const codigo = String(match[1] ?? "").trim();
      const permilagem = Number(match[2]);
      if (!codigo || !Number.isFinite(permilagem)) continue;
      const key = codigo.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const excerpt = match[0]!.trim();
      lines.push({
        kind: EXTRACT_LINE_KINDS.fracao,
        payload: { codigo, permilagem: Math.round(permilagem), tipo: "fracao" },
        sourceExcerpt: excerpt,
        confidence: 0.7,
      });
    }
  }
  if (lines.length === 0) {
    throw new DomainError(
      "empty_extraction",
      "Texto sem padrões de fração/permilagem reconhecíveis",
      400,
    );
  }
  return { lines };
}
