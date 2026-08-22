/**
 * IMAP Gmail — requer GMAIL_APP_PASSWORD no .env
 * Se não configurado, o módulo fica desactivado
 * automaticamente (sem erros, sem cron).
 *
 * Para activar:
 * 1. Google Account → Segurança → Palavras-passe de app
 * 2. Gera uma palavra-passe para "Correio" / "Mac"
 * 3. Remove espaços e coloca em GMAIL_APP_PASSWORD=...
 *
 * Alternativa futura: substituir IMAP por webhook
 * do Gmail (Google Pub/Sub) para não depender de
 * polling e evitar limites de taxa.
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
};

function gmailConfigured(): { user: string; pass: string } | null {
  const user = (process.env.GMAIL_USER || CONDOMINIO.email).trim();
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) return null;
  return { user, pass };
}

export function isGmailImapConfigured(): boolean {
  return gmailConfigured() !== null;
}

/** Mensagem legível para erros ImapFlow (evita só "Command failed"). */
export function formatImapError(e: unknown): string {
  const err = e as {
    message?: string;
    responseText?: string;
    authenticationFailed?: boolean;
    serverResponseCode?: string;
    code?: string;
  };
  if (err.authenticationFailed || err.serverResponseCode === "AUTHENTICATIONFAILED") {
    return "Credenciais Gmail inválidas — confirme GMAIL_USER e GMAIL_APP_PASSWORD (palavra-passe de app Google, não a password normal).";
  }
  if (err.code === "ETIMEOUT" || err.message?.includes("Socket timeout")) {
    return "Timeout IMAP — ligação Gmail demorou demasiado; tente sincronizar outra vez.";
  }
  if (err.responseText) return `${err.responseText}`;
  return String(err?.message ?? e);
}

/**
 * Lê emails UNSEEN (ou recentes) via IMAP Gmail.
 * Requer GMAIL_APP_PASSWORD (palavra-passe de aplicação Google).
 */
export async function fetchNewGmailMessages(opts: {
  limit?: number;
  markSeen?: boolean;
} = {}): Promise<FetchedEmail[]> {
  const creds = gmailConfigured();
  if (!creds) return [];

  const limit = opts.limit ?? 20;
  const markSeen = opts.markSeen ?? true;
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
    connectionTimeout: 15_000, // 15s para conectar
    socketTimeout: 90_000, // por mensagem; fetch é sequencial
    disableAutoIdle: true,
  });

  // Obrigatório: sem listener, ImapFlow derruba o Node com "Unhandled 'error' event"
  client.on("error", () => { /* erros tratados nas promises abaixo */ });

  const results: FetchedEmail[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Preferir não lidos; se vazios, últimos N
      let uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) {
        return [];
      }
      uids = uids.slice(-limit);

      // Fetch sequencial (evita timeout ao puxar N mensagens grandes de uma vez)
      const maxSourceBytes = 512 * 1024;
      for (const uid of uids) {
        for await (const msg of client.fetch(String(uid), {
          uid: true,
          source: { maxLength: maxSourceBytes },
          envelope: true,
        }, { uid: true })) {
          if (!msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const from = parsed.from?.value?.[0];
          const toAddr =
            parsed.to && "value" in parsed.to
              ? parsed.to.value?.[0]?.address
              : undefined;

          const messageId = parsed.messageId || `imap-uid-${msg.uid}`;
          const text = typeof parsed.text === "string" ? parsed.text : "";
          const html = typeof parsed.html === "string" ? parsed.html : null;

          results.push({
            externalId: messageId,
            fromEmail: (from?.address || "desconhecido@invalid").toLowerCase(),
            fromName: from?.name || null,
            toEmail: (toAddr || creds.user).toLowerCase(),
            subject: parsed.subject || "(sem assunto)",
            bodyText: text || (html ? html.replace(/<[^>]+>/g, " ") : ""),
            bodyHtml: html,
            receivedAt: parsed.date || new Date(),
          });

          if (markSeen && msg.uid) {
            await client.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"], { uid: true });
          }
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    throw new Error(formatImapError(e));
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }

  return results;
}
