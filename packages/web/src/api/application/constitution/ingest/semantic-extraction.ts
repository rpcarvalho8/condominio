/**
 * Semantic Extraction — observações, ainda não valores canónicos.
 * Não decide permilagem final nem confirma nada.
 */
import type { DiscoveredStructure, StructureRow } from "./intake";
import type { UnitShareObservation } from "./profiles/unit-share";
import {
  bestNumber,
  classifyHeader,
  columnCue,
  cueInText,
  documentHasPermilleCue,
  fold,
  LABEL_WORDS,
  parseLooseNumber,
  selectCodigo,
  tokenize,
  type ColumnRole,
  type UnitCue,
} from "./roles";

export type Observation = UnitShareObservation;

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

/** Totais, cabeçalhos de zona e linhas de título — não são unidades. */
function skipProseLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  // Artefactos do scrape embutido / cabeçalho-rodapé PDF (não são linhas de quota).
  if (/^%PDF-/i.test(trimmed) || /^%%EOF/i.test(trimmed)) return true;
  const folded = fold(trimmed);
  if (/^total\b/.test(folded) || /^sub[\s-]?total\b/.test(folded)) return true;
  if (/^zona\b/.test(folded) || /^documento\b/.test(folded)) return true;
  if (/^permilagem\b/.test(folded) && !/\d/.test(trimmed.replace(/[‰%]/g, ""))) return true;
  // Secções ("Hab - Bloco 1", "Lojas", "Lugar Garagem") sem valor decimal de quota.
  if (
    /^(hab|loja|lojas|garagem|lugar)\b/.test(folded) &&
    !/\d+[.,]\d+/.test(trimmed) &&
    !/‰|%|mil[eé]sim|permil/i.test(trimmed)
  ) {
    return true;
  }
  return false;
}

function codigoFollowsLabel(tokens: string[], codigo: string): boolean {
  const target = foldToken(codigo);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!LABEL_WORDS.has(foldToken(tokens[i]!))) continue;
    const next = tokens[i + 1]!;
    if (foldToken(next) !== target) continue;
    if (/^[A-Z]{1,3}\d*$/.test(next) || (/^[A-Za-z]+\d+$/.test(next) && next.length <= 8)) {
      return true;
    }
  }
  return false;
}

function fromProse(rows: StructureRow[], documentCue: UnitCue): Observation[] {
  const observations: Observation[] = [];
  for (const row of rows) {
    if (skipProseLine(row.text)) continue;
    const tokens = tokenize(row.text);
    const selected = selectCodigo(tokens);
    const number = bestNumber(row.text);
    const lineCue = cueInText(row.text);
    const unitCue: UnitCue = lineCue !== "unknown" ? lineCue : documentCue;
    const labeled =
      Boolean(selected.codigo) && codigoFollowsLabel(tokens, selected.codigo!);
    const compactQuota =
      Boolean(selected.codigo) &&
      !selected.ambiguous &&
      row.text.trim().length <= 80 &&
      number != null &&
      number.value > 0 &&
      number.value < 1000 &&
      /[.,]\d+/.test(number.raw);

    // Unidade rotulada sem valor (ex.: «a preencher») → observação para coverage, sem quota.
    if (number == null) {
      if (labeled && selected.codigo && !selected.ambiguous) {
        observations.push({
          codigo: selected.codigo,
          ambiguousIdentifier: false,
          designation: row.text,
          valueRaw: null,
          valueNumber: null,
          unitCue,
          page: row.page,
          line: row.line,
          cell: null,
          rowText: row.text,
        });
      }
      continue;
    }

    if (lineCue !== "unknown") {
      // Pista na linha: exigir identificador rotulado, ambiguidade explícita, ou linha compacta com decimal.
      if (selected.ambiguous) {
        /* revisão humana */
      } else if (labeled || compactQuota || /‰|mil[eé]sim/i.test(row.text)) {
        if (!selected.codigo) continue;
      } else {
        continue;
      }
    } else if (labeled) {
      // «Fracção A …» / «letra B …» com valor, mesmo sem símbolo na linha.
    } else if (documentCue !== "unknown" && compactQuota) {
      // Documento com ‰ no cabeçalho: linhas compactas «código … valor.decimal».
    } else {
      continue;
    }

    observations.push({
      codigo: selected.codigo,
      ambiguousIdentifier: selected.ambiguous,
      designation: row.text,
      valueRaw: number.raw,
      valueNumber: number.value,
      unitCue,
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
  const documentCue: UnitCue = documentHasPermilleCue(structure.text) ? "permille" : "unknown";
  if (structure.representation === "table") return preferSpecific(fromTable(structure));
  if (structure.representation === "key_value") return preferSpecific(fromKeyValue(structure.rows));
  if (structure.representation === "prose") {
    return preferSpecific(fromProse(structure.rows, documentCue));
  }
  return [];
}
