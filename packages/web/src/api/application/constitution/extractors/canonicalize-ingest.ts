/**
 * Cascata de canonicalização F1: qualquer layout de origem → StructuredExtraction LUMEN.
 *
 * 1. Tabela delimitada (CSV/TSV/pipe/; )
 * 2. Padrões alargados de fração/contacto/IBAN
 * 3. LLM (Groq) se GROQ_API_KEY — consultivo
 * 4. HUMAN REVIEW — nunca auto-confirma, nunca envia convites (ADR-017)
 */
import {
  INGEST_DOCUMENT_KINDS,
  type StructuredExtraction,
} from "../../../domain/constitution";
import { DomainError } from "../../../domain/errors";
import {
  defaultConstitutionLlmChat,
  extractConstitutionFromLlm,
  isLlmExtractEnabled,
  type LlmConstitutionChat,
} from "./from-llm-constitution";
import {
  extractStructuredFromTabular,
  looksLikeDelimitedTable,
} from "./from-tabular";
import {
  extractContactosFromPlainText,
  extractFracoesFromPlainText,
  extractIbansFromPlainText,
} from "./from-text";

export function ingestHumanReview(detail: string): DomainError {
  const trimmed = detail.trim().replace(/\.+$/, "");
  return new DomainError(
    "human_review",
    `HUMAN REVIEW: ${trimmed}. Nada foi confirmado nem enviado (ADR-017).`,
    400,
  );
}

function messageOf(err: unknown): string {
  if (err instanceof DomainError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function kindHintFromDocument(
  documentKind: string,
): "fracao" | "contacto" | "auto" {
  if (documentKind === INGEST_DOCUMENT_KINDS.contactos) return "contacto";
  if (documentKind === INGEST_DOCUMENT_KINDS.regulamento) return "fracao";
  return "auto";
}

function tryExtractor(label: string, run: () => StructuredExtraction): StructuredExtraction | string {
  try {
    const extraction = run();
    if (extraction.lines.length > 0) return extraction;
    return `${label}: vazio`;
  } catch (err) {
    if (err instanceof DomainError && err.code === "human_review") throw err;
    return `${label}: ${messageOf(err)}`;
  }
}

/**
 * Normaliza texto bruto (ficheiro .txt, CSV irregular, OCR, prosa) para o contrato F1.
 * O caller grava sempre pending_review — esta função não confirma.
 */
export async function canonicalizeIngestText(input: {
  text: string;
  documentKind: string;
  filename?: string;
  /** undefined = Groq se a env permitir; null = nunca chamar LLM (testes). */
  llmChat?: LlmConstitutionChat | null;
}): Promise<StructuredExtraction> {
  const text = input.text.replace(/\u0000/g, "\n").trim();
  if (!text) {
    throw ingestHumanReview("documento sem texto utilizável");
  }

  const errors: string[] = [];
  const kindHint = kindHintFromDocument(input.documentKind);

  if (input.documentKind === INGEST_DOCUMENT_KINDS.ibanProof) {
    const ibans = tryExtractor("iban", () => extractIbansFromPlainText(text));
    if (typeof ibans !== "string") return ibans;
    errors.push(ibans);
  } else {
    if (looksLikeDelimitedTable(text)) {
      const tabular = tryExtractor("tabela", () =>
        extractStructuredFromTabular({
          bytes: Buffer.from(text, "utf8"),
          filename: "canonical.csv",
          kindHint,
        }),
      );
      if (typeof tabular !== "string") return tabular;
      errors.push(tabular);
    }

    if (kindHint === "contacto") {
      const contactos = tryExtractor("contactos", () => extractContactosFromPlainText(text));
      if (typeof contactos !== "string") return contactos;
      errors.push(contactos);
    } else {
      const fracoes = tryExtractor("fracoes", () => extractFracoesFromPlainText(text));
      if (typeof fracoes !== "string") return fracoes;
      errors.push(fracoes);
      if (kindHint === "auto") {
        const contactos = tryExtractor("contactos", () => extractContactosFromPlainText(text));
        if (typeof contactos !== "string") return contactos;
        errors.push(contactos);
      }
    }
  }

  const chat =
    input.llmChat === undefined
      ? isLlmExtractEnabled()
        ? defaultConstitutionLlmChat
        : null
      : input.llmChat;

  if (chat) {
    try {
      const llm = await extractConstitutionFromLlm({
        text,
        documentKind: input.documentKind,
        chat,
      });
      if (llm.lines.length > 0) return llm;
      errors.push("llm: vazio");
    } catch (err) {
      errors.push(`llm: ${messageOf(err)}`);
    }
  }

  throw ingestHumanReview(
    `não foi possível canonicalizar este documento para o modelo LUMEN (${
      errors.slice(-2).join("; ") || "layout não reconhecido"
    })`,
  );
}
