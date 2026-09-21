/**
 * Semantic Extraction — observações, ainda não valores canónicos.
 * Não decide permilagem final nem confirma nada.
 */
import type { DiscoveredStructure, StructureRow } from "./intake";
import {
  bestNumber,
  classifyHeader,
  columnCue,
  cueInText,
  LABEL_WORDS,
  parseLooseNumber,
  selectCodigo,
  tokenize,
  type ColumnRole,
  type UnitCue,
} from "./roles";

export type Observation = {
  codigo: string | null;
  ambiguousIdentifier: boolean;
  designation: string;
  valueRaw: string | null;
  valueNumber: number | null;
  unitCue: UnitCue;
  page: number | null;
  line: number;
  cell: string | null;
  rowText: string;
};

function roleIndex(headers: string[], role: ColumnRole): number {
  return headers.findIndex((header) => classifyHeader(header) === role);
}

function fromTable(structure: DiscoveredStructure): Observation[] {
  const headers = structure.headers ?? [];
  const idIdx = roleIndex(headers, "identifier");
  const designationIdx = roleIndex(headers, "designation");
  const permilleIdx = roleIndex(headers, "permille");
  const percentIdx = roleIndex(headers, "percent");
  const ambiguousIdx = roleIndex(headers, "ambiguous");
  const valueIdx = permilleIdx >= 0 ? permilleIdx : percentIdx >= 0 ? percentIdx : ambiguousIdx;
  const columnRole: ColumnRole =
    permilleIdx >= 0 ? "permille" : percentIdx >= 0 ? "percent" : ambiguousIdx >= 0 ? "ambiguous" : "ignore";

  const observations: Observation[] = [];
  for (const row of structure.rows) {
    const cells = row.cells ?? [];
    const codigo = idIdx >= 0 ? (cells[idIdx] ?? "").trim() : "";
    if (!codigo) continue;
    const valueRaw = valueIdx >= 0 ? (cells[valueIdx] ?? "").trim() : "";
    const cellCue = valueRaw ? cueInText(valueRaw) : "unknown";
    const unitCue = cellCue !== "unknown" ? cellCue : columnCue(columnRole);
    const parsed = valueRaw ? parseLooseNumber(valueRaw) : null;
    observations.push({
      codigo,
      ambiguousIdentifier: false,
      designation:
        designationIdx >= 0 && cells[designationIdx]?.trim()
          ? cells[designationIdx]!.trim()
          : cells.join(" | "),
      valueRaw: valueRaw || null,
      valueNumber: parsed,
      unitCue,
      page: row.page,
      line: row.line,
      cell: valueIdx >= 0 ? headers[valueIdx] ?? null : null,
      rowText: cells.join(" | "),
    });
  }
  return observations;
}

function fromKeyValue(rows: StructureRow[]): Observation[] {
  const observations: Observation[] = [];
  let current: Observation | null = null;
  const flush = () => {
    if (current) observations.push(current);
    current = null;
  };
  for (const row of rows) {
    if (row.role === "identifier") {
      flush();
      current = {
        codigo: (row.value ?? "").trim() || null,
        ambiguousIdentifier: false,
        designation: row.text,
        valueRaw: null,
        valueNumber: null,
        unitCue: "unknown",
        page: row.page,
        line: row.line,
        cell: row.key,
        rowText: row.text,
      };
      continue;
    }
    if (!current) continue;
    if (row.role === "designation" && row.value) {
      current.designation = row.value.trim();
      continue;
    }
    if (row.role === "permille" || row.role === "percent" || row.role === "ambiguous") {
      const raw = (row.value ?? "").trim();
      const local = cueInText(raw);
      current.valueRaw = raw || null;
      current.valueNumber = raw ? parseLooseNumber(raw) : null;
      current.unitCue = local !== "unknown" ? local : columnCue(row.role);
      current.cell = row.key;
      current.rowText = `${current.rowText}\n${row.text}`;
    }
  }
  flush();
  return observations.filter((row) => row.codigo);
}

function fromProse(rows: StructureRow[]): Observation[] {
  const observations: Observation[] = [];
  for (const row of rows) {
    const tokens = tokenize(row.text);
    const selected = selectCodigo(tokens);
    const number = bestNumber(row.text);
    const cue = cueInText(row.text);
    const hasLabel = tokens.some((token) => isLabel(token));
    const meaningful = cue !== "unknown" || hasLabel;
    if (!meaningful) continue;
    if (!selected.codigo && number == null) continue;
    if (selected.codigo && number == null && !hasLabel) continue;
    observations.push({
      codigo: selected.codigo,
      ambiguousIdentifier: selected.ambiguous,
      designation: row.text,
      valueRaw: number?.raw ?? null,
      valueNumber: number?.value ?? null,
      unitCue: cue,
      page: row.page,
      line: row.line,
      cell: null,
      rowText: row.text,
    });
  }
  return observations;
}

function foldToken(token: string): string {
  return token
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function isLabel(token: string): boolean {
  return LABEL_WORDS.has(foldToken(token));
}

function preferSpecific(observations: Observation[]): Observation[] {
  return observations.filter((observation) => {
    const text = observation.rowText.trim();
    return !observations.some((other) => {
      if (other === observation) return false;
      const otherText = other.rowText.trim();
      if (otherText.length >= text.length) return false;
      if ((observation.codigo ?? "") !== (other.codigo ?? "")) return false;
      if (observation.valueNumber !== other.valueNumber) return false;
      return text.includes(otherText);
    });
  });
}

export function extractObservations(structure: DiscoveredStructure): Observation[] {
  if (structure.representation === "table") return preferSpecific(fromTable(structure));
  if (structure.representation === "key_value") return preferSpecific(fromKeyValue(structure.rows));
  if (structure.representation === "prose") return preferSpecific(fromProse(structure.rows));
  return [];
}
