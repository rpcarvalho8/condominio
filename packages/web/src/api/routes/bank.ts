/**
 * Enable Banking Integration
 * Handles OAuth flow, token storage, and transaction sync
 * 
 * Flow:
 *   1. GET  /api/bank/status          → current connection state
 *   2. GET  /api/bank/connect         → redirect to Enable Banking auth
 *   3. GET  /api/bank/callback        → handle OAuth callback, store tokens
 *   4. POST /api/bank/sync            → fetch transactions + import
 *   5. DELETE /api/bank/disconnect    → remove connection
 */

import { Hono } from "hono";
import { requireAdmin } from "../middleware/auth";
import { db } from "../database";
import * as schema from "../database/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { recalcularSaldos } from "./dashboard";
import { learnIBAN, loadMatrizFromDB } from "../lib/identity-matrix";
import { llmIdentifyFracao, LLM_LEARN_THRESHOLD } from "../lib/llm-fallback";
import {
  aplicarMatchTransferencia,
  findCreditoDuplicado,
  loadQuotaTiposExtras,
  marcarDuplicadoIgnorado,
  matchTransferencia,
  selectTransacoesParaMatch,
  signalsFromBankTransaction,
} from "../lib/transfer-match";
import { extractCounterpartyIban } from "../lib/iban";

const CLIENT_ID = process.env.ENABLE_BANKING_CLIENT_ID ?? "";
// Support both literal newlines and \n escape sequences in .env
const PRIVATE_KEY_PEM = (process.env.ENABLE_BANKING_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
const REDIRECT_URI = process.env.ENABLE_BANKING_REDIRECT_URI ?? "http://localhost:4200/api/bank/callback";
const API_BASE = "https://api.enablebanking.com";

// ─── JWT signing (RS256) ──────────────────────────────────────────────────────
function makeJWT(clientId: string, privateKeyPem: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: clientId })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: clientId,
    aud: "api.enablebanking.com",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");

  const signing = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signing);
  // Normalize newlines each call (handles env var edge cases)
  const pem = privateKeyPem.replace(/\\n/g, "\n");
  const sig = sign.sign(pem, "base64url");
  return `${signing}.${sig}`;
}

async function enableBankingFetch(path: string, opts: RequestInit = {}): Promise<any> {
  if (!CLIENT_ID || !PRIVATE_KEY_PEM) {
    throw new Error("Enable Banking não configurado — falta CLIENT_ID ou PRIVATE_KEY");
  }
  const jwt = makeJWT(CLIENT_ID, PRIVATE_KEY_PEM);
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Enable Banking API ${res.status}: ${body}`);
  }
  return res.json();
}

// ─── Category mapping from Enable Banking transaction data ────────────────────
const KW_MAP: Array<[RegExp, string]> = [
  [/limpez/i, "limpeza"],
  [/jardinage|jardin/i, "jardim"],
  [/elevador/i, "elevadores"],
  [/indaqua|agua|água/i, "agua"],
  [/iberdrola|edp|endesa|eletricidade|electricidade/i, "eletricidade"],
  [/seguro/i, "seguros"],
  [/condom/i, "quota"],
  [/honora|administr/i, "honorarios"],
];

// Administradores do condomínio — apenas para categorizar SAÍDAS (honorários).
// Não afecta identificação de entradas (créditos) de condóminos/administradores.
const ADMIN_NAMES = [
  /SERGIO\s+MIGUEL\s+MONTEIRO/i,
  /RUI\s+CARVALHO/i,
  /CATARINA\s+REIS/i,
];

function isHonorarioDesc(desc: string): boolean {
  return ADMIN_NAMES.some((re) => re.test(desc));
}

function inferCatFromDesc(desc: string): string {
  if (isHonorarioDesc(desc)) return "honorarios";
  for (const [re, m] of KW_MAP) if (re.test(desc)) return m;
  return "outros";
}

function isBankFeeDesc(desc: string): boolean {
  const d = (desc ?? "").toUpperCase();
  return d.includes("IMP.SELO") || d.includes("COMISSAO") || d.includes("COMISSÃO") ||
    d.includes("MANUTENCAO DE CONTA") || d.includes("IMPOSTO DO SELO") ||
    d.includes("RETENÇÃO IRS") || d.includes("RETENCAO IRS") ||
    d.includes("JURO ILIQUIDO") || d.includes("DESPESAS BANCÁR");
}

function despesaKey(desc: string, valor: number, date: Date): string {
  const day = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  return `${desc}|${valor.toFixed(2)}|${day}`;
}

// dedup secundária — valor + dia (ignora descrição; evita duplicados CSV manual vs bank sync)
function despesaKeyValorData(valor: number, date: Date): string {
  const day = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  return `${valor.toFixed(2)}|${day}`;
}

// ─── Stage raw transactions into bank_transactions before processing ──────────
// Upserts each transaction by its Enable Banking transaction_id (dedup key).
// Returns only the rows that were newly inserted (not already staged + processed).
async function stageTransactions(
  transactions: any[],
  connectionId: string,
): Promise<{ staged: number; skipped: number }> {
  let staged = 0;
  let skipped = 0;

  for (const tx of transactions) {
    const remittance: string[] = tx.remittance_information ?? tx.remittanceInformation ?? [];
    const description = remittance.length > 0
      ? remittance.join(" ")
      : (tx.creditor?.name ?? tx.debtor?.name ?? tx.creditorName ?? tx.debtorName ?? "");
    const amountStr = tx.transaction_amount?.amount ?? tx.transactionAmount?.amount ?? "0";
    const rawAmount = parseFloat(amountStr);
    const indicator = tx.credit_debit_indicator ?? tx.creditDebitIndicator ?? "";
    const isDebit = indicator === "DBIT" || rawAmount < 0;
    // Store as signed: positive = credit, negative = debit
    const amount = isDebit ? -Math.abs(rawAmount) : Math.abs(rawAmount);
    const dateStr = tx.booking_date ?? tx.bookingDate ?? tx.value_date ?? tx.valueDate ?? "";
    const date = dateStr ? new Date(dateStr) : new Date();
    const txId: string | null = tx.transaction_id ?? tx.transactionId ?? null;
    const creditorName: string | null = tx.creditor?.name ?? tx.creditorName ?? null;
    const debtorName: string | null =
      tx.debtor?.name ?? tx.debtorName ?? tx.debtor_account?.name ?? null;
    const debtorIban: string | null = extractCounterpartyIban(tx, {
      credit: !isDebit,
      description,
    });

    // Skip if already staged by external transaction_id
    if (txId) {
      const existing = await db
        .select({ id: schema.bankTransactions.id, imported: schema.bankTransactions.imported })
        .from(schema.bankTransactions)
        .where(eq(schema.bankTransactions.transactionId, txId))
        .limit(1);
      if (existing.length > 0) {
        skipped++;
        continue;
      }
    } else {
      // Enable Banking nem sempre devolve transaction_id (confirmado: Santander Totta
      // omite-o nalgumas transferências SEPA). Sem isto, cada sync re-inseria a mesma
      // transação como nova linha, duplicando-a em bank_transactions e inflacionando
      // saldos que somam bank_transactions diretamente (ex: creditosBancariosCC no
      // dashboard). Fallback de dedup: mesma ligação + valor + dia + descrição.
      const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date); dayEnd.setHours(23, 59, 59, 999);
      const existingByFingerprint = await db
        .select({ id: schema.bankTransactions.id })
        .from(schema.bankTransactions)
        .where(and(
          eq(schema.bankTransactions.connectionId, connectionId),
          eq(schema.bankTransactions.amount, amount),
          eq(schema.bankTransactions.description, description),
          sql`${schema.bankTransactions.date} >= ${Math.floor(dayStart.getTime() / 1000)}`,
          sql`${schema.bankTransactions.date} <= ${Math.floor(dayEnd.getTime() / 1000)}`,
        ))
        .limit(1);
      if (existingByFingerprint.length > 0) {
        skipped++;
        continue;
      }
    }

    await db.insert(schema.bankTransactions).values({
      connectionId,
      transactionId: txId,
      amount,
      currency: tx.transaction_amount?.currency ?? "EUR",
      date,
      description,
      creditorName,
      debtorName,
      debtorIban,
      type: indicator || (isDebit ? "DBIT" : "CRDT"),
      status: "pending",
      imported: 0,
      rawData: JSON.stringify(tx),
    });
    staged++;
  }

  return { staged, skipped };
}

// ─── Transaction import logic ─────────────────────────────────────────────────
async function importTransactions(transactions: any[], connectionId?: string): Promise<{
  despesasCreated: number;
  quotasCreated: number;
  quotasUpdated: number;
  despesasSkipped: number;
  staged: number;
  stagingSkipped: number;
  errors: string[];
}> {
  // ── STEP 1: Stage all raw transactions first ──────────────────────────────
  const stagingResult = connectionId
    ? await stageTransactions(transactions, connectionId)
    : { staged: 0, skipped: 0 };

  const results = {
    despesasCreated: 0, quotasCreated: 0, quotasUpdated: 0, despesasSkipped: 0,
    staged: stagingResult.staged, stagingSkipped: stagingResult.skipped,
    errors: [] as string[],
  };

  const [existingDespesas] = await Promise.all([
    db.select({ id: schema.despesas.id, descricao: schema.despesas.descricao, valor: schema.despesas.valor, data: schema.despesas.data }).from(schema.despesas),
  ]);

  const despesaKeys = new Set<string>();
  const despesaKeysValorData = new Set<string>(); // dedup secundário valor+data
  for (const d of existingDespesas) {
    const dDate = d.data instanceof Date ? d.data : new Date((d.data as number) * 1000);
    despesaKeys.add(despesaKey(d.descricao, d.valor, dDate));
    despesaKeysValorData.add(despesaKeyValorData(d.valor, dDate));
  }

  const despesasToInsert: any[] = [];

  for (const tx of transactions) {
    try {
      // Enable Banking real API shape (snake_case):
      // tx.booking_date, tx.transaction_amount.amount, tx.credit_debit_indicator
      // tx.remittance_information (array of strings), tx.creditor.name, tx.debtor.name
      const remittance: string[] = tx.remittance_information ?? tx.remittanceInformation ?? [];
      const desc = remittance.length > 0
        ? remittance.join(" ")
        : (tx.creditor?.name ?? tx.debtor?.name ?? tx.creditorName ?? tx.debtorName ?? "Sem descrição");
      const amountStr = tx.transaction_amount?.amount ?? tx.transactionAmount?.amount ?? "0";
      const valor = Math.abs(parseFloat(amountStr));
      const dateStr = tx.booking_date ?? tx.bookingDate ?? tx.value_date ?? tx.valueDate ?? "";
      const date = dateStr ? new Date(dateStr) : new Date();
      const indicator = tx.credit_debit_indicator ?? tx.creditDebitIndicator ?? "";
      const isDebit = indicator === "DBIT" || parseFloat(amountStr) < 0;

      if (valor === 0) continue;
      if (isBankFeeDesc(desc)) { results.despesasSkipped++; continue; }

      if (!isDebit) {
        // Créditos: identidade + finalidade no process-staged (matchTransferencia).
        continue;
      } else {
        // Saída — despesa
        const dKey = despesaKey(desc, valor, date);
        const dKeyVD = despesaKeyValorData(valor, date);
        // dedup primário: desc+valor+data; secundário: valor+data (evita CSV manual vs bank sync)
        if (despesaKeys.has(dKey) || despesaKeysValorData.has(dKeyVD)) { results.despesasSkipped++; continue; }
        despesaKeys.add(dKey);
        despesaKeysValorData.add(dKeyVD);
        despesasToInsert.push({
          descricao: desc,
          categoria: inferCatFromDesc(desc),
          valor, data: date,
          recorrente: false, fornecedorId: null, notas: null, faturaUrl: null, subcategoria: null,
        });
        results.despesasCreated++;
      }
    } catch (e: any) {
      results.errors.push(e.message);
    }
  }

  // Batch writes — créditos são aplicados em processarStagedTransactions()
  const BATCH = 50;
  const insertedDespesaIds: string[] = [];
  for (let i = 0; i < despesasToInsert.length; i += BATCH) {
    const inserted = await db.insert(schema.despesas).values(despesasToInsert.slice(i, i + BATCH)).returning({ id: schema.despesas.id });
    insertedDespesaIds.push(...inserted.map(r => r.id));
  }

  // ── STEP 3: Débitos/taxas staged → imported=1. Créditos ficam imported=0 para o matcher.
  if (connectionId) {
    for (const tx of transactions) {
      const txId: string | null = tx.transaction_id ?? tx.transactionId ?? null;
      if (!txId) continue;
      const amountStr = tx.transaction_amount?.amount ?? tx.transactionAmount?.amount ?? "0";
      const rawAmount = parseFloat(amountStr);
      const indicator = tx.credit_debit_indicator ?? tx.creditDebitIndicator ?? "";
      const isDebit = indicator === "DBIT" || rawAmount < 0;
      const desc = (() => {
        const r: string[] = tx.remittance_information ?? tx.remittanceInformation ?? [];
        return r.length > 0 ? r.join(" ") : (tx.creditor?.name ?? tx.debtor?.name ?? "");
      })();

      if (isBankFeeDesc(desc)) {
        await db.update(schema.bankTransactions)
          .set({ imported: 1, status: "ignored", importType: null })
          .where(eq(schema.bankTransactions.transactionId, txId));
        continue;
      }
      if (!isDebit) continue; // crédito: process-staged

      await db.update(schema.bankTransactions)
        .set({ imported: 1, status: "processed", importType: "despesa" })
        .where(eq(schema.bankTransactions.transactionId, txId));
    }
  }

  return results;
}

// ─── Process Staged Transactions ─────────────────────────────────────────────
// Matcher transversal (identidade + finalidade): staging novo, duplicados extra,
// e rateios importados sem fração. Não reabre as ~48 reviews genéricas.
export async function processarStagedTransactions(): Promise<{
  processed: number;
  manualReview: number;
  errors: string[];
  details: Array<{ transactionId: string; result: "processed" | "manual_review" | "error"; fracao?: string; score?: number; motivo?: string }>;
}> {
  const summary = {
    processed: 0,
    manualReview: 0,
    errors: [] as string[],
    details: [] as Array<{ transactionId: string; result: "processed" | "manual_review" | "error"; fracao?: string; score?: number; motivo?: string }>,
  };

  await loadMatrizFromDB();
  await loadQuotaTiposExtras();
  const pendentes = await selectTransacoesParaMatch();
  if (pendentes.length === 0) return summary;

  const txDateOf = (raw: unknown): Date => {
    if (raw instanceof Date) return raw;
    if (typeof raw === "number") return raw > 1e12 ? new Date(raw) : new Date(raw * 1000);
    return new Date();
  };

  for (const txn of pendentes) {
    const txId = txn.transactionId ?? txn.id;
    const jaImportadoRateio = txn.imported === 1 && txn.importType === "rateio";
    try {
      if (txn.type === "DBIT" || (txn.amount ?? 0) < 0) {
        await db.update(schema.bankTransactions)
          .set({ imported: 1, status: "ignored", importType: "despesa" })
          .where(eq(schema.bankTransactions.id, txn.id));
        summary.details.push({ transactionId: txId, result: "processed", motivo: "débito ignorado no process-staged" });
        summary.processed++;
        continue;
      }

      const dup = txn.imported === 0 ? await findCreditoDuplicado(txn) : null;
      if (dup) {
        await marcarDuplicadoIgnorado(txn.id, dup.id);
        summary.processed++;
        summary.details.push({ transactionId: txId, result: "processed", motivo: `duplicado de ${dup.id}` });
        continue;
      }

      const signals = signalsFromBankTransaction(txn);
      const ibanSender = signals.ibanSender ?? undefined;
      const date = txDateOf(txn.date);
      const amount = signals.amount;

      if (ibanSender && !txn.debtorIban) {
        await db.update(schema.bankTransactions)
          .set({ debtorIban: ibanSender })
          .where(eq(schema.bankTransactions.id, txn.id));
      }

      let match = await matchTransferencia({
        descricao: signals.descricao,
        amount,
        ibanSender,
        debtorName: signals.debtorName ?? undefined,
      });

      if (!match.identity || match.identity.confidence < 55) {
        if (jaImportadoRateio) {
          summary.details.push({
            transactionId: txId,
            result: "manual_review",
            score: match.confidence,
            motivo: "rateio sem identidade suficiente (IBAN/nome/fração) — mantido",
          });
          continue;
        }

        const llmResult = await llmIdentifyFracao({
          descricao: signals.descricao,
          amount,
          debtorName: signals.debtorName ?? undefined,
          ibanSender,
        });

        if (!llmResult.fracao || llmResult.confidence < 55) {
          await db.update(schema.bankTransactions)
            .set({ requiresManualReview: 1, status: "pending" })
            .where(eq(schema.bankTransactions.id, txn.id));
          summary.manualReview++;
          summary.details.push({
            transactionId: txId,
            result: "manual_review",
            score: llmResult.confidence,
            motivo: `motor:${match.confidence} llm:${llmResult.confidence} provider:${llmResult.provider}`,
          });
          continue;
        }

        if (llmResult.confidence >= LLM_LEARN_THRESHOLD && ibanSender) {
          await learnIBAN(llmResult.fracao.idFracao, ibanSender);
        }

        match = await matchTransferencia({
          descricao: signals.descricao,
          amount,
          ibanSender,
          debtorName: signals.debtorName ?? undefined,
          identityOverride: llmResult.fracao,
        });
      }

      const applied = await aplicarMatchTransferencia({
        txnId: txn.id,
        description: txn.description ?? "",
        amount,
        date,
        ibanSender,
        debtorName: signals.debtorName,
        match,
        observacoesPrefix: match.identity?.criterios.includes("override")
          ? `[llm-fallback:${match.identity.confidence}%]`
          : `[process-staged motor:${match.identity?.confidence ?? 0}%]`,
      });

      if (!applied.applied) {
        if (jaImportadoRateio) {
          summary.details.push({
            transactionId: txId,
            result: "manual_review",
            motivo: applied.motivo,
          });
          continue;
        }
        await db.update(schema.bankTransactions)
          .set({ requiresManualReview: 1, status: "pending" })
          .where(eq(schema.bankTransactions.id, txn.id));
        summary.manualReview++;
        summary.details.push({ transactionId: txId, result: "manual_review", motivo: applied.motivo });
        continue;
      }

      summary.processed++;
      summary.details.push({
        transactionId: txId,
        result: "processed",
        fracao: applied.fracao,
        score: match.confidence,
        motivo: applied.motivo,
      });
    } catch (e: any) {
      summary.errors.push(`[${txId}] ${e.message}`);
      summary.details.push({ transactionId: txId, result: "error", motivo: e.message });
    }
  }

  try {
    await recalcularSaldos();
  } catch (e: any) {
    summary.errors.push(`[recalcularSaldos] ${e.message}`);
  }

  return summary;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
export const bankRoutes = new Hono()

  // GET /api/bank/status — connection info + last sync
  .get("/status", requireAdmin, async (c) => {
    const isConfigured = !!(CLIENT_ID && PRIVATE_KEY_PEM);
    const conn = await db.select().from(schema.bankConnections).limit(1);
    const lastSync = await db.select().from(schema.bankSyncLogs)
      .orderBy(desc(schema.bankSyncLogs.createdAt)).limit(1);

    const conexaoAtiva = conn.length > 0 && conn[0].status === "active";
    const precisaReconectar = conn.length > 0 && conn[0].status !== "active";

    return c.json({
      configured: isConfigured,
      connected: conexaoAtiva,
      needsReconnect: precisaReconectar,
      connection: conn[0] ?? null,
      lastSync: lastSync[0] ?? null,
    });
  })

  // GET /api/bank/connect — start OAuth flow
  .get("/connect", requireAdmin, async (c) => {
    if (!CLIENT_ID || !PRIVATE_KEY_PEM) {
      return c.json({ error: "Enable Banking não configurado no servidor" }, 503);
    }
    try {
      // Create a session with Enable Banking — POST /auth
      const data = await enableBankingFetch("/auth", {
        method: "POST",
        body: JSON.stringify({
          aspsp: {
            // Sandbox: "Mock ASPSP" | Produção: "Santander Totta" ou nome exato da API
            name: process.env.ENABLE_BANKING_ASPSP_NAME ?? "Mock ASPSP",
            country: process.env.ENABLE_BANKING_ASPSP_COUNTRY ?? "PT",
          },
          state: crypto.randomUUID(),
          redirect_url: REDIRECT_URI,
          psu_type: "business",
          access: {
            valid_until: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
          },
        }),
      });

      return c.json({ authUrl: data.url });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  })

  // GET /api/bank/callback — OAuth callback from Enable Banking
  .get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    console.log("[bank/callback] code=", code?.slice(0,20), "error=", error, "url=", c.req.url);

    if (error) {
      console.log("[bank/callback] error from provider:", error);
      return c.redirect(`/?bank_error=${encodeURIComponent(error)}`);
    }
    if (!code) {
      return c.redirect("/?bank_error=no_code");
    }

    try {
      // Exchange code for session — POST /sessions
      const data = await enableBankingFetch("/sessions", {
        method: "POST",
        body: JSON.stringify({ code }),
      });

      const sessionId = data.session_id;
      // accounts_data has uid per account
      const accounts: any[] = data.accounts_data ?? data.accounts ?? [];

      // Store connection
      // Nome real do ASPSP a que efetivamente se ligou, não um valor fixo —
      // evita a app "pensar" que está no Santander quando na realidade caiu no Mock ASPSP
      // (env ENABLE_BANKING_ASPSP_NAME não definida em produção).
      const aspspLigado = process.env.ENABLE_BANKING_ASPSP_NAME ?? "Mock ASPSP";
      if (aspspLigado === "Mock ASPSP") {
        console.warn("[bank/callback] ⚠️ ENABLE_BANKING_ASPSP_NAME não definida — ligou ao Mock ASPSP (sandbox), NÃO ao Santander real!");
      }

      await db.delete(schema.bankConnections); // only one connection at a time
      await db.insert(schema.bankConnections).values({
        sessionId,
        bankName: aspspLigado,
        accounts: JSON.stringify(accounts),
        status: "active",
        connectedAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      });

      return c.redirect("/importar?bank_connected=1");
    } catch (err: any) {
      return c.redirect(`/importar?bank_error=${encodeURIComponent(err.message)}`);
    }
  })

  // POST /api/bank/sync — fetch transactions + import
  // Body (optional): { date_from: "YYYY-MM-DD", date_to: "YYYY-MM-DD" }
  // If not provided: incremental from last sync, or last 90 days on first run
  .post("/sync", requireAdmin, async (c) => {
    const conn = await db.select().from(schema.bankConnections).limit(1);
    if (conn.length === 0) {
      return c.json({ error: "Sem ligação bancária ativa" }, 400);
    }

    const connection = conn[0];
    const accounts: any[] = JSON.parse(connection.accounts ?? "[]");

    if (accounts.length === 0) {
      return c.json({ error: "Sem contas associadas à ligação" }, 400);
    }

    // Support custom date range from request body
    let body: any = {};
    try { body = await c.req.json(); } catch {}

    let dateFrom: Date;
    let dateTo: Date = new Date();

    if (body.date_from) {
      dateFrom = new Date(body.date_from);
    } else if (body.backfill) {
      // Histórico operacional: 45 dias (evita rate-limit; PSD2 permite até ~89)
      dateFrom = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
      console.log(`[bank/sync] BACKFILL desde ${dateFrom.toISOString().slice(0, 10)}`);
    } else {
      // Incremental: from last sync, or 45 days on first run
      const lastSync = await db.select().from(schema.bankSyncLogs)
        .orderBy(desc(schema.bankSyncLogs.createdAt)).limit(1);
      dateFrom = lastSync[0]?.syncedTo
        ? new Date(lastSync[0].syncedTo as any)
        : new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    }
    if (body.date_to) {
      dateTo = new Date(body.date_to);
    }

    // Santander PT via Enable Banking: hard cap ~89 days
    const MAX_LOOKBACK_DAYS = 89;
    const earliestAllowed = new Date(Date.now() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    if (dateFrom < earliestAllowed) {
      console.log(`[bank/sync] dateFrom ${dateFrom.toISOString().slice(0,10)} capped to ${earliestAllowed.toISOString().slice(0,10)} (Santander max ${MAX_LOOKBACK_DAYS} days)`);
      dateFrom = earliestAllowed;
    }

    // Enable Banking has a max window per request (~30 days for Santander PT)
    // Split into 30-day chunks to avoid WRONG_TRANSACTIONS_PERIOD error
    const MAX_DAYS = 30;
    const chunks: Array<{ from: string; to: string }> = [];
    let chunkStart = new Date(dateFrom);
    while (chunkStart < dateTo) {
      const chunkEnd = new Date(chunkStart);
      chunkEnd.setDate(chunkEnd.getDate() + MAX_DAYS);
      if (chunkEnd > dateTo) chunkEnd.setTime(dateTo.getTime());
      chunks.push({
        from: chunkStart.toISOString().slice(0, 10),
        to: chunkEnd.toISOString().slice(0, 10),
      });
      chunkStart = new Date(chunkEnd);
      chunkStart.setDate(chunkStart.getDate() + 1);
    }

    let allTransactions: any[] = [];
    const syncErrors: string[] = [];

    for (const chunk of chunks) {
      for (const acc of accounts) {
        try {
          const data = await enableBankingFetch(
            `/accounts/${acc.uid}/transactions?date_from=${chunk.from}&date_to=${chunk.to}`
          );
          const txns = data.transactions ?? [];
          allTransactions = allTransactions.concat(txns);
          console.log(`[bank/sync] ${chunk.from}→${chunk.to}: ${txns.length} txns`);
        } catch (e: any) {
          syncErrors.push(`Conta ${acc.uid} (${chunk.from}→${chunk.to}): ${e.message}`);
        }
      }
    }

    let importResults = { despesasCreated: 0, quotasCreated: 0, quotasUpdated: 0, despesasSkipped: 0, staged: 0, stagingSkipped: 0, errors: [] as string[] };
    if (allTransactions.length > 0) {
      importResults = await importTransactions(allTransactions, connection.id);
    }

    // Recalcular e persistir saldos em configuracoes após o sync
    // Garante que o dashboard reflicte os dados actualizados na próxima query
    try {
      await recalcularSaldos();
    } catch (e: any) {
      console.error("[bank/sync] Erro ao recalcular saldos:", e.message);
      importResults.errors.push(`recalcularSaldos: ${e.message}`);
    }

    // ── Camada 2: LLM Fallback sobre TXNs em staging ─────────────────────────
    let llmProcessedHTTP = 0;
    let llmManualReviewHTTP = 0;
    const llmProviderCountsHTTP: Record<string, number> = {};
    try {
      const stagedResult = await processarStagedTransactions();
      llmProcessedHTTP    = stagedResult.processed;
      llmManualReviewHTTP = stagedResult.manualReview;
      for (const d of stagedResult.details) {
        if (d.result === "processed" && d.motivo?.startsWith("llm-fallback:")) {
          const providerMatch = d.motivo.match(/^llm-fallback:([^\s|]+)/);
          const provider = providerMatch ? providerMatch[1] : "llm";
          llmProviderCountsHTTP[provider] = (llmProviderCountsHTTP[provider] ?? 0) + 1;
        }
      }
      if (stagedResult.errors.length > 0) {
        importResults.errors.push(...stagedResult.errors.map(e => `[staged] ${e}`));
      }
      const llmProviderSummaryHTTP = Object.entries(llmProviderCountsHTTP)
        .map(([p, n]) => `${p}=${n}`).join(", ");
      console.info(
        `[bank/sync] ✅ Ciclo completo — ingeridas:${allTransactions.length} | ` +
        `Barreira1(IBAN/Matriz):${importResults.quotasCreated}c+${importResults.quotasUpdated}u | ` +
        `Camada2(LLM):${llmProcessedHTTP}${llmProviderSummaryHTTP ? ` [${llmProviderSummaryHTTP}]` : ""} | ` +
        `ManualReview:${llmManualReviewHTTP} | Despesas:${importResults.despesasCreated}`
      );
    } catch (e: any) {
      console.error("[bank/sync] Erro na Camada 2 (staged):", e.message);
      importResults.errors.push(`[staged] ${e.message}`);
    }

    // Falha total: TODAS as chamadas à Enable Banking falharam (0 transações + houve erros)
    // → sessão provavelmente expirada/revogada. Isto TEM de ser visível na UI, não só nos logs.
    const totalCalls = chunks.length * accounts.length;
    const bancoTotalmenteFalhou = allTransactions.length === 0 && syncErrors.length >= totalCalls && totalCalls > 0;

    // Marca a ligação como precisando de reautenticação quando detectamos erro de auth (401/403)
    // vindo da própria Enable Banking, para o /status deixar de mentir "connected: true".
    const erroDeAuth = syncErrors.some(e => /\b(401|403)\b/.test(e) || /invalid_grant|consent|expired|revoked/i.test(e));
    if (bancoTotalmenteFalhou && erroDeAuth) {
      await db.update(schema.bankConnections)
        .set({ status: "expired" })
        .where(eq(schema.bankConnections.id, connection.id));
    }

    // Log the sync
    await db.insert(schema.bankSyncLogs).values({
      connectionId: connection.id,
      syncedFrom: dateFrom,
      syncedTo: dateTo,
      transactionsFound: allTransactions.length,
      despesasCreated: importResults.despesasCreated,
      quotasCreated: importResults.quotasCreated,
      quotasUpdated: importResults.quotasUpdated,
      skipped: importResults.despesasSkipped,
      errors: JSON.stringify([...syncErrors, ...importResults.errors]),
      status: bancoTotalmenteFalhou ? "error" : (syncErrors.length > 0 || importResults.errors.length > 0 ? "partial" : "ok"),
    });

    // Devolver HTTP não-200 quando a falha é total, para o frontend não assumir sucesso.
    const httpStatus = bancoTotalmenteFalhou ? 502 : 200;

    return c.json({
      ok: !bancoTotalmenteFalhou,
      period: { from: dateFrom.toISOString().slice(0, 10), to: dateTo.toISOString().slice(0, 10) },
      transactionsFound: allTransactions.length,
      ...importResults,
      camada2: {
        llmProcessed: llmProcessedHTTP,
        manualReview: llmManualReviewHTTP,
        providers: llmProviderCountsHTTP,
      },
      syncErrors,
      needsReconnect: bancoTotalmenteFalhou && erroDeAuth,
    }, httpStatus as any);
  })

  // DELETE /api/bank/disconnect
  .delete("/disconnect", requireAdmin, async (c) => {
    await db.delete(schema.bankConnections);
    return c.json({ ok: true });
  })

  // POST /api/bank/process-staged — processar TXNs em staging (imported=0)
  // Corre o motor matricial em todas as transações pendentes e aplica a cascata.
  // TXNs identificadas com score >= 55 → imported=1 + quota criada/atualizada
  // TXNs sem match → requires_manual_review=1, imported permanece 0
  .post("/process-staged", requireAdmin, async (c) => {
    try {
      const result = await processarStagedTransactions();
      return c.json({
        ok: true,
        processed: result.processed,
        manualReview: result.manualReview,
        errors: result.errors,
        details: result.details,
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  })

  // GET /api/bank/synclogs — last 10 sync logs
  .get("/synclogs", requireAdmin, async (c) => {
    const logs = await db.select().from(schema.bankSyncLogs)
      .orderBy(desc(schema.bankSyncLogs.createdAt)).limit(10);
    return c.json({ logs });
  });

// ─── Scheduled sync (callable programmatically) ───────────────────────────────
export async function runBankSync(opts?: { backfill?: boolean; dateFrom?: string }): Promise<void> {
  const conn = await db.select().from(schema.bankConnections).limit(1);
  if (conn.length === 0) return;

  const connection = conn[0];
  const accounts: any[] = JSON.parse(connection.accounts ?? "[]");
  if (accounts.length === 0) return;

  const lastSync = await db.select().from(schema.bankSyncLogs)
    .orderBy(desc(schema.bankSyncLogs.createdAt)).limit(1);

  let dateFrom: Date;
  if (opts?.dateFrom) {
    dateFrom = new Date(opts.dateFrom);
  } else if (opts?.backfill) {
    dateFrom = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    console.log(`[bank-cron] BACKFILL desde ${dateFrom.toISOString().slice(0, 10)}`);
  } else {
    dateFrom = lastSync[0]?.syncedTo
      ? new Date(lastSync[0].syncedTo as any)
      : new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  }
  const dateTo = new Date();

  // Cap dateFrom: Santander PT via Enable Banking não aceita mais de 89 dias para trás
  const MAX_LOOKBACK_DAYS = 89;
  const earliestAllowed = new Date(Date.now() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  if (dateFrom < earliestAllowed) {
    console.log(`[bank-cron] dateFrom ${dateFrom.toISOString().slice(0,10)} capped to ${earliestAllowed.toISOString().slice(0,10)} (Santander max ${MAX_LOOKBACK_DAYS} days)`);
    dateFrom = earliestAllowed;
  }

  // Santander PT via Enable Banking: janela máxima ~30 dias por request
  // Dividir em chunks para evitar 422 WRONG_TRANSACTIONS_PERIOD
  const MAX_DAYS = 30;
  const chunks: Array<{ from: string; to: string }> = [];
  let chunkStart = new Date(dateFrom);
  while (chunkStart < dateTo) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setDate(chunkEnd.getDate() + MAX_DAYS);
    if (chunkEnd > dateTo) chunkEnd.setTime(dateTo.getTime());
    chunks.push({
      from: chunkStart.toISOString().slice(0, 10),
      to: chunkEnd.toISOString().slice(0, 10),
    });
    chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkStart.getDate() + 1);
  }

  let allTransactions: any[] = [];
  const syncErrors: string[] = [];

  for (const chunk of chunks) {
    for (const acc of accounts) {
      try {
        const data = await enableBankingFetch(
          `/accounts/${acc.uid}/transactions?date_from=${chunk.from}&date_to=${chunk.to}`
        );
        const txns = data.transactions ?? [];
        allTransactions = allTransactions.concat(txns);
        console.log(`[bank-cron] ${chunk.from}→${chunk.to}: ${txns.length} txns (conta ${acc.uid})`);
      } catch (e: any) {
        syncErrors.push(`Conta ${acc.uid} (${chunk.from}→${chunk.to}): ${e.message}`);
      }
    }
  }

  let importResults = { despesasCreated: 0, quotasCreated: 0, quotasUpdated: 0, despesasSkipped: 0, staged: 0, stagingSkipped: 0, errors: [] as string[] };

  // ── CAMADA DE CONTINGÊNCIA (Offline Fallback) ─────────────────────────────
  // Se o Enable Banking falhou em TODOS os chunks (rede cortada, token expirado,
  // consentimento revogado), allTransactions fica vazio mas pode haver transações
  // já em staging (imported=0) na BD — resultado de syncs parciais anteriores.
  // Nesse caso NÃO abortamos: avançamos com o que já está na BD local.
  const bancoOffline = allTransactions.length === 0 && syncErrors.length > 0;

  if (bancoOffline) {
    // Contar quantas transações pendentes existem em staging
    const [{ pendentes }] = await db
      .select({ pendentes: sql<number>`count(*)` })
      .from(schema.bankTransactions)
      .where(eq(schema.bankTransactions.imported, 0));

    console.warn(
      `[bank-cron] ⚠️  Enable Banking offline — modo fallback activado.` +
      ` ${pendentes} transações pendentes em staging serão processadas sem nova ingestão.`
    );

    // Registar o motivo da falha como aviso (não erro bloqueante)
    syncErrors.forEach(e =>
      console.warn(`[bank-cron] [offline-reason] ${e}`)
    );

    // Não corremos importTransactions (sem dados novos do banco).
    // Não corremos recalcularSaldos ANTES de processarStagedTransactions —
    // fazê-lo agora reporia os orçamentos brutos sem considerar os pagamentos
    // em staging, corrompendo as rubricas no ecrã.
    // O recalcularSaldos será executado dentro de processarStagedTransactions()
    // após processar as transações pendentes (comportamento normal da Camada 2).
  } else if (allTransactions.length > 0) {
    // Fluxo normal: ingerir transações recebidas do banco
    importResults = await importTransactions(allTransactions, connection.id);

    // Recalcular saldos após ingestão e antes da Camada 2 LLM
    try {
      await recalcularSaldos();
    } catch (e: any) {
      console.error("[bank-cron] Erro ao recalcular saldos:", e.message);
    }
  }
  // Caso sem erros E sem transações (banco vazio no período): comportamento
  // normal, recalcular saldos para reflectir o estado actual.
  else {
    try {
      await recalcularSaldos();
    } catch (e: any) {
      console.error("[bank-cron] Erro ao recalcular saldos:", e.message);
    }
  }

  // ── Camada 2: LLM Fallback sobre TXNs em staging ─────────────────────────
  // Corre sempre — processa transações imported=0 quer venham de nova ingestão
  // quer já existissem em staging de syncs anteriores (modo offline-fallback).
  let llmProcessed = 0;
  let llmManualReview = 0;
  const llmProviderCounts: Record<string, number> = {};
  try {
    const stagedResult = await processarStagedTransactions();
    llmProcessed    = stagedResult.processed;
    llmManualReview = stagedResult.manualReview;
    // Contabilizar por provider LLM
    for (const d of stagedResult.details) {
      if (d.result === "processed" && d.motivo?.startsWith("llm-fallback:")) {
        const providerMatch = d.motivo.match(/^llm-fallback:([^\s|]+)/);
        const provider = providerMatch ? providerMatch[1] : "llm";
        llmProviderCounts[provider] = (llmProviderCounts[provider] ?? 0) + 1;
      }
    }
    if (stagedResult.errors.length > 0) {
      importResults.errors.push(...stagedResult.errors.map(e => `[staged] ${e}`));
    }
  } catch (e: any) {
    console.error("[bank-cron] Erro na Camada 2 (staged):", e.message);
    importResults.errors.push(`[staged] ${e.message}`);
  }

  // ── Log estruturado do ciclo completo ────────────────────────────────────
  // Em modo offline os syncErrors são avisos, não erros fatais — não somamos
  // ao totalErrors para não marcar o sync como "partial" por culpa do banco.
  const totalErrors = (bancoOffline ? 0 : syncErrors.length) + importResults.errors.length;
  const llmProviderSummary = Object.entries(llmProviderCounts)
    .map(([p, n]) => `${p}=${n}`).join(", ");

  console.info(
    `\n╔══════════════════════════════════════════════════════════════╗` +
    `\n║  [bank-cron] SYNC ${new Date().toISOString().slice(0, 16).replace("T", " ")} PT${bancoOffline ? " [OFFLINE-FALLBACK]" : ""}` +
    `\n╠══════════════════════════════════════════════════════════════╣` +
    `\n║  📥  Transações ingeridas:  ${String(allTransactions.length).padEnd(4)} (${importResults.staged} novas, ${importResults.stagingSkipped} duplicadas)${bancoOffline ? " ← banco offline" : ""}` +
    `\n║  🏦  Barreira 1 (IBAN/Matriz): ${String(importResults.quotasCreated + importResults.quotasUpdated).padEnd(4)} quotas (${importResults.quotasCreated} criadas, ${importResults.quotasUpdated} actualizadas)` +
    `\n║  🤖  Camada 2 LLM:          ${String(llmProcessed).padEnd(4)} identificadas${llmProviderSummary ? ` [${llmProviderSummary}]` : ""}` +
    `\n║  👁️  Revisão manual:         ${String(llmManualReview).padEnd(4)} pendentes` +
    `\n║  📤  Despesas criadas:       ${String(importResults.despesasCreated).padEnd(4)}` +
    `\n║  ⚠️  Erros:                  ${String(totalErrors).padEnd(4)}${totalErrors > 0 ? " ← ver sync log" : ""}` +
    `\n╚══════════════════════════════════════════════════════════════╝\n`
  );

  await db.insert(schema.bankSyncLogs).values({
    connectionId: connection.id,
    syncedFrom: dateFrom,
    syncedTo: dateTo,
    transactionsFound: allTransactions.length,
    despesasCreated: importResults.despesasCreated,
    quotasCreated: importResults.quotasCreated + llmProcessed,
    quotasUpdated: importResults.quotasUpdated,
    skipped: importResults.despesasSkipped,
    errors: JSON.stringify([
      ...(bancoOffline ? syncErrors.map(e => `[offline-warn] ${e}`) : syncErrors),
      ...importResults.errors,
    ]),
    status: totalErrors > 0 ? "partial" : (bancoOffline ? "offline-fallback" : "ok"),
  });
}
