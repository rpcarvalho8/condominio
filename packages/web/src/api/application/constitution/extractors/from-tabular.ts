import * as XLSX from "xlsx";
import {
  EXTRACT_LINE_KINDS,
  type StructuredExtraction,
} from "../../../domain/constitution";
import { DomainError } from "../../../domain/errors";

function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols: string[] = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) {
        cols.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    cols.push(cur.trim());
    rows.push(cols);
  }
  return rows;
}

function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[\s_-]+/g, "");
}

function headerIndex(headers: string[], aliases: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const i = normalized.indexOf(normalizeHeader(alias));
    if (i >= 0) return i;
  }
  return -1;
}

function sheetToRows(bytes: Buffer, filename: string): { rows: string[][]; sourceLabel: string } {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    return { rows: parseCsvText(bytes.toString("utf8")), sourceLabel: "csv" };
  }
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
  throw new DomainError(
    "unsupported_format",
    "Formato não suportado neste extractor — use CSV ou Excel (.xlsx)",
    400,
  );
}

/**
 * Extracção determinística CSV/Excel → StructuredExtraction (sem LLM).
 * Frações: colunas codigo + permilagem (aliases PT/EN).
 * Contactos: fracaoCodigo + personName (+ email/phone/nif opcionais).
 */
export function extractStructuredFromTabular(input: {
  bytes: Buffer;
  filename: string;
  kindHint?: "fracao" | "contacto" | "auto";
}): StructuredExtraction {
  const { rows, sourceLabel } = sheetToRows(input.bytes, input.filename);
  if (rows.length < 2) {
    throw new DomainError("empty_extraction", "Ficheiro sem linhas de dados", 400);
  }
  const headers = rows[0]!;
  const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim()));

  const codigoIdx = headerIndex(headers, ["codigo", "código", "fracao", "fração", "code"]);
  const permIdx = headerIndex(headers, ["permilagem", "permil", "milessimas", "‰"]);
  const nameIdx = headerIndex(headers, [
    "personname",
    "nome",
    "proprietario",
    "proprietário",
    "titular",
  ]);
  const fracaoContactIdx = headerIndex(headers, [
    "fracaocodigo",
    "fracao",
    "fração",
    "codigofracao",
    "codigo",
  ]);
  const emailIdx = headerIndex(headers, ["email", "mail"]);
  const phoneIdx = headerIndex(headers, ["phone", "telefone", "telemovel", "telemóvel", "mobile"]);
  const nifIdx = headerIndex(headers, ["nif", "contribuinte"]);

  const hint = input.kindHint ?? "auto";
  const looksFracao = codigoIdx >= 0 && permIdx >= 0;
  const looksContacto = nameIdx >= 0 && (fracaoContactIdx >= 0 || codigoIdx >= 0);

  if (hint === "fracao" || (hint === "auto" && looksFracao && !looksContacto)) {
    if (!looksFracao) {
      throw new DomainError(
        "missing_columns",
        "CSV/Excel de frações exige colunas codigo e permilagem",
        400,
      );
    }
    const lines: StructuredExtraction["lines"] = [];
    for (const row of dataRows) {
      const codigo = String(row[codigoIdx] ?? "").trim();
      const permRaw = String(row[permIdx] ?? "").replace(",", ".").trim();
      const permilagem = Number(permRaw);
      if (!codigo || !Number.isFinite(permilagem)) continue;
      const excerpt = row.join(" | ");
      lines.push({
        kind: EXTRACT_LINE_KINDS.fracao,
        payload: { codigo, permilagem: Math.round(permilagem), tipo: "fracao" },
        sourceExcerpt: excerpt,
        confidence: 0.95,
      });
    }
    if (lines.length === 0) {
      throw new DomainError("empty_extraction", "Nenhuma fração válida no ficheiro", 400);
    }
    return { lines };
  }

  if (hint === "contacto" || (hint === "auto" && looksContacto)) {
    const fIdx = fracaoContactIdx >= 0 ? fracaoContactIdx : codigoIdx;
    if (nameIdx < 0 || fIdx < 0) {
      throw new DomainError(
        "missing_columns",
        "CSV/Excel de contactos exige colunas de fração e nome",
        400,
      );
    }
    const lines: StructuredExtraction["lines"] = [];
    for (const row of dataRows) {
      const fracaoCodigo = String(row[fIdx] ?? "").trim();
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

  throw new DomainError(
    "unrecognized_table",
    `Não foi possível inferir colunas em ${sourceLabel} — use cabeçalhos codigo/permilagem ou fração/nome`,
    400,
  );
}
