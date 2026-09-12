/**
 * Enable Banking / PSD2 adapter for the F2 kernel.
 *
 * Adapta o cliente JWT + mapping de transacções de `routes/bank.ts`
 * sem escrever na Fonte (`bank_connections` / `bank_transactions` / `Quota.pago`).
 * Secrets (JWT, PEM, code) nunca entram em logs — usar `sanitizeBankError`.
 */
import crypto from "node:crypto";
import { extractCounterpartyIban, normalizeIBAN } from "../../lib/iban";
import { redactSecrets } from "../../domain/safe-log";
import {
  BANK_CONSENT_DAYS,
  BANK_PSD2_SCOPES,
  BANK_SYNC_CHUNK_DAYS,
  BANK_SYNC_MAX_LOOKBACK_DAYS,
  DEFAULT_BANK_PSD2_SCOPES,
} from "../../domain/finance";

export const ENABLE_BANKING_API_BASE = "https://api.enablebanking.com";

export type EnableBankingAccount = {
  uid: string;
  iban: string | null;
  currency: string | null;
};

export type EnableBankingSession = {
  sessionId: string;
  accounts: EnableBankingAccount[];
  accessValidUntil: string | null;
};

export type EnableBankingAuthSession = {
  authorizationId: string | null;
  url: string;
};

export type EnableBankingTransaction = {
  transactionId: string | null;
  amountCents: number;
  bookedAt: Date;
  description: string;
  debtorName: string | null;
  counterpartyIban: string | null;
  creditDebit: "CRDT" | "DBIT";
};

export type EnableBankingCreateAuthInput = {
  aspspName: string;
  aspspCountry: string;
  redirectUrl: string;
  state: string;
  scopes: string[];
  validUntil: Date;
  psuType?: "business" | "personal";
};

export type EnableBankingClient = {
  isConfigured(): boolean;
  createAuthSession(input: EnableBankingCreateAuthInput): Promise<EnableBankingAuthSession>;
  exchangeCode(code: string): Promise<EnableBankingSession>;
  listTransactions(input: {
    accountUid: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<EnableBankingTransaction[]>;
  revokeSession?(sessionId: string): Promise<void>;
};

const PEM_RE = /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

export function sanitizeBankError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "unknown_error");
  const redacted = String(redactSecrets(raw))
    .replace(PEM_RE, "[REDACTED_PEM]")
    .replace(JWT_RE, "[REDACTED_JWT]");
  return redacted.replace(/\s+/g, " ").trim().slice(0, 480);
}

export function isEnableBankingConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.ENABLE_BANKING_CLIENT_ID?.trim() && env.ENABLE_BANKING_PRIVATE_KEY?.trim());
}

export function f2EnableBankingRedirectUri(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.ENABLE_BANKING_F2_REDIRECT_URI?.trim() ||
    "http://localhost:4200/api/f2/bank/callback"
  );
}

export function defaultAspspName(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENABLE_BANKING_ASPSP_NAME?.trim() || "Mock ASPSP";
}

export function defaultAspspCountry(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENABLE_BANKING_ASPSP_COUNTRY?.trim() || "PT";
}

export function normalizePsd2Scopes(input?: string[] | null): string[] {
  const allowed = new Set<string>(Object.values(BANK_PSD2_SCOPES));
  const raw = (input?.length ? input : [...DEFAULT_BANK_PSD2_SCOPES])
    .map((s) => String(s ?? "").trim().toLowerCase())
    .filter((s) => allowed.has(s));
  return [...new Set(raw.length ? raw : [...DEFAULT_BANK_PSD2_SCOPES])];
}

export function parseConsentScopesJson(value: string | null | undefined): string[] {
  if (!value?.trim()) return [...DEFAULT_BANK_PSD2_SCOPES];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_BANK_PSD2_SCOPES];
    return normalizePsd2Scopes(parsed.map(String));
  } catch {
    return [...DEFAULT_BANK_PSD2_SCOPES];
  }
}

function privateKeyPem(env: NodeJS.ProcessEnv): string {
  return (env.ENABLE_BANKING_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
}

function makeJWT(clientId: string, pem: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: clientId })).toString(
    "base64url",
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iss: clientId,
      aud: "api.enablebanking.com",
      iat: now,
      exp: now + 3600,
    }),
  ).toString("base64url");
  const signing = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signing);
  return `${signing}.${sign.sign(pem.replace(/\\n/g, "\n"), "base64url")}`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function pickString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

export function mapEnableBankingAccount(raw: unknown): EnableBankingAccount | null {
  if (typeof raw === "string" && raw.trim()) {
    return { uid: raw.trim(), iban: null, currency: null };
  }
  const o = asRecord(raw);
  if (!o) return null;
  const uid = pickString(o.uid, o.account_uid, o.accountUid, o.id);
  if (!uid) return null;
  const iban = normalizeIBAN(
    pickString(o.iban, o.account_iban, asRecord(o.account_identifiers)?.iban) ?? null,
  );
  return {
    uid,
    iban,
    currency: pickString(o.currency, o.currency_code) ?? "EUR",
  };
}

export function mapEnableBankingSession(data: unknown): EnableBankingSession {
  const o = asRecord(data) ?? {};
  const sessionId = pickString(o.session_id, o.sessionId);
  if (!sessionId) {
    throw new Error("Enable Banking session sem session_id");
  }
  const rawAccounts = o.accounts_data ?? o.accounts ?? [];
  const accounts = (Array.isArray(rawAccounts) ? rawAccounts : [])
    .map(mapEnableBankingAccount)
    .filter((a): a is EnableBankingAccount => Boolean(a));
  const access = asRecord(o.access);
  return {
    sessionId,
    accounts,
    accessValidUntil: pickString(access?.valid_until, access?.validUntil, o.valid_until) ?? null,
  };
}

export function mapEnableBankingTransaction(
  raw: unknown,
  opts?: { ownIbans?: Array<string | null | undefined> },
): EnableBankingTransaction | null {
  const tx = asRecord(raw);
  if (!tx) return null;
  const remittance = tx.remittance_information ?? tx.remittanceInformation;
  const remittanceText = Array.isArray(remittance)
    ? remittance.map(String).join(" ")
    : typeof remittance === "string"
      ? remittance
      : "";
  const description =
    remittanceText ||
    pickString(
      asRecord(tx.creditor)?.name,
      asRecord(tx.debtor)?.name,
      tx.creditorName,
      tx.debtorName,
    ) ||
    "";
  const amountNode = asRecord(tx.transaction_amount) ?? asRecord(tx.transactionAmount);
  const amountStr = pickString(amountNode?.amount, tx.amount) ?? "0";
  const rawAmount = Number.parseFloat(amountStr);
  if (!Number.isFinite(rawAmount)) return null;
  const indicator = pickString(tx.credit_debit_indicator, tx.creditDebitIndicator) ?? "";
  const isDebit = indicator === "DBIT" || rawAmount < 0;
  const absCents = Math.round(Math.abs(rawAmount) * 100);
  if (absCents <= 0) return null;
  const dateStr =
    pickString(tx.booking_date, tx.bookingDate, tx.value_date, tx.valueDate) ?? "";
  const bookedAt = dateStr ? new Date(dateStr) : new Date();
  if (Number.isNaN(bookedAt.getTime())) return null;
  const debtorName = pickString(
    asRecord(tx.debtor)?.name,
    tx.debtorName,
    asRecord(tx.debtor_account)?.name,
  );
  const own = new Set(
    (opts?.ownIbans ?? [])
      .map((iban) => normalizeIBAN(iban))
      .filter((iban): iban is string => Boolean(iban)),
  );
  let counterparty = extractCounterpartyIban(tx, {
    credit: !isDebit,
    description,
  });
  if (counterparty && own.has(counterparty)) counterparty = null;
  return {
    transactionId: pickString(tx.transaction_id, tx.transactionId),
    amountCents: isDebit ? -absCents : absCents,
    bookedAt,
    description,
    debtorName,
    counterpartyIban: counterparty,
    creditDebit: isDebit ? "DBIT" : "CRDT",
  };
}

export function splitSyncDateChunks(
  dateFrom: Date,
  dateTo: Date,
  opts?: { maxLookbackDays?: number; chunkDays?: number; now?: Date },
): Array<{ from: string; to: string }> {
  const now = opts?.now ?? new Date();
  const maxLookback = opts?.maxLookbackDays ?? BANK_SYNC_MAX_LOOKBACK_DAYS;
  const chunkDays = opts?.chunkDays ?? BANK_SYNC_CHUNK_DAYS;
  const earliest = new Date(now.getTime() - maxLookback * 24 * 60 * 60 * 1000);
  let start = dateFrom < earliest ? earliest : dateFrom;
  const end = dateTo > now ? now : dateTo;
  if (start >= end) {
    const day = end.toISOString().slice(0, 10);
    return [{ from: day, to: day }];
  }
  const chunks: Array<{ from: string; to: string }> = [];
  let chunkStart = new Date(start);
  while (chunkStart < end) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + chunkDays);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({
      from: chunkStart.toISOString().slice(0, 10),
      to: chunkEnd.toISOString().slice(0, 10),
    });
    chunkStart = new Date(chunkEnd);
    chunkStart.setUTCDate(chunkStart.getUTCDate() + 1);
  }
  return chunks.length ? chunks : [{ from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }];
}

export function pickCondoAccount(
  accounts: EnableBankingAccount[],
  preferredIban?: string | null,
): EnableBankingAccount | null {
  if (accounts.length === 0) return null;
  const want = normalizeIBAN(preferredIban);
  if (want) {
    const match = accounts.find((a) => normalizeIBAN(a.iban) === want);
    if (match) return match;
  }
  return accounts.find((a) => a.iban) ?? accounts[0] ?? null;
}

export function defaultConsentValidUntil(now: Date, days = BANK_CONSENT_DAYS): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

async function enableBankingFetch(
  path: string,
  opts: RequestInit,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const clientId = env.ENABLE_BANKING_CLIENT_ID?.trim() ?? "";
  const pem = privateKeyPem(env);
  if (!clientId || !pem) {
    throw new Error("Enable Banking não configurado — falta CLIENT_ID ou PRIVATE_KEY");
  }
  const jwt = makeJWT(clientId, pem);
  const res = await fetch(`${ENABLE_BANKING_API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Enable Banking API ${res.status}: ${sanitizeBankError(body)}`);
  }
  return res.json();
}

export function createEnableBankingClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EnableBankingClient {
  return {
    isConfigured() {
      return isEnableBankingConfigured(env);
    },
    async createAuthSession(input) {
      const scopes = normalizePsd2Scopes(input.scopes);
      const data = asRecord(
        await enableBankingFetch(
          "/auth",
          {
            method: "POST",
            body: JSON.stringify({
              aspsp: { name: input.aspspName, country: input.aspspCountry },
              state: input.state,
              redirect_url: input.redirectUrl,
              psu_type: input.psuType ?? "business",
              access: {
                valid_until: input.validUntil.toISOString(),
                balances: scopes.includes(BANK_PSD2_SCOPES.balances),
                transactions: scopes.includes(BANK_PSD2_SCOPES.transactions),
              },
            }),
          },
          env,
        ),
      );
      const url = pickString(data?.url);
      if (!url) throw new Error("Enable Banking /auth sem url");
      return {
        authorizationId: pickString(data?.authorization_id, data?.authorizationId),
        url,
      };
    },
    async exchangeCode(code) {
      return mapEnableBankingSession(
        await enableBankingFetch("/sessions", { method: "POST", body: JSON.stringify({ code }) }, env),
      );
    },
    async listTransactions(input) {
      const data = asRecord(
        await enableBankingFetch(
          `/accounts/${encodeURIComponent(input.accountUid)}/transactions?date_from=${encodeURIComponent(input.dateFrom)}&date_to=${encodeURIComponent(input.dateTo)}`,
          { method: "GET" },
          env,
        ),
      );
      const raw = data?.transactions;
      const list = Array.isArray(raw) ? raw : [];
      return list
        .map((tx) => mapEnableBankingTransaction(tx))
        .filter((tx): tx is EnableBankingTransaction => Boolean(tx));
    },
    async revokeSession(sessionId) {
      try {
        await enableBankingFetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }, env);
      } catch {
        /* best-effort — o estado local prevalece */
      }
    },
  };
}
