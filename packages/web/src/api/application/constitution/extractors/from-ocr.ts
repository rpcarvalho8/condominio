/**
 * OCR/LLM adapter for PDF binário e foto → StructuredExtraction.
 *
 * CI usa o stub determinístico (sem chave). Um endpoint HTTP opcional
 * (F1_OCR_ENDPOINT) pode substituir o stub em ambientes com provider.
 * Extração fraca → HUMAN REVIEW. Nunca auto-confirma nem envia convites (ADR-017).
 */
import {
  EXTRACT_LINE_KINDS,
  INGEST_DOCUMENT_KINDS,
  type StructuredExtraction,
} from "../../../domain/constitution";
import { DomainError } from "../../../domain/errors";
import { f1FileExtension } from "../f1-upload-guard";
import { canonicalizeIngestText } from "./canonicalize-ingest";
import type { LlmConstitutionChat } from "./from-llm-constitution";

export const OCR_HUMAN_REVIEW_MIN_CONFIDENCE = 0.4;

export type OcrRegion = {
  text: string;
  page?: number;
  region?: string;
  confidence?: number;
};

export type OcrRecognizeResult = {
  text: string;
  regions: OcrRegion[];
  provider: string;
};

export type OcrProvider = {
  readonly name: string;
  recognize(input: {
    bytes: Buffer;
    filename: string;
    mimeType?: string | null;
  }): Promise<OcrRecognizeResult>;
};

const VISUAL_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const VISUAL_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export function isVisualIngestFile(filename: string, mimeType?: string | null): boolean {
  const ext = f1FileExtension(filename);
  if (VISUAL_EXTENSIONS.has(ext)) return true;
  const mime = String(mimeType ?? "")
    .trim()
    .toLowerCase()
    .split(";")[0]!
    .trim();
  return VISUAL_MIMES.has(mime);
}

function humanReview(detail: string): DomainError {
  return new DomainError(
    "human_review",
    `HUMAN REVIEW: ${detail} Nada foi confirmado nem enviado (ADR-017).`,
    400,
  );
}

/** Pull printable / PDF-literal text from binary (deterministic stub; no API key). */
export function extractEmbeddedTextFromBytes(bytes: Buffer): string {
  const latin = bytes.toString("latin1");
  const utf8 = bytes.toString("utf8");
  const chunks: string[] = [];

  const pdfLit = /\((?:\\.|[^\\)]){2,}\)/g;
  for (const match of latin.matchAll(pdfLit)) {
    let inner = match[0]!.slice(1, -1);
    inner = inner
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\(.)/g, "$1");
    if (/[\p{L}\d‰@]/u.test(inner)) chunks.push(inner.trim());
  }

  const runs = utf8.replace(/\u0000/g, "\n").split(/[\x00-\x08\x0b\x0c\x0e-\x1f]+/);
  for (const run of runs) {
    const trimmed = run.replace(/[^\S\n]+/g, " ").trim();
    if (trimmed.length >= 3 && /[A-Za-zÀ-ÿ‰@\d]/.test(trimmed)) {
      chunks.push(trimmed);
    }
  }

  return chunks.join("\n");
}

export function createStubOcrProvider(): OcrProvider {
  return {
    name: "stub",
    async recognize(input) {
      const text = extractEmbeddedTextFromBytes(input.bytes).trim();
      const regions: OcrRegion[] = text
        ? text
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line, i) => ({
              text: line,
              page: 1,
              region: `stub:${i + 1}`,
              confidence: 0.55,
            }))
        : [];
      return { text, regions, provider: "stub" };
    },
  };
}

function createHttpOcrProvider(endpoint: string, apiKey: string | null): OcrProvider {
  return {
    name: "http",
    async recognize(input) {
      const form = new FormData();
      form.set(
        "file",
        new Blob([new Uint8Array(input.bytes)], {
          type: input.mimeType || "application/octet-stream",
        }),
        input.filename,
      );
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(endpoint, { method: "POST", body: form, headers });
      if (!res.ok) {
        throw humanReview(`provider OCR HTTP ${res.status}`);
      }
      const body = (await res.json().catch(() => ({}))) as {
        text?: string;
        regions?: OcrRegion[];
      };
      const text = String(body.text ?? "").trim();
      const regions = Array.isArray(body.regions) ? body.regions : [];
      return { text, regions, provider: "http" };
    },
  };
}

export function createOcrProviderFromEnv(): OcrProvider {
  const endpoint = String(process.env.F1_OCR_ENDPOINT ?? "").trim();
  if (endpoint) {
    const apiKey = String(process.env.F1_OCR_API_KEY ?? "").trim() || null;
    return createHttpOcrProvider(endpoint, apiKey);
  }
  return createStubOcrProvider();
}

function regionExcerpt(region: OcrRegion): string {
  const loc = [region.page != null ? `p.${region.page}` : null, region.region ?? null]
    .filter(Boolean)
    .join(" ");
  const text = region.text.trim();
  return loc ? `${loc}: ${text}` : text;
}

function extractIbansFromText(text: string, regions: OcrRegion[]): StructuredExtraction {
  const ibanRe = /\b([A-Z]{2}\d{2}[A-Z0-9]{10,30})\b/g;
  const seen = new Set<string>();
  const lines: StructuredExtraction["lines"] = [];
  for (const match of text.toUpperCase().matchAll(ibanRe)) {
    const iban = match[1]!;
    if (seen.has(iban)) continue;
    seen.add(iban);
    const region = regions.find((r) => r.text.toUpperCase().includes(iban));
    lines.push({
      kind: EXTRACT_LINE_KINDS.iban,
      payload: { iban },
      sourceExcerpt: region ? regionExcerpt(region) : match[0]!,
      confidence: region?.confidence ?? 0.5,
    });
  }
  if (lines.length === 0) {
    throw new DomainError("empty_extraction", "OCR sem IBAN reconhecível", 400);
  }
  return { lines };
}

async function parseOcrText(input: {
  text: string;
  regions: OcrRegion[];
  documentKind: string;
  llmChat?: LlmConstitutionChat | null;
}): Promise<StructuredExtraction> {
  const text = input.text.trim();
  if (!text) {
    throw humanReview("OCR/LLM não devolveu texto utilizável.");
  }

  if (input.documentKind === INGEST_DOCUMENT_KINDS.ibanProof) {
    try {
      return extractIbansFromText(text, input.regions);
    } catch {
      /* canonicalizar abaixo */
    }
  }

  try {
    return await canonicalizeIngestText({
      text,
      documentKind: input.documentKind,
      filename: "ocr.txt",
      llmChat: input.llmChat,
    });
  } catch (err) {
    if (err instanceof DomainError && err.code === "human_review") throw err;
    const msg = err instanceof Error ? err.message : "extração vazia";
    throw humanReview(`extracção OCR demasiado fraca (${msg}).`);
  }
}

function attachRegionExcerpts(
  extraction: StructuredExtraction,
  regions: OcrRegion[],
): StructuredExtraction {
  if (regions.length === 0) return extraction;
  return {
    lines: extraction.lines.map((line) => {
      const hit = regions.find((r) => {
        const payload = JSON.stringify(line.payload).toLowerCase();
        return r.text && payload.includes(r.text.trim().toLowerCase().slice(0, 12));
      }) ?? regions.find((r) => r.text.includes(String(line.sourceExcerpt).slice(0, 8)));
      const confidence =
        line.confidence != null
          ? Math.min(line.confidence, hit?.confidence ?? line.confidence)
          : hit?.confidence;
      return {
        ...line,
        sourceExcerpt: hit ? regionExcerpt(hit) : line.sourceExcerpt,
        confidence,
      };
    }),
  };
}

export function assertExtractionStrongEnough(extraction: StructuredExtraction): void {
  const lines = extraction.lines ?? [];
  if (lines.length === 0) {
    throw humanReview("nenhuma linha estruturada.");
  }
  const scored = lines.filter((l) => typeof l.confidence === "number");
  if (scored.length === lines.length) {
    const max = Math.max(...scored.map((l) => l.confidence ?? 0));
    if (max < OCR_HUMAN_REVIEW_MIN_CONFIDENCE) {
      throw humanReview(
        `confiança máxima ${max.toFixed(2)} < ${OCR_HUMAN_REVIEW_MIN_CONFIDENCE} (extração fraca).`,
      );
    }
  }
}

/**
 * PDF/foto → OCR provider → StructuredExtraction (substituível).
 * Nunca confirma linhas; o caller grava pending_review.
 */
export async function extractStructuredFromVisual(input: {
  bytes: Buffer;
  filename: string;
  documentKind: string;
  mimeType?: string | null;
  ocr?: OcrProvider;
  llmChat?: LlmConstitutionChat | null;
}): Promise<StructuredExtraction> {
  const ocr = input.ocr ?? createOcrProviderFromEnv();
  const recognized = await ocr.recognize({
    bytes: input.bytes,
    filename: input.filename,
    mimeType: input.mimeType,
  });
  const parsed = await parseOcrText({
    text: recognized.text,
    regions: recognized.regions,
    documentKind: input.documentKind,
    llmChat: input.llmChat,
  });
  const withExcerpts = attachRegionExcerpts(parsed, recognized.regions);
  assertExtractionStrongEnough(withExcerpts);
  return withExcerpts;
}
