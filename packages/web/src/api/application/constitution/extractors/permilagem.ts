/**
 * Canonicaliza códigos de fração e permilagens para o modelo interno LUMEN (1–1000‰).
 * Independente do layout de origem (‰, milésimas, %, 0,6, 600/1000).
 */

const CODIGO_STOPWORDS = new Set([
  "fracao",
  "fraccao",
  "fracoes",
  "fraccoes",
  "total",
  "soma",
  "subtotal",
  "permilagem",
  "permilagens",
  "permil",
  "milesimas",
  "milessimas",
  "codigo",
  "code",
  "unidade",
  "tipo",
  "nome",
  "email",
  "telefone",
  "telemovel",
  "nif",
  "proprietario",
  "titular",
  "contacto",
  "contactos",
  "mapa",
  "regulamento",
  "tabela",
  "artigo",
  "clausula",
  "nota",
  "obs",
  "observacoes",
  "descricao",
  "coeficiente",
  "quotaparte",
  "header",
  "coluna",
]);

function fold(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[\s_-]+/g, "");
}

function toNumber(raw: string): number {
  const s = raw.trim().replace(/\s+/g, "").replace(",", ".");
  return Number(s);
}

function clampPermil(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > 1000) return null;
  return rounded;
}

/**
 * Aceita 600, 600‰, 600 permilagens, 125 milésimas, 600/1000, 0.6, 0,6, 12,5%.
 */
export function parsePermilagem(raw: unknown): number | null {
  if (raw == null) return null;
  const original = String(raw).trim();
  if (!original) return null;

  const isPercent = /%|por\s*cento|percent/i.test(original);
  const hasDecimalSep = /[.,]/.test(original.replace(/\s/g, ""));

  let s = original
    .replace(/[‰%]/g, " ")
    .replace(
      /\b(permilage(?:m|ns)|permil|mil[eé]ss?im[oa]s?|coeficientes?|quota-?\s*partes?|por\s*cento|percent(?:age)?)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();

  const frac = s.match(/^(-?\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)$/);
  if (frac) {
    const n = toNumber(frac[1]!);
    const d = toNumber(frac[2]!);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
    return clampPermil((n / d) * 1000);
  }

  const n = toNumber(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (isPercent) return clampPermil(n * 10);
  if (n < 1) return clampPermil(n * 1000);
  if (n === 1 && hasDecimalSep) return 1000;
  return clampPermil(n);
}

export function isPlausibleFracaoCodigo(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 1 || t.length > 32) return false;
  if (t.includes("%") || t.includes("@")) return false;
  if (/^(pdf|obj|endobj|stream|tj|et|bt|eof|type|font|endstream)$/i.test(fold(t))) return false;
  if (t.startsWith("%")) return false;
  if (CODIGO_STOPWORDS.has(fold(t))) return false;
  if (!/[A-Za-z0-9]/.test(t)) return false;
  if (/^\d{4,}$/.test(t)) return false;
  if (/^[\d.,]+$/.test(t) && Number(t.replace(",", ".")) > 32) return false;
  return true;
}

/** Remove o prefixo "Fração/Unidade"; conserva Loja/Garagem/1.º Esq. */
export function normalizeFracaoCodigo(raw: string): string | null {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/^(?:fra[cç]{1,2}[aã]o(?:es)?|unidade)\s+/i, "");
  s = s.replace(/[.,;:]+$/g, "").trim();
  if (!s || !isPlausibleFracaoCodigo(s)) return null;
  return s;
}

export function fracaoCodigoKey(codigo: string): string {
  return codigo
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ");
}
