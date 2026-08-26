import { eq } from "drizzle-orm";
import { db } from "../database";
import { emailInbox, fracoes, ticketMessages, tickets, user } from "../database/schema";
import { CONDOMINIO } from "./condominio";
import { triarEmailInbox } from "./email-llm";
import type { FetchedEmail } from "./gmail-imap";

export type EmailPipelineResult = {
  created: boolean;
  email: typeof emailInbox.$inferSelect;
  ticketId: string | null;
  skipped?: "duplicate" | "spam" | "sem_fracao";
};

const TICKET_CATEGORIAS = new Set([
  "manutencao", "ruido", "financeiro", "juridico", "administrativo", "outro",
]);

export async function matchFracaoByEmail(fromEmail: string) {
  const email = fromEmail.trim().toLowerCase();
  if (!email) return null;
  const rows = await db.select().from(fracoes).where(eq(fracoes.ativo, true));
  return rows.find((f) => (f.proprietarioEmail || "").trim().toLowerCase() === email) ?? null;
}

async function resolveSystemActorUserId(): Promise<string> {
  const [admin] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.role, "admin"))
    .limit(1);
  if (!admin) throw new Error("Sem utilizador admin — impossível criar pedido via email.");
  return admin.id;
}

function mapTicketCategoria(categoria: string): string {
  if (TICKET_CATEGORIAS.has(categoria)) return categoria;
  if (categoria === "fornecedor") return "administrativo";
  return "outro";
}

/**
 * Pipeline headless: email bruto → triagem LLM → ticket (ou spam / fila sem fração).
 */
export async function runEmailTicketPipeline(mail: FetchedEmail): Promise<EmailPipelineResult> {
  const existing = await db
    .select()
    .from(emailInbox)
    .where(eq(emailInbox.externalId, mail.externalId))
    .limit(1);
  if (existing[0]) {
    return {
      created: false,
      email: existing[0],
      ticketId: existing[0].ticketId ?? null,
      skipped: "duplicate",
    };
  }

  const fracao = await matchFracaoByEmail(mail.fromEmail);
  const triage = await triarEmailInbox({
    fromEmail: mail.fromEmail,
    fromName: mail.fromName,
    subject: mail.subject,
    bodyText: mail.bodyText,
    fracaoNumero: fracao?.numero ?? null,
  }).catch(() => null);

  const now = new Date();

  if (triage?.isSpam) {
    const [row] = await db.insert(emailInbox).values({
      externalId: mail.externalId,
      fromEmail: mail.fromEmail,
      fromName: mail.fromName,
      toEmail: mail.toEmail || CONDOMINIO.email,
      subject: mail.subject,
      bodyText: mail.bodyText,
      bodyHtml: mail.bodyHtml,
      gmailLabel: mail.gmailLabel || "Caixa de entrada",
      receivedAt: mail.receivedAt,
      fracaoId: fracao?.id ?? null,
      categoria: "spam",
      urgencia: "baixa",
      llmResumo: triage.resumo,
      llmSugestaoResposta: null,
      llmNotasInternas: triage.notasInternas,
      status: "spam",
      processedAt: now,
    }).returning();

    return { created: true, email: row, ticketId: null, skipped: "spam" };
  }

  const [emailRow] = await db.insert(emailInbox).values({
    externalId: mail.externalId,
    fromEmail: mail.fromEmail,
    fromName: mail.fromName,
    toEmail: mail.toEmail || CONDOMINIO.email,
    subject: mail.subject,
    bodyText: mail.bodyText,
    bodyHtml: mail.bodyHtml,
    gmailLabel: mail.gmailLabel || "Caixa de entrada",
    receivedAt: mail.receivedAt,
    fracaoId: fracao?.id ?? null,
    categoria: triage?.categoria ?? "outro",
    urgencia: triage?.urgencia ?? "normal",
    llmResumo: triage?.resumo ?? null,
    llmSugestaoResposta: triage?.sugestaoResposta ?? null,
    llmNotasInternas: triage?.notasInternas ?? null,
    status: "novo",
  }).returning();

  if (!fracao) {
    return { created: true, email: emailRow, ticketId: null, skipped: "sem_fracao" };
  }

  const ticketCategoria = mapTicketCategoria(triage?.categoria ?? "outro");
  const titulo = mail.subject.slice(0, 180) || "Pedido via email";
  const descricao =
    `Origem: email de ${mail.fromEmail}\n\n` +
    (mail.bodyText || triage?.resumo || "(sem corpo)");

  const systemUserId = await resolveSystemActorUserId();

  const [ticket] = await db.insert(tickets).values({
    fracaoId: fracao.id,
    createdByUserId: systemUserId,
    titulo,
    descricao,
    categoria: ticketCategoria,
    urgencia: triage?.urgencia ?? "normal",
    status: "pendente_aprovacao",
    origem: "email",
    llmCategoria: ticketCategoria,
    llmUrgencia: triage?.urgencia ?? "normal",
    llmResumo: triage?.resumo ?? null,
    llmSugestaoResposta: triage?.sugestaoResposta ?? null,
    llmNotasInternas: triage?.notasInternas ?? null,
  }).returning();

  await db.insert(ticketMessages).values({
    ticketId: ticket.id,
    userId: systemUserId,
    authorRole: "system",
    body:
      `Email recebido de ${mail.fromName ? `${mail.fromName} ` : ""}<${mail.fromEmail}>\n` +
      `Assunto: ${mail.subject}\n\n` +
      (mail.bodyText || "(sem texto)"),
  });

  const [updatedEmail] = await db.update(emailInbox).set({
    ticketId: ticket.id,
    fracaoId: fracao.id,
    status: "convertido_pedido",
    processedAt: now,
    updatedAt: now,
  }).where(eq(emailInbox.id, emailRow.id)).returning();

  return {
    created: true,
    email: updatedEmail,
    ticketId: ticket.id,
  };
}
