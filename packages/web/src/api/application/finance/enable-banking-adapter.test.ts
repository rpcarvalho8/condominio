import { describe, expect, test } from "bun:test";
import {
  mapEnableBankingSession,
  mapEnableBankingTransaction,
  pickCondoAccount,
  sanitizeBankError,
  splitSyncDateChunks,
} from "./enable-banking-adapter";

describe("Enable Banking adapter", () => {
  test("mapeia sessão ASPSP e escolhe a conta do condomínio pelo IBAN", () => {
    const session = mapEnableBankingSession({
      session_id: "sess-1",
      accounts_data: [
        { uid: "acc-other", iban: "PT50000201231234567890154", currency: "EUR" },
        { uid: "acc-condo", iban: "PT50 0018 0003 4978 3806 0206 5", currency: "EUR" },
      ],
      access: { valid_until: "2026-12-10T00:00:00.000Z" },
    });
    expect(session.sessionId).toBe("sess-1");
    const picked = pickCondoAccount(session.accounts, "PT50001800034978380602065");
    expect(picked?.uid).toBe("acc-condo");
  });

  test("mapeia crédito Enable Banking sem gravar o IBAN do condomínio como contraparte", () => {
    const tx = mapEnableBankingTransaction(
      {
        transaction_id: "eb-1",
        credit_debit_indicator: "CRDT",
        booking_date: "2026-09-01",
        remittance_information: ["TRF CRED SEPA+ DE MARIA SILVA"],
        transaction_amount: { amount: "50.00", currency: "EUR" },
        debtor: { name: "MARIA SILVA" },
        debtor_account: { iban: "PT50000201231234567890154" },
        creditor_account: { iban: "PT50001800034978380602065" },
      },
      { ownIbans: ["PT50001800034978380602065"] },
    );
    expect(tx).toMatchObject({
      transactionId: "eb-1",
      amountCents: 5000,
      creditDebit: "CRDT",
      debtorName: "MARIA SILVA",
      counterpartyIban: "PT50000201231234567890154",
    });
  });

  test("sanitizeBankError remove JWT, PEM e Bearer", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.signature";
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----";
    const out = sanitizeBankError(
      new Error(`Enable Banking API 401: Bearer ${jwt} key=${pem}`),
    );
    expect(out).not.toContain("eyJ");
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).not.toContain("MIIB");
    expect(out).toContain("[REDACTED");
  });

  test("splitSyncDateChunks respeita lookback e janelas de 30 dias", () => {
    const now = new Date("2026-09-12T12:00:00.000Z");
    const chunks = splitSyncDateChunks(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-09-12T12:00:00.000Z"),
      { now, maxLookbackDays: 89, chunkDays: 30 },
    );
    expect(chunks[0]!.from >= "2026-06-15").toBe(true);
    expect(chunks[chunks.length - 1]!.to).toBe("2026-09-12");
    expect(chunks.length).toBeGreaterThan(1);
  });
});
