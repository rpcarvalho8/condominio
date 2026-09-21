/**
 * Fallback LLM (Groq) → StructuredExtraction canónico.
 * Consultivo: nunca confirma linhas nem envia convites (ADR-017).
 */
import {
  EXTRACT_LINE_KINDS,
  INGEST_DOCUMENT_KINDS,
  type StructuredExtraction,
} from "../../../domain/constitution";
import { DomainError } from "../../../domain/errors";
import { normalizeFracaoCodigo, parsePermilagem } from "./permilagem";

export type LlmConstitutionChat = (opts: { system: string; user: string }) => Promise<string>;

const MAX_INPUT_CHARS = 14_000;
const MAX_LLM_CONFIDENCE = 0.75;
const MIN_LINE_CONFIDENCE = 0.4;

const SYSTEM_PROMPT = `És um extractor de constituição de condomínio em Portugal.
Convertes texto de regulamento, mapa de permilagens, lista de condóminos ou comprovativo IBAN no contrato interno LUMEN.

Regras obrigatórias:
1. Responde APENAS JSON válido, sem markdown e sem texto extra.
2. Formato: {"lines":[ ... ]}
3. Cada linha é um de:
   {"kind":"fracao","codigo":"A","permilagem":600,"sourceExcerpt":"...","confidence":0.7}
   {"kind":"contacto","fracaoCodigo":"A","personName":"Maria Costa","email":"maria@x.pt","phone":null,"nif":null,"sourceExcerpt":"...","confidence":0.6}
   {"kind":"iban","iban":"PT50000201231234567890154","sourceExcerpt":"...","confidence":0.7}
4. permilagem é inteiro 1–1000 (soma típica do prédio = 1000). Converte: 0,6 e 0.6 → 600; 12,5% → 125; 600/1000 → 600; milésimas = permilagem.
5. Nunca inventes frações, nomes, emails ou IBANs que não estejam no texto.
6. sourceExcerpt é um excerto curto (≤180 chars) copiado ou parafraseado da origem.
7. confidence entre 0 e 1; a extracção é consultiva (um humano confirma depois).
8. Se o texto não tiver dados úteis, devolve {"lines":[]}.`;

export function isLlmExtractEnabled(): boolean {
  if (String(process.env.F1_LLM_EXTRACT ?? "1").trim() === "0") return false;
  return Boolean(String(process.env.GROQ_API_KEY ?? "").trim());
}

export async function defaultConstitutionLlmChat(opts: {
  system: string;
  user: string;
}): Promise<string> {
  const { groqChat } = await import("../../../lib/llm");
  return groqChat({
    system: opts.system,
    user: opts.user,
    temperature: 0,
    maxTokens: 2500,
    preferFast: true,
    label: "f1-constitution-extract",
  });
}

function kindFocus(documentKind: string): string {
  if (documentKind === INGEST_DOCUMENT_KINDS.contactos) {
    return "Prioriza linhas kind=contacto. Só inclui frações se o texto as listar explicitamente.";
  }
  if (documentKind === INGEST_DOCUMENT_KINDS.ibanProof) {
    return "Prioriza linhas kind=iban (IBAN da conta do condomínio).";
  }
  if (documentKind === INGEST_DOCUMENT_KINDS.regulamento) {
    return "Prioriza linhas kind=fracao (código + permilagem).";
  }
  return "Extrai frações e contactos se existirem no texto.";
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1]!.trim() : trimmed;
  const match = body.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clampConfidence(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0.55;
  const unit = n > 1 && n <= 100 ? n / 100 : n;
  return Math.min(MAX_LLM_CONFIDENCE, Math.max(0, unit));
}

function asLines(parsed: Record<string, unknown>): unknown[] {
  if (Array.isArray(parsed.lines)) return parsed.lines;
  if (Array.isArray(parsed.fracoes) || Array.isArray(parsed.contactos)) {
    return [...(Array.isArray(parsed.fracoes) ? parsed.fracoes : []), ...(Array.isArray(parsed.contactos) ? parsed.contactos : [])];
  }
  return [];
}

function excerptOf(raw: unknown, fallback: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return fallback.slice(0, 180);
  return s.slice(0, 180);
}

function mapLine(item: unknown, sourceText: string): StructuredExtraction["lines"][number] | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  const kind = String(row.kind ?? row.type ?? "").trim().toLowerCase();
  const confidence = clampConfidence(row.confidence);

  if (kind === EXTRACT_LINE_KINDS.fracao || kind === "fraction" || (row.codigo != null && row.permilagem != null)) {
    const codigo = normalizeFracaoCodigo(String(row.codigo ?? row.fracaoCodigo ?? row.fracao ?? ""));
    const permilagem = parsePermilagem(row.permilagem ?? row.permilagens ?? row.milessimas);
    if (!codigo || permilagem == null) return null;
    if (confidence < MIN_LINE_CONFIDENCE) return null;
    return {
      kind: EXTRACT_LINE_KINDS.fracao,
      payload: { codigo, permilagem, tipo: "fracao" },
      sourceExcerpt: excerptOf(row.sourceExcerpt ?? row.excerpt, `${codigo} ${permilagem}‰`),
      confidence,
    };
  }

  if (kind === EXTRACT_LINE_KINDS.contacto || kind === "contact" || row.personName != null || row.nome != null) {
    const fracaoCodigo = normalizeFracaoCodigo(
      String(row.fracaoCodigo ?? row.fracao_codigo ?? row.codigo ?? row.fracao ?? ""),
    );
    const personName = String(row.personName ?? row.person_name ?? row.nome ?? "").trim();
    if (!fracaoCodigo || !personName) return null;
    if (confidence < MIN_LINE_CONFIDENCE) return null;
    const emailRaw = String(row.email ?? "").trim();
    return {
      kind: EXTRACT_LINE_KINDS.contacto,
      payload: {
        fracaoCodigo,
        personName,
        email: emailRaw || null,
        phone: String(row.phone ?? row.telefone ?? "").trim() || null,
        nif: String(row.nif ?? "").trim() || null,
      },
      sourceExcerpt: excerptOf(row.sourceExcerpt ?? row.excerpt, `${fracaoCodigo} ${personName}`),
      confidence,
    };
  }

  if (kind === EXTRACT_LINE_KINDS.iban || row.iban != null) {
    const iban = String(row.iban ?? "")
      .replace(/\s+/g, "")
      .toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return null;
    if (confidence < MIN_LINE_CONFIDENCE) return null;
    return {
      kind: EXTRACT_LINE_KINDS.iban,
      payload: { iban },
      sourceExcerpt: excerptOf(row.sourceExcerpt ?? row.excerpt, iban),
      confidence,
    };
  }

  void sourceText;
  return null;
}

export async function extractConstitutionFromLlm(input: {
  text: string;
  documentKind: string;
  chat: LlmConstitutionChat;
}): Promise<StructuredExtraction> {
  const text = input.text.trim().slice(0, MAX_INPUT_CHARS);
  if (!text) {
    throw new DomainError("empty_extraction", "LLM: texto vazio", 400);
  }

  const raw = await input.chat({
    system: SYSTEM_PROMPT,
    user: `${kindFocus(input.documentKind)}\n\n--- documento ---\n${text}`,
  });
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    throw new DomainError("empty_extraction", "LLM: resposta não era JSON utilizável", 400);
  }

  const lines: StructuredExtraction["lines"] = [];
  const seen = new Set<string>();
  for (const item of asLines(parsed)) {
    const line = mapLine(item, text);
    if (!line) continue;
    const key = `${line.kind}:${JSON.stringify(line.payload)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }

  if (lines.length === 0) {
    throw new DomainError("empty_extraction", "LLM: nenhuma linha canónica no JSON", 400);
  }
  return { lines };
}
