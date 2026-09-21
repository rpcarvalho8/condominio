import * as XLSX from "xlsx";
import {
  EXTRACT_LINE_KINDS,
  type StructuredExtraction,
} from "../../../domain/constitution";
import { DomainError } from "../../../domain/errors";
import {
  fracaoCodigoKey,
  isPlausibleFracaoCodigo,
  normalizeFracaoCodigo,
  parsePermilagem,
} from "./permilagem";

export type TableDelimiter = "," | ";" | "\t" | "|";

function splitDelimitedLine(line: string, delimiter: TableDelimiter): string[] {
  if (delimiter === "|") {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((c) => c.trim());
  }
  const cols: string[] = [];
  let cur = "";
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === delimiter && !inQ) {
      cols.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

function modeNumber(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0] ?? 0;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

export function detectTableDelimiter(text: string): TableDelimiter | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[\s|:-]+$/.test(l))
    .slice(0, 16);
  if (lines.length < 2) return null;
  const candidates: TableDelimiter[] = ["\t", ";", ",", "|"];
  let best: { d: TableDelimiter; score: number } | null = null;
  for (const d of candidates) {
    const counts = lines.map((l) => splitDelimitedLine(l, d).filter(Boolean).length);
    const withCols = counts.filter((n) => n >= 2);
    if (withCols.length < 2) continue;
    const mode = modeNumber(counts);
    if (mode < 2) continue;
    const similar = counts.filter((c) => Math.abs(c - mode) <= 1).length;
    if (similar < counts.length * 0.6) continue;
    const score = similar / counts.length + mode * 0.02;
    if (!best || score > best.score) best = { d, score };
  }
  return best?.d ?? null;
}

export function looksLikeDelimitedTable(text: string): boolean {
  return detectTableDelimiter(text) != null;
}

function parseDelimitedText(text: string, delimiter: TableDelimiter): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^[\s|:-]+$/.test(line.trim())) continue;
    rows.push(splitDelimitedLine(line, delimiter));
  }
  return rows;
}

function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[\s_-]+/g, "")
    .replace(/[^\p{L}\p{N}%‰]/gu, "");
}

function headerIndex(headers: string[], aliases: string[]): number {
  const normalized = headers.map(normalizeHeader);
  const aliasNorm = aliases.map(normalizeHeader).filter(Boolean);
  for (const alias of aliasNorm) {
    const i = normalized.indexOf(alias);
    if (i >= 0) return i;
  }
  for (const alias of aliasNorm) {
    if (alias.length < 4) continue;
    const i = normalized.findIndex((h) => h.includes(alias) || (h.length >= 4 && alias.includes(h)));
    if (i >= 0) return i;
  }
  return -1;
}

export function tabularFileToPlainText(bytes: Buffer, filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const wb = XLSX.read(bytes, { type: "buffer" });
    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      if (!sheet) continue;
      parts.push(XLSX.utils.sheet_to_csv(sheet));
    }
    return parts.join("\n");
  }
  return bytes.toString("utf8");
}

function sheetToRows(bytes: Buffer, filename: string): { rows: string[][]; sourceLabel: string } {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const wb = XLSX.read(bytes, { type: "buffer" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new DomainError("empty_sheet", "Excel sem folhas", 400);
    const sheet = wb.Sheets[sheetName]!;
    const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
    }) as string[][];
    return {
      rows: matrix.map((r) => r.map((c) => String(c ?? "").trim())),
      sourceLabel: `excel:${sheetName}`,
    };
  }

  const text = bytes.toString("utf8");
  const delimiter = detectTableDelimiter(text) ?? ",";
  return { rows: parseDelimitedText(text, delimiter), sourceLabel: `text:${delimiter}` };
}

const CODIGO_ALIASES = [
  "codigo",
  "código",
  "fracao",
  "fração",
  "fraccao",
  "code",
  "unidade",
  "identificador",
  "idfracao",
  "nfracao",
  "numero",
  "fraction",
  "unit",
  "apartamento",
];

const PERM_ALIASES = [
  "permilagem",
  "permilagens",
  "permil",
  "milessimas",
  "milesimas",
  "milésimas",
  "‰",
  "coeficiente",
  "quotaparte",
  "quota-parte",
  "permillage",
  "share",
  "peso",
];

const NAME_ALIASES = [
  "personname",
  "nome",
  "proprietario",
  "proprietário",
  "titular",
  "condomino",
  "condómino",
  "owner",
  "name",
];

function dropLeadingTitle(rows: string[][]): string[][] {
  if (rows.length < 3) return rows;
  const first = rows[0]!;
  if (first.filter((c) => c.trim()).length === 1 && first[0]!.length > 12) {
    return rows.slice(1);
  }
  return rows;
}

function headerlessFracoes(dataRows: string[][]): StructuredExtraction | null {
  const lines: StructuredExtraction["lines"] = [];
  const seen = new Set<string>();
  for (const row of dataRows) {
    const cells = row.map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const codigo = normalizeFracaoCodigo(cells[0]!);
    let permilagem: number | null = null;
    for (let i = 1; i < cells.length; i++) {
      const parsed = parsePermilagem(cells[i]!);
      if (parsed != null) {
        permilagem = parsed;
        break;
      }
    }
    if (!codigo || permilagem == null) continue;
    const key = fracaoCodigoKey(codigo);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({
      kind: EXTRACT_LINE_KINDS.fracao,
      payload: { codigo, permilagem, tipo: "fracao" },
      sourceExcerpt: row.join(" | "),
      confidence: 0.8,
    });
  }
  if (lines.length < 2) return null;
  return { lines };
}

function headerlessContactos(dataRows: string[][]): StructuredExtraction | null {
  const lines: StructuredExtraction["lines"] = [];
  const seen = new Set<string>();
  for (const row of dataRows) {
    const cells = row.map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const fracaoCodigo = normalizeFracaoCodigo(cells[0]!);
    const emailCell = cells.find((c) => /@/.test(c)) ?? null;
    const nameCell =
      cells.find(
        (c, i) =>
          i > 0 &&
          c !== emailCell &&
          /[\p{L}]{2,}/u.test(c) &&
          !/^\d/.test(c),
      ) ?? null;
    if (!fracaoCodigo || !nameCell) continue;
    const key = `${fracaoCodigoKey(fracaoCodigo)}|${(emailCell ?? nameCell).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({
      kind: EXTRACT_LINE_KINDS.contacto,
      payload: {
        fracaoCodigo,
        personName: nameCell,
        email: emailCell,
        phone: cells.find((c) => /(?:\+351\s*)?9\d{8}/.test(c.replace(/\s/g, ""))) ?? null,
        nif: null,
      },
      sourceExcerpt: row.join(" | "),
      confidence: 0.78,
    });
  }
  if (lines.length === 0) return null;
  return { lines };
}

/**
 * Extracção determinística CSV/Excel/TSV/pipe → StructuredExtraction (sem LLM).
 * Frações: colunas codigo + permilagem (aliases PT/EN) ou tabela sem cabeçalho.
 * Contactos: fracaoCodigo + personName (+ email/phone/nif opcionais).
 */
export function extractStructuredFromTabular(input: {
  bytes: Buffer;
  filename: string;
  kindHint?: "fracao" | "contacto" | "auto";
}): StructuredExtraction {
  const { rows: rawRows, sourceLabel } = sheetToRows(input.bytes, input.filename);
  const rows = dropLeadingTitle(rawRows).filter((r) => r.some((c) => String(c).trim()));
  if (rows.length < 2) {
    throw new DomainError("empty_extraction", "Ficheiro sem linhas de dados", 400);
  }
  const headers = rows[0]!;
  const dataRows = rows.slice(1).filter((r) => r.some((c) => String(c).trim()));

  const codigoIdx = headerIndex(headers, CODIGO_ALIASES);
  const permIdx = headerIndex(headers, PERM_ALIASES);
  const nameIdx = headerIndex(headers, NAME_ALIASES);
  const fracaoContactIdx = headerIndex(headers, [
    "fracaocodigo",
    "fracao",
    "fração",
    "codigofracao",
    "codigo",
    "unidade",
  ]);
  const emailIdx = headerIndex(headers, ["email", "mail", "correio"]);
  const phoneIdx = headerIndex(headers, ["phone", "telefone", "telemovel", "telemóvel", "mobile"]);
  const nifIdx = headerIndex(headers, ["nif", "contribuinte"]);

  const hint = input.kindHint ?? "auto";
  const looksFracao = codigoIdx >= 0 && permIdx >= 0;
  const looksContacto = nameIdx >= 0 && (fracaoContactIdx >= 0 || codigoIdx >= 0);

  if (hint === "fracao" || (hint === "auto" && looksFracao && !looksContacto)) {
    if (looksFracao) {
      const lines: StructuredExtraction["lines"] = [];
      const seen = new Set<string>();
      for (const row of dataRows) {
        const codigo = normalizeFracaoCodigo(String(row[codigoIdx] ?? ""));
        const permilagem = parsePermilagem(row[permIdx]);
        if (!codigo || permilagem == null) continue;
        const key = fracaoCodigoKey(codigo);
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push({
          kind: EXTRACT_LINE_KINDS.fracao,
          payload: { codigo, permilagem, tipo: "fracao" },
          sourceExcerpt: row.join(" | "),
          confidence: 0.95,
        });
      }
      if (lines.length === 0) {
        throw new DomainError("empty_extraction", "Nenhuma fração válida no ficheiro", 400);
      }
      return { lines };
    }
  }

  if (hint === "contacto" || (hint === "auto" && looksContacto)) {
    const fIdx = fracaoContactIdx >= 0 ? fracaoContactIdx : codigoIdx;
    if (nameIdx >= 0 && fIdx >= 0) {
      const lines: StructuredExtraction["lines"] = [];
      for (const row of dataRows) {
        const fracaoCodigo = normalizeFracaoCodigo(String(row[fIdx] ?? ""));
        const personName = String(row[nameIdx] ?? "").trim();
        if (!fracaoCodigo || !personName) continue;
        lines.push({
          kind: EXTRACT_LINE_KINDS.contacto,
          payload: {
            fracaoCodigo,
            personName,
            email: emailIdx >= 0 ? String(row[emailIdx] ?? "").trim() || null : null,
            phone: phoneIdx >= 0 ? String(row[phoneIdx] ?? "").trim() || null : null,
            nif: nifIdx >= 0 ? String(row[nifIdx] ?? "").trim() || null : null,
          },
          sourceExcerpt: row.join(" | "),
          confidence: 0.9,
        });
      }
      if (lines.length === 0) {
        throw new DomainError("empty_extraction", "Nenhum contacto válido no ficheiro", 400);
      }
      return { lines };
    }
  }

  const allRows = [headers, ...dataRows].filter((r) =>
    r.some((c) => isPlausibleFracaoCodigo(String(c)) || parsePermilagem(c) != null),
  );
  if (hint !== "contacto") {
    const looseFracoes = headerlessFracoes(
      looksFracao || looksContacto ? dataRows : allRows,
    );
    if (looseFracoes && (hint === "fracao" || hint === "auto")) return looseFracoes;
  }
  if (hint !== "fracao") {
    const looseContactos = headerlessContactos(looksContacto ? dataRows : allRows);
    if (looseContactos) return looseContactos;
  }

  throw new DomainError(
    "unrecognized_table",
    `Não foi possível inferir colunas em ${sourceLabel} — use cabeçalhos codigo/permilagem ou fração/nome`,
    400,
  );
}
