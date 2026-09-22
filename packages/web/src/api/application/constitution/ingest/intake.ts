/**
 * Intake + Structure Discovery.
 * Primeiro: que linhas/células existem. Depois: tabela, chave-valor ou prosa.
 */
import * as XLSX from "xlsx";
import { f1FileExtension } from "../f1-upload-guard";
import { extractEmbeddedTextFromBytes, isVisualIngestFile } from "../extractors/from-ocr";
import {
  classifyHeader,
  type ColumnRole,
  pageMarker,
} from "./roles";

export type StructureRow = {
  line: number;
  page: number | null;
  text: string;
  cells: string[] | null;
  key: string | null;
  value: string | null;
  role: ColumnRole | null;
};

export type DiscoveredStructure = {
  representation: "table" | "key_value" | "prose" | "unknown";
  headers: string[] | null;
  rows: StructureRow[];
  sheet: string | null;
  text: string;
};

type NumberedLine = { line: number; page: number | null; text: string };

function emptyStructure(text: string): DiscoveredStructure {
  return { representation: "unknown", headers: null, rows: [], sheet: null, text };
}

function numberedLines(text: string): NumberedLine[] {
  const seen = new Set<string>();
  const out: NumberedLine[] = [];
  let page: number | null = null;
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed && seen.has(trimmed)) continue;
    if (trimmed) seen.add(trimmed);
    const marker = pageMarker(raw);
    if (marker != null) {
      page = marker;
      continue;
    }
    out.push({ line: i + 1, page, text: raw });
  }
  return out;
}

function splitComma(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
    } else current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function splitCells(line: string, delimiter: string): string[] {
  if (delimiter === ",") return splitComma(line);
  if (delimiter === "  ") {
    return line
      .trim()
      .split(/ {2,}/)
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
  }
  if (delimiter === "|") {
    let parts = line.split("|").map((cell) => cell.trim());
    if (parts[0] === "") parts = parts.slice(1);
    if (parts.length > 0 && parts[parts.length - 1] === "") parts = parts.slice(0, -1);
    return parts;
  }
  return line.split(delimiter).map((cell) => cell.trim());
}

function isSeparator(cells: string[]): boolean {
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{2,}:?$/.test(cell))
  );
}

function headerHasQuotaRoles(headers: string[]): boolean {
  const roles = headers.map(classifyHeader);
  const hasId = roles.includes("identifier");
  const hasValue = roles.some((role) => role === "permille" || role === "percent" || role === "ambiguous");
  return hasId && hasValue;
}

function tryKeyValue(lines: NumberedLine[]): DiscoveredStructure | null {
  const nonempty = lines.filter((row) => row.text.trim());
  if (nonempty.length < 2) return null;
  const matched: StructureRow[] = [];
  for (const row of nonempty) {
    const idx = row.text.indexOf(":");
    if (idx <= 0 || row.text.indexOf(":", idx + 1) !== -1) continue;
    const key = row.text.slice(0, idx).trim();
    const value = row.text.slice(idx + 1).trim();
    if (!key || !value) continue;
    const role = classifyHeader(key);
    if (role === "ignore") continue;
    matched.push({
      line: row.line,
      page: row.page,
      text: row.text.trim(),
      cells: null,
      key,
      value,
      role,
    });
  }
  if (matched.length < 2 || matched.length / nonempty.length < 0.5) return null;
  const roles = matched.map((row) => row.role);
  const hasId = roles.includes("identifier");
  const hasValue = roles.some((role) => role === "permille" || role === "percent" || role === "ambiguous");
  if (!hasId || !hasValue) return null;
  return {
    representation: "key_value",
    headers: null,
    rows: matched,
    sheet: null,
    text: lines.map((row) => row.text).join("\n"),
  };
}

function tryTable(lines: NumberedLine[]): DiscoveredStructure | null {
  const nonempty = lines.filter((row) => row.text.trim());
  let best: { width: number; rows: NumberedLine[] } | null = null;
  let bestCells: string[][] | null = null;
  for (const delimiter of [",", ";", "\t", "|", "  "]) {
    const parsed = nonempty.map((row) => ({ row, cells: splitCells(row.text, delimiter) }));
    const data = parsed.filter((item) => !isSeparator(item.cells) && item.cells.length >= 2);
    if (data.length < 2) continue;
    const widths = data.map((item) => item.cells.length);
    const width = widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)]!;
    const consistent = data.filter((item) => item.cells.length === width);
    if (consistent.length < 2 || consistent.length / data.length < 0.6) continue;
    const headers = consistent[0]!.cells;
    if (!headerHasQuotaRoles(headers)) continue;
    if (!best || consistent.length > best.rows.length) {
      best = { width, rows: consistent.map((item) => item.row) };
      bestCells = consistent.map((item) => item.cells);
    }
  }
  if (!best || !bestCells) return null;
  const headers = bestCells[0]!;
  const rows: StructureRow[] = bestCells.slice(1).map((cells, index) => {
    const source = best!.rows[index + 1]!;
    return {
      line: source.line,
      page: source.page,
      text: source.text.trim(),
      cells,
      key: null,
      value: null,
      role: null,
    };
  });
  return {
    representation: "table",
    headers,
    rows: rows.filter((row) => row.cells?.some((cell) => cell.trim())),
    sheet: null,
    text: lines.map((row) => row.text).join("\n"),
  };
}

export function discoverTextStructure(text: string): DiscoveredStructure {
  const lines = numberedLines(text);
  const nonempty = lines.filter((row) => row.text.trim());
  if (nonempty.length === 0) return emptyStructure(text);
  return (
    tryKeyValue(lines) ??
    tryTable(lines) ?? {
      representation: "prose",
      headers: null,
      rows: nonempty.map((row) => ({
        line: row.line,
        page: row.page,
        text: row.text.trim(),
        cells: null,
        key: null,
        value: null,
        role: null,
      })),
      sheet: null,
      text,
    }
  );
}

function discoverWorkbook(bytes: Buffer): DiscoveredStructure {
  const workbook = XLSX.read(bytes, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return emptyStructure("");
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return emptyStructure("");
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
  }) as string[][];
  const lines = matrix.map((row, index) => ({
    line: index + 1,
    page: null as number | null,
    text: row.map((cell) => String(cell ?? "").trim()).filter(Boolean).join(" | "),
  }));
  const text = lines.map((row) => row.text).join("\n");
  const nonempty = lines.filter((row) => row.text.trim());
  if (nonempty.length === 0) return emptyStructure(text);
  const headerCells = matrix[0]?.map((cell) => String(cell ?? "").trim()) ?? [];
  while (headerCells.length > 0 && headerCells[headerCells.length - 1] === "") headerCells.pop();
  if (!headerHasQuotaRoles(headerCells)) {
    const prose = discoverTextStructure(text);
    return { ...prose, sheet: sheetName };
  }
  const rows: StructureRow[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const cells = (matrix[i] ?? []).map((cell) => String(cell ?? "").trim());
    while (cells.length > headerCells.length) cells.pop();
    while (cells.length < headerCells.length) cells.push("");
    if (!cells.some((cell) => cell)) continue;
    rows.push({
      line: i + 1,
      page: null,
      text: cells.filter(Boolean).join(" | "),
      cells,
      key: null,
      value: null,
      role: null,
    });
  }
  return {
    representation: "table",
    headers: headerCells,
    rows,
    sheet: sheetName,
    text,
  };
}

export function discoverDocument(input: { bytes: Buffer; filename: string }): DiscoveredStructure {
  const ext = f1FileExtension(input.filename);
  if (ext === ".xlsx" || ext === ".xls") return discoverWorkbook(input.bytes);
  const text = isVisualIngestFile(input.filename)
    ? extractEmbeddedTextFromBytes(input.bytes)
    : input.bytes.toString("utf8");
  return discoverTextStructure(text);
}
