/**
 * IMAP Gmail — requer GMAIL_APP_PASSWORD no .env
 *
 * Lê INBOX + marcadores (labels) do utilizador.
 * Ignora Spam, Lixo, Enviados, Rascunhos, Todo o correio (evita duplicados).
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { CONDOMINIO } from "./condominio";

export type FetchedEmail = {
  externalId: string;
  fromEmail: string;
  fromName: string | null;
  toEmail: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  receivedAt: Date;
  /** INBOX ou nome do marcador Gmail */
  gmailLabel: string;
};

let imapSessionBusy = false;
const skippedKeys = new Set<string>();

const CONNECT_MS = 15_000;
const SOCKET_MS = 30_000;
const OP_MS = 20_000;
const SOURCE_MAX_BYTES = 120_000;

/** Pastas do sistema Gmail que não sincronizamos. */
const SKIP_SPECIAL = new Set([
  "\\Sent",
  "\\Drafts",
  "\\Trash",
  "\\Junk",
  "\\All",
  "\\Flagged",
]);

function gmailConfigured(): { user: string; pass: string } | null {
  const user = (process.env.GMAIL_USER || CONDOMINIO.email).trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) return null;
  return { user, pass };
}

export function isGmailImapConfigured(): boolean {
  return gmailConfigured() !== null;
}

export function isImapSessionBusy(): boolean {
  return imapSessionBusy;
}

export function formatImapError(e: unknown): string {
  const err = e as {
    message?: string;
    responseText?: string;
    authenticationFailed?: boolean;
    serverResponseCode?: string;
    code?: string;
  };
  if (err.message?.includes("Sync IMAP já em curso")) return err.message;
  if (err.authenticationFailed || err.serverResponseCode === "AUTHENTICATIONFAILED") {
    return "Credenciais Gmail inválidas — confirme GMAIL_USER e GMAIL_APP_PASSWORD.";
  }
  if (err.message?.startsWith("Timeout ")) {
    return "Timeout IMAP — tente sincronizar outra vez.";
  }
  if (err.code === "ETIMEOUT" || err.message?.includes("Socket timeout")) {
    return "Timeout IMAP — ligação Gmail demorou demasiado.";
  }
  if (err.code === "NoConnection" || err.message?.includes("Connection not available")) {
    return "Ligação IMAP perdida — tente outra vez em 1 minuto.";
  }
  if (err.responseText) return String(err.responseText);
  return String(err?.message ?? e);
}

export function logImapErrorDetail(err: unknown, context = "fetchNewGmailMessages") {
  const code = (err as { code?: string })?.code;
  if (code === "NoConnection" && context.includes("logout")) return;
  console.error("[IMAP ERROR DETAIL]", context, err);
}

function isConnectionLost(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === "NoConnection" || e.code === "ETIMEOUT"
    || Boolean(e.message?.includes("Connection not available"))
    || Boolean(e.message?.includes("Socket timeout"))
    || Boolean(e.message?.startsWith("Timeout "));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout ${label} (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function newImapClient(creds: { user: string; pass: string }): ImapFlow {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    connectionTimeout: CONNECT_MS,
    socketTimeout: SOCKET_MS,
    disableAutoIdle: true,
  });
  client.on("error", (err) => logImapErrorDetail(err, "ImapFlow client.on('error')"));
  return client;
}

async function closeImapClient(client: ImapFlow) {
  try {
    await withTimeout(
      (async () => {
        try {
          if (client.usable && client.authenticated) await client.logout();
          else await client.close();
        } catch {
          try { await client.close(); } catch { /* ignore */ }
        }
      })(),
      4_000,
      "imap close",
    );
  } catch {
    try { await client.close(); } catch { /* ignore */ }
  }
}

/** Texto legível a partir de MIME (descodifica base64 / multipart). */
export function readableBodyFromParsed(parsed: {
  text?: string | false;
  html?: string | false;
  subject?: string;
}): { bodyText: string; bodyHtml: string | null } {
  const html = typeof parsed.html === "string" ? parsed.html : null;
  let text = typeof parsed.text === "string" ? parsed.text : "";
  if (!text && html) {
    text = html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  }
  text = text.replace(/\0/g, "").trim();
  // Heurística: corpo ainda parece MIME cru → limpar
  if (/Content-Transfer-Encoding:\s*base64/i.test(text) || /Content-Type:\s*multipart/i.test(text)) {
    const decoded = tryDecodeEmbeddedBase64(text);
    if (decoded) text = decoded;
  }
  return {
    bodyText: text.slice(0, 50_000) || "(sem texto)",
    bodyHtml: html,
  };
}

function tryDecodeEmbeddedBase64(raw: string): string | null {
  const match = raw.match(/Content-Transfer-Encoding:\s*base64\s*([\s\S]+?)(?:--[0-9a-f]+|$)/i);
  if (!match) return null;
  const b64 = match[1].replace(/[^A-Za-z0-9+/=]/g, "");
  if (b64.length < 16) return null;
  try {
    const out = Buffer.from(b64, "base64").toString("utf8").replace(/\0/g, "").trim();
    return out.length > 8 ? out.slice(0, 50_000) : null;
  } catch {
    return null;
  }
}

/** Limpa corpo já guardado na BD (MIME cru / base64). */
export function sanitizeStoredBody(body: string | null | undefined): string {
  if (!body) return "(sem texto)";
  if (/Content-Transfer-Encoding:\s*base64/i.test(body) || /^--\s*[0-9a-f]/i.test(body.trim())) {
    return tryDecodeEmbeddedBase64(body) || body.slice(0, 500) + "…";
  }
  return body;
}

function labelDisplayName(path: string): string {
  if (path === "INBOX") return "Caixa de entrada";
  return path.replace(/^\[Gmail]\//, "");
}

async function listSyncMailboxes(client: ImapFlow): Promise<{ path: string; label: string }[]> {
  const boxes = await withTimeout(client.list(), OP_MS, "LIST mailboxes");
  const out: { path: string; label: string }[] = [];
  for (const b of boxes) {
    if (!b.path || b.flags?.has("\\Noselect") || b.flags?.has("\\NonExistent")) continue;
    if (b.specialUse && SKIP_SPECIAL.has(b.specialUse)) continue;
    if (b.path === "[Gmail]" || b.path === "[Gmail]/Importante") continue;
    out.push({ path: b.path, label: labelDisplayName(b.path) });
  }
  // INBOX primeiro; resto alfabético
  out.sort((a, b) => {
    if (a.path === "INBOX") return -1;
    if (b.path === "INBOX") return 1;
    return a.label.localeCompare(b.label, "pt");
  });
  return out;
}

async function fetchOneUid(
  client: ImapFlow,
  creds: { user: string },
  uid: number,
  gmailLabel: string,
): Promise<FetchedEmail | null> {
  const msg = await withTimeout(
    client.fetchOne(
      String(uid),
      {
        uid: true,
        envelope: true,
        size: true,
        source: { maxLength: SOURCE_MAX_BYTES },
      },
      { uid: true },
    ),
    OP_MS,
    `fetch uid=${uid}`,
  );
  if (!msg) return null;

  let subject = msg.envelope?.subject || "(sem assunto)";
  let fromEmail = (msg.envelope?.from?.[0]?.address || "desconhecido@invalid").toLowerCase();
  let fromName = msg.envelope?.from?.[0]?.name || null;
  let toEmail = (msg.envelope?.to?.[0]?.address || creds.user).toLowerCase();
  let receivedAt = msg.envelope?.date instanceof Date ? msg.envelope.date : new Date();
  let externalId = msg.envelope?.messageId || `imap-${gmailLabel}-${uid}`;
  let bodyText = "(sem texto)";
  let bodyHtml: string | null = null;

  if (msg.source?.length) {
    try {
      const parsed = await simpleParser(msg.source);
      const bodies = readableBodyFromParsed(parsed);
      bodyText = bodies.bodyText;
      bodyHtml = bodies.bodyHtml;
      if (parsed.subject) subject = parsed.subject;
      const from = parsed.from?.value?.[0];
      if (from?.address) {
        fromEmail = from.address.toLowerCase();
        fromName = from.name || fromName;
      }
      if (parsed.messageId) externalId = parsed.messageId;
      if (parsed.date) receivedAt = parsed.date;
      const toAddr =
        parsed.to && "value" in parsed.to ? parsed.to.value?.[0]?.address : undefined;
      if (toAddr) toEmail = toAddr.toLowerCase();
    } catch {
      bodyText = msg.source.toString("utf8").slice(0, 2000);
    }
  } else if (msg.envelope) {
    bodyText = `(mensagem ${Math.round(Number(msg.size || 0) / 1024)} KB — corpo omitido)`;
  }

  return {
    externalId,
    fromEmail,
    fromName,
    toEmail,
    subject,
    bodyText,
    bodyHtml,
    receivedAt,
    gmailLabel,
  };
}

/**
 * Lê UNSEEN em INBOX + marcadores Gmail (até `limit` no total).
 */
export async function fetchNewGmailMessages(opts: {
  limit?: number;
  markSeen?: boolean;
} = {}): Promise<FetchedEmail[]> {
  if (imapSessionBusy) {
    throw new Error("Sync IMAP já em curso — aguarde e tente novamente.");
  }

  const creds = gmailConfigured();
  if (!creds) return [];

  imapSessionBusy = true;
  const limit = opts.limit ?? 8;
  const markSeen = opts.markSeen ?? true;
  const client = newImapClient(creds);
  const results: FetchedEmail[] = [];
  const seenExternal = new Set<string>();

  try {
    await withTimeout(client.connect(), CONNECT_MS, "connect");
    const mailboxes = await listSyncMailboxes(client);
    console.log(`[imap] pastas a sincronizar: ${mailboxes.map((m) => m.label).join(", ")}`);

    // Recolher UNSEEN por pasta (UIDs só) — round-robin para não ficar preso na INBOX
    type Queue = { path: string; label: string; uids: number[] };
    const queues: Queue[] = [];

    for (const box of mailboxes) {
      let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | null = null;
      try {
        lock = await client.getMailboxLock(box.path);
        const uids = await withTimeout(
          client.search({ seen: false }, { uid: true }),
          OP_MS,
          `SEARCH ${box.path}`,
        );
        const filtered = (uids ?? [])
          .map(Number)
          .filter((uid) => !skippedKeys.has(`${box.path}:${uid}`));
        if (filtered.length > 0) {
          console.log(`[imap] ${box.label}: ${filtered.length} UNSEEN`);
          queues.push({ path: box.path, label: box.label, uids: filtered });
        }
      } catch (boxErr) {
        console.warn(`[imap] pasta ${box.label}:`, formatImapError(boxErr));
        if (isConnectionLost(boxErr)) break;
      } finally {
        try { lock?.release(); } catch { /* ignore */ }
      }
    }

    // Round-robin: 1 mensagem de cada pasta até atingir o limite
    let connectionLost = false;
    while (results.length < limit && queues.some((q) => q.uids.length > 0) && !connectionLost) {
      for (const q of queues) {
        if (results.length >= limit || connectionLost) break;
        if (q.uids.length === 0) continue;
        const uid = q.uids.pop()!; // mais recentes no fim do search Gmail

        let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | null = null;
        try {
          lock = await client.getMailboxLock(q.path);
          const t0 = Date.now();
          const mail = await fetchOneUid(client, creds, uid, q.label);
          if (!mail) {
            skippedKeys.add(`${q.path}:${uid}`);
            continue;
          }
          if (seenExternal.has(mail.externalId)) {
            if (markSeen) {
              try {
                await withTimeout(
                  client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }),
                  OP_MS,
                  `STORE dup ${q.path}`,
                );
              } catch { /* ignore */ }
            }
            continue;
          }
          seenExternal.add(mail.externalId);
          results.push(mail);
          if (markSeen) {
            try {
              await withTimeout(
                client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }),
                OP_MS,
                `STORE ${q.path}`,
              );
            } catch (e) {
              console.warn(`[imap] markSeen ${q.label}:`, formatImapError(e));
            }
          }
          console.log(`[imap] ${q.label} uid=${uid} ok em ${Date.now() - t0} ms — ${mail.subject.slice(0, 50)}`);
        } catch (uidErr) {
          skippedKeys.add(`${q.path}:${uid}`);
          logImapErrorDetail(uidErr, `fetch ${q.path} uid=${uid}`);
          console.warn(`[imap] ${q.label} uid=${uid} ignorada — ${formatImapError(uidErr)}`);
          if (isConnectionLost(uidErr)) connectionLost = true;
        } finally {
          try { lock?.release(); } catch { /* ignore */ }
        }
      }
    }
  } catch (e) {
    logImapErrorDetail(e);
    if (results.length === 0) throw new Error(formatImapError(e));
    console.warn(`[imap] fetch parcial: ${results.length} mensagem(ns)`);
  } finally {
    await closeImapClient(client);
    imapSessionBusy = false;
  }

  return results;
}

/** Lista marcadores Gmail (para a UI). */
export async function listGmailLabels(): Promise<string[]> {
  const creds = gmailConfigured();
  if (!creds) return ["Caixa de entrada"];
  if (imapSessionBusy) return ["Caixa de entrada"];

  imapSessionBusy = true;
  const client = newImapClient(creds);
  try {
    await withTimeout(client.connect(), CONNECT_MS, "connect labels");
    const boxes = await listSyncMailboxes(client);
    return boxes.map((b) => b.label);
  } catch (e) {
    console.warn("[imap] listGmailLabels:", formatImapError(e));
    return ["Caixa de entrada"];
  } finally {
    await closeImapClient(client);
    imapSessionBusy = false;
  }
}
