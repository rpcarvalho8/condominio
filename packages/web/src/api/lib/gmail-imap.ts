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
  });

  const results: FetchedEmail[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Preferir não lidos; se vazios, últimos N
      let uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) {
        // sem não-lidos — não puxa tudo automaticamente para não reprocessar
        return [];
      }
      uids = uids.slice(-limit);

      for await (const msg of client.fetch(uids, { uid: true, source: true, envelope: true }, { uid: true })) {
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
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }

  return results;
}
