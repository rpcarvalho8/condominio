/**
 * Extração e normalização transversal do IBAN da contraparte.
 *
 * Enable Banking / Santander omite muitas vezes `debtor_iban` na coluna e
 * usa snake_case (`debtor_account.iban`). GoCardless/Nordigen usa
 * `debtorAccount.iban`. TrueLayer usa `other_account.identifiers.iban`.
 *
 * Em créditos, o IBAN do condomínio vem em `creditor_account` — NÃO é o pagador.
 */

const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
const NIB_RE = /^\d{21}$/;
const IBAN_IN_TEXT = /\b([A-Z]{2}\s*\d{2}(?:\s*[A-Z0-9]){10,30})\b/gi;

/** Conta à ordem do condomínio — nunca tratar como pagador. */
export const IBAN_CONTA_CONDOMINIO = "PT50001800034978380602065";

function lettersToDigits(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
}

function mod97(numeric: string): number {
  let rest = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    rest = Number(String(rest) + numeric.slice(i, i + 7)) % 97;
  }
  return rest;
}

function ibanChecksumOk(iban: string): boolean {
  if (!IBAN_RE.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  return mod97(lettersToDigits(rearranged)) === 1;
}

function nibToIban(nib: string): string {
  const proto = `${nib}PT00`;
  const check = String(98 - mod97(lettersToDigits(proto))).padStart(2, "0");
  return `PT${check}${nib}`;
}

/**
 * Remove espaços, uppercase, NIB PT (21 dígitos) → IBAN com checksum.
 * Não descarta IBANs com checksum inválido — o banco por vezes manda mal.
 */
export function normalizeIBAN(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const compact = String(raw).replace(/[\s.-]+/g, "").toUpperCase();
  if (!compact) return null;
  if (NIB_RE.test(compact)) return nibToIban(compact);
  if (!IBAN_RE.test(compact)) return null;
  return compact;
}

export function isOwnAccountIban(iban: string | null | undefined): boolean {
  const n = normalizeIBAN(iban);
  return n != null && n === IBAN_CONTA_CONDOMINIO;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function pickIban(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string") {
      const n = normalizeIBAN(c);
      if (n) return n;
    }
  }
  return null;
}

function accountIban(node: unknown): string | null {
  const o = asRecord(node);
  if (!o) return pickIban(node);
  return pickIban(
    o.iban,
    o.IBAN,
    asRecord(o.identifiers)?.iban,
    asRecord(o.identification)?.iban,
    asRecord(o.other)?.identification,
    asRecord(o.other)?.iban,
    o.bban,
    o.BBAN,
  );
}

function debtorIbanFromPayload(raw: Record<string, unknown>): string | null {
  return pickIban(
    raw.debtorIban,
    raw.debtor_iban,
    raw.iban_sender,
    raw.ibanSender,
    accountIban(raw.debtor_account),
    accountIban(raw.debtorAccount),
    accountIban(asRecord(raw.debtor)?.account),
    accountIban(asRecord(raw.debtor)?.iban),
    asRecord(raw.debtor)?.iban,
    accountIban(raw.counterparty_account),
    accountIban(raw.counterpartyAccount),
    accountIban(asRecord(raw.counterparty)?.account),
    asRecord(raw.counterparty)?.iban,
    accountIban(asRecord(raw.other_account)?.identifiers),
    accountIban(raw.other_account),
    accountIban(raw.otherAccount),
    raw.debtor_account_additional_identification,
    raw.debtorAccountAdditionalIdentification,
  );
}

function creditorIbanFromPayload(raw: Record<string, unknown>): string | null {
  return pickIban(
    raw.creditorIban,
    raw.creditor_iban,
    accountIban(raw.creditor_account),
    accountIban(raw.creditorAccount),
    accountIban(asRecord(raw.creditor)?.account),
    asRecord(raw.creditor)?.iban,
  );
}

function ibanFromRemittance(raw: Record<string, unknown>, description?: string | null): string | null {
  const chunks: string[] = [];
  const rem = raw.remittance_information ?? raw.remittanceInformation;
  if (Array.isArray(rem)) chunks.push(...rem.map(String));
  else if (typeof rem === "string") chunks.push(rem);
  if (description) chunks.push(description);
  if (typeof raw.description === "string") chunks.push(raw.description);
  if (typeof raw.note === "string") chunks.push(raw.note);

  const blob = chunks.join(" ");
  IBAN_IN_TEXT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IBAN_IN_TEXT.exec(blob))) {
    const n = normalizeIBAN(m[1]);
    if (n && ibanChecksumOk(n)) return n;
  }
  return null;
}

export interface ExtractIbanOpts {
  /** Crédito (pagador = debtor) vs débito (contraparte = creditor). Default: crédito. */
  credit?: boolean;
  description?: string | null;
}

/**
 * IBAN de quem fez a transferência (crédito) ou do destinatário (débito).
 * Nunca devolve o IBAN da conta do condomínio.
 */
export function extractCounterpartyIban(
  payload: unknown,
  opts: ExtractIbanOpts = {},
): string | null {
  const credit = opts.credit !== false;
  const root = asRecord(payload);
  if (!root) return pickIban(payload);

  const own = new Set<string>([IBAN_CONTA_CONDOMINIO]);
  const cred = creditorIbanFromPayload(root);
  if (cred) own.add(cred);

  const accept = (iban: string | null): string | null =>
    iban && !own.has(iban) ? iban : null;

  if (credit) {
    return (
      accept(debtorIbanFromPayload(root)) ??
      accept(ibanFromRemittance(root, opts.description))
    );
  }
  return accept(creditorIbanFromPayload(root));
}

export type BankTxnIbanSource = {
  amount?: number | null;
  description?: string | null;
  debtorIban?: string | null;
  rawData?: string | null;
};

/**
 * Fonte única para sync / process-staged / classificação:
 * coluna `debtor_iban` + JSON `raw_data` (todos os sítios onde o IBAN pode viver).
 */
export function extractDebtorIbanFromBankTxn(txn: BankTxnIbanSource): string | null {
  const credit = (txn.amount ?? 0) >= 0;
  const fromCol = credit ? extractCounterpartyIban({ debtorIban: txn.debtorIban }, { credit: true }) : null;

  let payload: unknown = null;
  if (txn.rawData) {
    try {
      payload = JSON.parse(txn.rawData);
    } catch {
      payload = null;
    }
  }

  if (payload) {
    const fromRaw = extractCounterpartyIban(payload, {
      credit,
      description: txn.description,
    });
    if (fromRaw) return fromRaw;
  }

  if (fromCol) return fromCol;
  if (credit && txn.description) {
    return extractCounterpartyIban({ remittance_information: [txn.description] }, { credit: true });
  }
  return null;
}
