/**
 * Parser CSV multi-banco para Payments candidatos (transplante de csv-bank-parser.ts).
 * Sem mapas Fonte hardcoded / bank-identity-map.json / reconciliation-engine.
 * Fallback quando BankConnection está em reautorização.
 */
import { extractPayerFromDescription } from "./f2-identity";

export type ParsedBankCredit = {
  amountCents: number;
  description: string;
  bookedAt: Date | null;
  debtorName: string | null;
  counterpartyIban: string | null;
  externalRef: string | null;
  tipo: string;
};

function parseCsvRow(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

function detectDelimiter(headerLine: string): string {
  const commas = (headerLine.match(/,/g) ?? []).length;
  const semis = (headerLine.match(/;/g) ?? []).length;
  return semis > commas ? ";" : ",";
}

/** Montante PT (50,00 / 1.234,56) ou EN (50.00) → cêntimos. */
export function parseAmountToCents(raw: string): number {
  let s = raw.replace(/[\u0080€\s]/g, "").trim();
  if (!s) return 0;
  if (s.includes(",") && s.includes(".")) {
    const ci = s.lastIndexOf(",");
    const di = s.lastIndexOf(".");
    s = di > ci ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  }
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function parseBookedAt(raw: string): Date | null {
  const s = raw.trim();
  const dmy = s.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  if (dmy) {
    const d = new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function headerIndex(headers: string[], ...needles: string[]): number {
  const norm = headers.map((h) =>
    h
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, ""),
  );
  for (const needle of needles) {
    const n = needle.replace(/[^a-z0-9]/g, "");
    const idx = norm.findIndex((h) => h.includes(n));
    if (idx >= 0) return idx;
  }
  return -1;
}

function isCredit(tipo: string, amountCents: number): boolean {
  const t = tipo.toLowerCase();
  if (/saida|d[eé]bito|debit|despesa/.test(t)) return false;
  if (/entrada|credito|credit/.test(t)) return true;
  return amountCents > 0;
}

/**
 * Aceita CSV Santander (2 linhas de cabeçalho) ou CSV genérico com headers.
 * Só devolve créditos (entradas) — candidatos a Payment, nunca saídas.
 */
export function parseBankCsvCredits(csvText: string): ParsedBankCredit[] {
  const content = csvText.replace(/^\uFEFF/, "");
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];

  let headerLine = lines[0]!;
  let dataStart = 1;
  const firstLower = headerLine.toLowerCase();
  if (!/descritivo|description|montante|amount|valor/.test(firstLower) && lines[1]) {
    headerLine = lines[1]!;
    dataStart = 2;
  }

  const delimiter = detectDelimiter(headerLine);
  const headers = parseCsvRow(headerLine, delimiter);
  const iDesc = headerIndex(headers, "descritivo", "description", "descricao", "memo", "narrativa");
  const iAmount = headerIndex(headers, "montante", "amount", "valor", "credit");
  const iDate = headerIndex(headers, "dataoperacao", "data", "date", "booking", "datavalor");
  const iTipo = headerIndex(headers, "tipo", "type", "creditdebit");
  const iIban = headerIndex(headers, "iban", "debtoriban", "contraparte");
  const iRef = headerIndex(headers, "seq", "reference", "externalref", "id", "transactionid");

  const descIdx = iDesc >= 0 ? iDesc : 6;
  const amountIdx = iAmount >= 0 ? iAmount : 7;
  const dateIdx = iDate >= 0 ? iDate : 1;
  const tipoIdx = iTipo >= 0 ? iTipo : 5;

  const credits: ParsedBankCredit[] = [];
  for (let i = dataStart; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]!, delimiter);
    const description = (cols[descIdx] ?? "").trim();
    if (!description) continue;
    const amountCents = Math.abs(parseAmountToCents(cols[amountIdx] ?? ""));
    if (amountCents <= 0) continue;
    const tipo = (cols[tipoIdx] ?? "").trim();
    if (!isCredit(tipo, parseAmountToCents(cols[amountIdx] ?? ""))) continue;

    const bookedAt = parseBookedAt(cols[dateIdx] ?? "");
    const debtorName = extractPayerFromDescription(description);
    const counterpartyIban = iIban >= 0 ? (cols[iIban] ?? "").replace(/\s+/g, "").toUpperCase() || null : null;
    const refRaw = iRef >= 0 ? (cols[iRef] ?? "").trim() : "";
    credits.push({
      amountCents,
      description,
      bookedAt,
      debtorName,
      counterpartyIban,
      externalRef: refRaw || null,
      tipo: tipo || "Entrada",
    });
  }
  return credits;
}
