import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONDOMINIO } from "./condominio";

const TMP_DIR = path.join(process.cwd(), "data", "tmp-email");
fs.mkdirSync(TMP_DIR, { recursive: true });

function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Envia email via CLI `send-email` (mesmo pipeline dos recibos/avisos).
 * HTML vai por ficheiro temporário + stdin para evitar problemas com aspas.
 */
export async function sendPlainEmail(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const to = params.to.trim();
  if (!to) throw new Error("Destinatário de email em falta.");

  const tmpHtml = path.join(TMP_DIR, `email_${Date.now()}_${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tmpHtml, params.html, "utf8");

  await new Promise<void>((resolve, reject) => {
    const cmd = `cat ${shellQuote(tmpHtml)} | send-email --to ${shellQuote(to)} --subject ${shellQuote(params.subject)} --html -`;
    exec(cmd, { timeout: 60_000 }, (err, _stdout, stderr) => {
      try { fs.unlinkSync(tmpHtml); } catch { /* ignore */ }
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

/** Destino por omissão: email da fração na BD; fallback para email do user da app. */
export function resolverEmailFracao(opts: {
  fracaoEmail?: string | null;
  userEmail?: string | null;
}): string | null {
  const fracao = opts.fracaoEmail?.trim() || null;
  if (fracao) return fracao;
  const user = opts.userEmail?.trim() || null;
  return user || null;
}

export async function enviarConfirmacaoPedidoRecebido(params: {
  para: string;
  nome: string;
  titulo: string;
  fracaoNumero?: string | null;
}): Promise<void> {
  const subject = `Pedido recebido — ${params.titulo}`;
  const html = `
    <p>Exmo/a Sr/a. ${params.nome},</p>
    <p>Confirmamos a receção do seu pedido${params.fracaoNumero ? ` (fração <strong>${params.fracaoNumero}</strong>)` : ""}:</p>
    <p><em>«${params.titulo}»</em></p>
    <p>A administração irá analisar a situação e responderá em breve através do portal do condomínio.</p>
    <br>
    <p>Com os melhores cumprimentos,</p>
    <p><strong>A Administração do Condomínio</strong><br>
    ${CONDOMINIO.nome}</p>
  `;
  await sendPlainEmail({ to: params.para, subject, html });
}

export async function notificarAdminNovoPedido(params: {
  titulo: string;
  fracaoNumero?: string | null;
  categoria: string;
  urgencia: string;
  resumo?: string | null;
}): Promise<void> {
  const adminEmail = (process.env.ADMIN_NOTIFY_EMAIL || CONDOMINIO.email).trim();
  if (!adminEmail) return;

  const subject = `[Pedido] ${params.urgencia.toUpperCase()} · Fr. ${params.fracaoNumero ?? "?"} — ${params.titulo}`;
  const html = `
    <p>Novo pedido no portal.</p>
    <ul>
      <li><strong>Fração:</strong> ${params.fracaoNumero ?? "—"}</li>
      <li><strong>Categoria:</strong> ${params.categoria}</li>
      <li><strong>Urgência:</strong> ${params.urgencia}</li>
      <li><strong>Título:</strong> ${params.titulo}</li>
    </ul>
    ${params.resumo ? `<p><strong>Resumo LLM:</strong> ${params.resumo}</p>` : ""}
    <p>Abra a fila de Pedidos na aplicação para responder.</p>
  `;
  await sendPlainEmail({ to: adminEmail, subject, html });
}
