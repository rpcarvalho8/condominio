/**
 * Léxico de papéis (que informação é esta?), não padrões de formato de documento.
 */

export type ColumnRole =
  | "identifier"
  | "designation"
  | "permille"
  | "percent"
  | "ambiguous"
  | "ignore";

export type UnitCue = "permille" | "percent" | "ambiguous" | "unknown";

const PERMILLE_TERMS = [
  "permilagem",
  "permil",
  "permille",
  "per mille",
  "milesimas",
  "milesima",
  "por mil",
  "thousandths",
  "thousandth",
];

const PERCENT_TERMS = ["percentagem", "percent", "percentual", "pct"];

const AMBIGUOUS_TERMS = [
  "valor",
  "quota",
  "quota parte",
  "quotaparte",
  "partes",
  "value",
  "amount",
  "montante",
  "peso",
];

const ID_TERMS = [
  "codigo",
  "code",
  "fraccao",
  "fracao",
  "unidade",
  "unit",
  "letra",
  "lote",
  "apartamento",
  "apartment",
  "apt",
  "fraction",
];

const DESIGNATION_TERMS = ["designacao", "descricao", "nome", "titulo"];

export const LABEL_WORDS = new Set([
  "fracao",
  "fraccao",
  "unidade",
  "unit",
  "letra",
  "lote",
  "apartamento",
  "apartment",
  "apt",
  "codigo",
  "code",
  "fraction",
]);

/** Palavras de tipo/descrição — não são códigos de unidade. */
const TYPE_WORDS = new Set([
  "hab",
  "habitacao",
  "loja",
  "garagem",
  "lugar",
  "bloco",
  "zona",
]);

const STOP_WORDS = new Set([
  ...LABEL_WORDS,
  ...TYPE_WORDS,
  "autonoma",
  "autonomo",
  "designada",
  "designado",
  "pela",
  "pelo",
  "corresponde",
  "correspondem",
  "milesimas",
  "milesima",
  "permilagem",
  "permille",
  "percentagem",
  "percent",
  "thousandths",
  "thousandth",
  "per",
  "mille",
  "mil",
  "the",
  "has",
  "accounts",
  "for",
  "of",
  "building",
  "com",
  "para",
  "em",
  "no",
  "na",
  "do",
  "da",
  "de",
  "dos",
  "das",
  "que",
  "um",
  "uma",
  "os",
  "as",
  "se",
  "ao",
  "aos",
  "por",
  "pagina",
  "page",
  "original",
  "valor",
  "quota",
  "preencher",
  "total",
  "predio",
  "edificio",
]);

export function fold(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasTerm(folded: string, terms: string[]): boolean {
  const padded = ` ${folded} `;
  return terms.some((term) => folded === term || padded.includes(` ${term} `));
}

export function classifyHeader(raw: string): ColumnRole {
  const folded = fold(raw);
  if (!folded) return "ignore";
  if (raw.includes("‰") || hasTerm(folded, PERMILLE_TERMS)) return "permille";
  if (raw.includes("%") || hasTerm(folded, PERCENT_TERMS)) return "percent";
  if (hasTerm(folded, AMBIGUOUS_TERMS)) return "ambiguous";
  if (hasTerm(folded, ID_TERMS)) return "identifier";
  if (hasTerm(folded, DESIGNATION_TERMS)) return "designation";
  return "ignore";
}

export function cueInText(text: string): UnitCue {
  if (text.includes("‰")) return "permille";
  const folded = fold(text);
  if (
    hasTerm(folded, PERMILLE_TERMS) ||
    /mil[eé]sim/i.test(text) ||
    /per\s+mille/i.test(text) ||
    /thousandth/i.test(text) ||
    /por\s+mil/i.test(text)
  ) {
    return "permille";
  }
  if (hasTerm(folded, PERCENT_TERMS) || /\d+(?:[.,]\d+)?\s*%/.test(text)) return "percent";
  return "unknown";
}

export function columnCue(role: ColumnRole): UnitCue {
  if (role === "permille") return "permille";
  if (role === "percent") return "percent";
  if (role === "ambiguous") return "ambiguous";
  return "unknown";
}

export function findNumbers(text: string): Array<{ raw: string; value: number; index: number }> {
  const out: Array<{ raw: string; value: number; index: number }> = [];
  for (const match of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const raw = match[0]!;
    const value = Number(raw.replace(",", "."));
    if (!Number.isFinite(value)) continue;
    out.push({ raw, value, index: match.index ?? 0 });
  }
  return out;
}

export function bestNumber(text: string): { raw: string; value: number } | null {
  const nums = findNumbers(text);
  if (nums.length === 0) return null;
  if (nums.length === 1) return nums[0]!;
  const anchors: number[] = [];
  for (const match of text.matchAll(/‰|%|mil[eé]sim\w*|permil\w*|per\s*mille|percent\w*|thousandth\w*|por\s+mil/gi)) {
    anchors.push(match.index ?? 0);
  }
  if (anchors.length === 0) {
    // Linha "código … valor": preferir o último número, sobretudo se tiver decimais.
    const decimals = nums.filter((n) => /[.,]\d+/.test(n.raw));
    if (decimals.length > 0) return decimals[decimals.length - 1]!;
    return nums[nums.length - 1]!;
  }
  let best = nums[0]!;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const num of nums) {
    for (const anchor of anchors) {
      const dist = Math.abs(num.index - anchor);
      if (dist < bestDist) {
        bestDist = dist;
        best = num;
      }
    }
  }
  return best;
}

export function tokenize(line: string): string[] {
  return line
    .replace(/[‰%]/g, " ")
    .split(/[^\p{L}\p{N}/]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isCodeToken(token: string): boolean {
  if (!token || token.length > 8) return false;
  if (/^\d+(?:[.,]\d+)?$/.test(token)) return false;
  const folded = fold(token);
  if (STOP_WORDS.has(folded)) return false;
  return /^[\p{L}\p{N}]+(?:\/[\p{L}\p{N}]+)?$/u.test(token) && /\p{L}/u.test(token);
}

/** Após «fracção»/«letra», o identificador é curto (A, AA) ou contém dígitos — não uma palavra corrente. */
function isLabelBoundCode(token: string): boolean {
  if (!isCodeToken(token)) return false;
  return token.length <= 3 || /\d/.test(token);
}

export function selectCodigo(tokens: string[]): { codigo: string | null; ambiguous: boolean } {
  const labelHits: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!LABEL_WORDS.has(fold(tokens[i]!))) continue;
    const next = tokens[i + 1]!;
    if (isLabelBoundCode(next)) labelHits.push(next);
  }
  if (labelHits.length > 0) {
    const distinct = new Set(labelHits.map((token) => fold(token)));
    if (distinct.size === 1) return { codigo: labelHits[0]!, ambiguous: false };
    return { codigo: null, ambiguous: true };
  }
  const codes = tokens.filter(isCodeToken);
  const distinct = new Set(codes.map((token) => fold(token)));
  if (distinct.size === 1) return { codigo: codes[0]!, ambiguous: false };
  if (distinct.size === 0) return { codigo: null, ambiguous: false };
  // Padrão genérico "ID descrição valor": o primeiro código curto costuma ser o identificador.
  const first = codes[0]!;
  if (first.length <= 3) return { codigo: first, ambiguous: false };
  return { codigo: null, ambiguous: true };
}

/** Cabeçalho de documento/coluna indica permilagem (‰) mesmo que a linha não traga o símbolo. */
export function documentHasPermilleCue(text: string): boolean {
  if (text.includes("‰")) return true;
  return /permilagem/i.test(text) || /mil[eé]simas?/i.test(text);
}

export function parseLooseNumber(raw: string): number | null {
  const trimmed = raw.trim().replace(/[‰%\s]/g, "");
  if (!trimmed) return null;
  const normalized = trimmed.replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function pageMarker(line: string): number | null {
  const match = /^\s*(?:p[aá]gina|page)\s+(\d+)\s*$/i.exec(line);
  if (!match) return null;
  const page = Number(match[1]);
  return Number.isFinite(page) ? page : null;
}
