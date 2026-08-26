/**
 * Teste rápido IMAP Gmail (credenciais do .env na raiz).
 * Uso: cd packages/web && bun run test:imap
 */
import {
  fetchNewGmailMessages,
  formatImapError,
  isGmailImapConfigured,
} from "../src/api/lib/gmail-imap";
import { CONDOMINIO } from "../src/api/lib/condominio";

const user = (process.env.GMAIL_USER || CONDOMINIO.email).trim();
const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");

console.log("── IMAP Gmail test ──");
console.log("GMAIL_USER:  ", user);
console.log("APP_PASSWORD:", pass ? `${pass.slice(0, 4)}… (${pass.length} chars)` : "(vazio)");
console.log("configured:  ", isGmailImapConfigured());
console.log("");

if (!isGmailImapConfigured()) {
  console.error("FAIL: GMAIL_APP_PASSWORD em falta");
  process.exit(1);
}

try {
  const t0 = Date.now();
  const msgs = await fetchNewGmailMessages({ limit: 4, markSeen: false });
  console.log(`OK — ${msgs.length} mensagens em ${Date.now() - t0} ms`);
  for (const m of msgs) {
    console.log(` · [${m.gmailLabel}] ${m.subject.slice(0, 55)} | ${m.fromEmail}`);
    console.log(`   corpo: ${m.bodyText.slice(0, 80).replace(/\s+/g, " ")}…`);
  }
  console.log("\n✅ Teste IMAP concluído.");
} catch (e) {
  console.error("❌", formatImapError(e));
  process.exit(1);
}
