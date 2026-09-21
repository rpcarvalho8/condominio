import {
  EXTRACT_LINE_KINDS,
  type StructuredExtraction,
} from "../../../domain/constitution";
import { DomainError } from "../../../domain/errors";
import {
  fracaoCodigoKey,
  normalizeFracaoCodigo,
  parsePermilagem,
} from "./permilagem";

const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+351\s*)?9\d{2}[\s.]?\d{3}[\s.]?\d{3}/;
const IBAN_RE = /\b([A-Z]{2}\d{2}[A-Z0-9]{10,30})\b/g;

const FRACAO_WORD = String.raw`fra[cç]{1,2}[aã]o(?:es)?`;
const CODIGO_TOKEN = String.raw`[A-Za-z0-9][A-Za-z0-9\/.\-ºª°]{0,18}`;
const PERMIL_TAIL = String.raw`(\d+(?:[.,]\d+)?(?:\s*/\s*\d+(?:[.,]\d+)?)?)\s*(‰|%|permilage(?:m|ns)|permil|mil[eé]ss?im[oa]s?|por\s*cento)?`;

function hasPermilUnit(excerpt: string): boolean {
  return /‰|%|permil|mil[eé]ss?im|\/\s*\d+|por\s*cento/i.test(excerpt);
}

function acceptFracaoSet(lines: StructuredExtraction["lines"]): boolean {
  if (lines.length === 0) return false;
  const sum = lines.reduce((acc, line) => acc + Number(line.payload.permilagem ?? 0), 0);
  const anyUnit = lines.some((l) => hasPermilUnit(l.sourceExcerpt));
  if (anyUnit) return true;
  if (lines.length >= 2 && sum >= 800 && sum <= 1200) return true;
  if (lines.length >= 3) return true;
  return false;
}

function pushFracao(
  lines: StructuredExtraction["lines"],
  seen: Set<string>,
  codigoRaw: string,
  permRaw: string,
  excerpt: string,
  confidence: number,
): void {
  const codigo = normalizeFracaoCodigo(codigoRaw);
  const permilagem = parsePermilagem(permRaw);
  if (!codigo || permilagem == null) return;
  const key = fracaoCodigoKey(codigo);
  if (seen.has(key)) return;
  seen.add(key);
  lines.push({
    kind: EXTRACT_LINE_KINDS.fracao,
    payload: { codigo, permilagem, tipo: "fracao" },
    sourceExcerpt: excerpt.trim().slice(0, 220),
    confidence,
  });
}

function extractFracoesByRegex(text: string): StructuredExtraction["lines"] {
  const lines: StructuredExtraction["lines"] = [];
  const seen = new Set<string>();
  const patterns: Array<{ re: RegExp; confidence: number }> = [
    {
      re: new RegExp(
        String.raw`(?:${FRACAO_WORD}|unidade|loja|garagem|apto\.?|apartamento)?\s*(${CODIGO_TOKEN})\s*[—\-–:]\s*${PERMIL_TAIL}`,
        "gi",
      ),
      confidence: 0.72,
    },
    {
      re: new RegExp(
        String.raw`(?:${FRACAO_WORD}|unidade)\s+(${CODIGO_TOKEN})\s+(?:tem|possui|corresponde(?:\s+a)?|com|:)?\s*${PERMIL_TAIL}`,
        "gi",
      ),
      confidence: 0.68,
    },
    {
      re: new RegExp(
        String.raw`\b(${CODIGO_TOKEN})\s+[:=]\s*${PERMIL_TAIL}`,
        "gi",
      ),
      confidence: 0.65,
    },
    {
      re: new RegExp(
        String.raw`\b(${CODIGO_TOKEN})\s+(\d+(?:[.,]\d+)?\s*/\s*\d+(?:[.,]\d+)?)`,
        "gi",
      ),
      confidence: 0.7,
    },
  ];

  for (const { re, confidence } of patterns) {
    for (const match of text.matchAll(re)) {
      const codigoRaw = String(match[1] ?? "");
      const permRaw = `${match[2] ?? ""}${match[3] ? ` ${match[3]}` : ""}`;
      pushFracao(lines, seen, codigoRaw, permRaw, match[0]!, confidence);
    }
  }
  return lines;
}

function codigoFromLeft(leftRaw: string): string | null {
  let left = leftRaw.trim().replace(/[—\-–:|;,\t]+$/g, "").trim();
  left = left.replace(/\s+(?:tem|possui|corresponde(?:\s+a)?|com)\s*$/i, "");
  const labeled = left.match(
    new RegExp(
      String.raw`(?:${FRACAO_WORD}|unidade|loja|garagem|apto\.?|apartamento)\s+([A-Za-z0-9\/.\-ºª°]+(?:\s+[A-Za-z0-9\/.\-ºª°]+)?)\s*$`,
      "i",
    ),
  );
  if (labeled?.[1]) return labeled[1];
  return left;
}

function isNoiseLine(line: string): boolean {
  return (
    /^%PDF/i.test(line) ||
    /\b(endobj|endstream|xref)\b/i.test(line) ||
    /^(BT|ET|Tj)\b/.test(line)
  );
}

function extractFracoesByLines(text: string): StructuredExtraction["lines"] {
  const lines: StructuredExtraction["lines"] = [];
  const seen = new Set<string>();
  const tailRe = new RegExp(`${PERMIL_TAIL}\\s*[.]?\\s*$`, "i");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > 240) continue;
    if (/^[\s|:-]+$/.test(line) || isNoiseLine(line)) continue;

    const unitMatch = line.match(tailRe);
    if (unitMatch && unitMatch.index != null && unitMatch.index > 0) {
      const permRaw = `${unitMatch[1] ?? ""}${unitMatch[2] ? ` ${unitMatch[2]}` : ""}`;
      const codigoRaw = codigoFromLeft(line.slice(0, unitMatch.index));
      if (codigoRaw) {
        pushFracao(
          lines,
          seen,
          codigoRaw,
          permRaw,
          line,
          hasPermilUnit(line) ? 0.7 : 0.55,
        );
        continue;
      }
    }

    const cols = line.split(/[|;,\t]+/).map((c) => c.trim()).filter(Boolean);
    if (cols.length >= 2) {
      const codigoRaw = cols[0]!;
      const permCol =
        cols.find((c, i) => i > 0 && parsePermilagem(c) != null) ?? cols[1]!;
      if (normalizeFracaoCodigo(codigoRaw) && parsePermilagem(permCol) != null) {
        pushFracao(
          lines,
          seen,
          codigoRaw,
          permCol,
          line,
          hasPermilUnit(line) ? 0.7 : 0.55,
        );
      }
    }
  }
  return lines;
}

/**
 * Extracção heurística de texto (PDF convertido, .txt, OCR stub, prosa irregular).
 * Canonicaliza para { codigo, permilagem } no modelo LUMEN.
 */
export function extractFracoesFromPlainText(text: string): StructuredExtraction {
  const byLine = extractFracoesByLines(text);
  const byRegex = extractFracoesByRegex(text);
  const merged: StructuredExtraction["lines"] = [];
  const seen = new Set<string>();
  for (const line of [...byLine, ...byRegex]) {
    const key = fracaoCodigoKey(String(line.payload.codigo ?? ""));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(line);
  }
  if (!acceptFracaoSet(merged)) {
    throw new DomainError(
      "empty_extraction",
      "Texto sem padrões de fração/permilagem reconhecíveis",
      400,
    );
  }
  return { lines: merged };
}

function looksLikePersonName(s: string): boolean {
  const t = s.trim();
  if (t.length < 3 || t.length > 80) return false;
  if (!/[\p{L}]{2,}/u.test(t)) return false;
  if (EMAIL_RE.test(t) || PHONE_RE.test(t)) return false;
  if (/^\d/.test(t) && t.length < 8) return false;
  return true;
}

function contactKey(fracaoCodigo: string, personName: string, email: string | null): string {
  return email
    ? `${fracaoCodigoKey(fracaoCodigo)}|${email.toLowerCase()}`
    : `${fracaoCodigoKey(fracaoCodigo)}|${personName.toLowerCase()}`;
}

/**
 * Contactos a partir de texto OCR/plain: "A — Nome — email@x.com", CSV-like, telefone PT.
 */
export function extractContactosFromPlainText(text: string): StructuredExtraction {
  const lines: StructuredExtraction["lines"] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const email = line.match(EMAIL_RE)?.[0] ?? null;
    const phoneMatch = line.match(PHONE_RE)?.[0] ?? null;
    const phone = phoneMatch ? phoneMatch.replace(/[\s.]/g, "") : null;
    const nifMatch = line.match(/\b[12356789]\d{8}\b/);
    const nif = nifMatch && nifMatch[0] !== phone ? nifMatch[0] : null;

    let rest = line
      .replace(EMAIL_RE, " ")
      .replace(PHONE_RE, " ")
      .replace(/\b[12356789]\d{8}\b/, " ")
      .replace(/\s+/g, " ")
      .trim();
    const parts = rest
      .split(/[—–|:;]+/)
      .map((p) => p.trim())
      .filter(Boolean);

    let fracaoCodigo: string | null = null;
    let personName: string | null = null;
    if (parts.length >= 2) {
      fracaoCodigo = normalizeFracaoCodigo(parts[0]!);
      personName = parts.slice(1).join(" ").trim() || null;
    } else if (parts.length === 1) {
      const tokens = parts[0]!.split(/\s+/);
      if (tokens.length >= 2) {
        fracaoCodigo = normalizeFracaoCodigo(tokens[0]!);
        personName = tokens.slice(1).join(" ");
      }
    }
    if (personName) {
      personName = personName.replace(/[,;]+/g, " ").replace(/\s+/g, " ").trim();
    }

    if (!fracaoCodigo || !personName || !looksLikePersonName(personName)) continue;
    if (!email && !phone && parts.length < 2) continue;

    const key = contactKey(fracaoCodigo, personName, email);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({
      kind: EXTRACT_LINE_KINDS.contacto,
      payload: {
        fracaoCodigo,
        personName,
        email,
        phone,
        nif,
      },
      sourceExcerpt: line.slice(0, 220),
      confidence: email ? 0.62 : 0.52,
    });
  }

  const patterns = [
    new RegExp(
      String.raw`(?:${FRACAO_WORD}\s*)?([A-Za-z0-9\/.\-ºª]+)\s*[—\-–:]\s*([^<\n,;]+?)\s*[—\-–,;<]\s*([\w.+-]+@[\w.-]+)`,
      "gi",
    ),
    new RegExp(
      String.raw`(?:${FRACAO_WORD}\s*)?([A-Za-z0-9\/.\-ºª]+)\s*[—\-–:]\s*([^\n,;]+?)\s+([\w.+-]+@[\w.-]+)`,
      "gi",
    ),
  ];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const fracaoCodigo = normalizeFracaoCodigo(String(match[1] ?? ""));
      const personName = String(match[2] ?? "").trim();
      const email = String(match[3] ?? "").trim() || null;
      if (!fracaoCodigo || !personName || !looksLikePersonName(personName)) continue;
      const key = contactKey(fracaoCodigo, personName, email);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({
        kind: EXTRACT_LINE_KINDS.contacto,
        payload: { fracaoCodigo, personName, email, phone: null, nif: null },
        sourceExcerpt: match[0]!.trim().slice(0, 220),
        confidence: 0.55,
      });
    }
  }

  if (lines.length === 0) {
    throw new DomainError(
      "empty_extraction",
      "Texto sem padrões de contacto reconhecíveis",
      400,
    );
  }
  return { lines };
}

export function extractIbansFromPlainText(text: string): StructuredExtraction {
  const seen = new Set<string>();
  const lines: StructuredExtraction["lines"] = [];
  for (const match of text.toUpperCase().matchAll(IBAN_RE)) {
    const iban = match[1]!;
    if (seen.has(iban)) continue;
    seen.add(iban);
    lines.push({
      kind: EXTRACT_LINE_KINDS.iban,
      payload: { iban },
      sourceExcerpt: match[0]!,
      confidence: 0.7,
    });
  }
  if (lines.length === 0) {
    throw new DomainError("empty_extraction", "Texto sem IBAN reconhecível", 400);
  }
  return { lines };
}
