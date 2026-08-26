import { Hono } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../database";
import { emailInbox, fracoes, tickets, ticketMessages } from "../database/schema";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { CONDOMINIO } from "../lib/condominio";
import { triarEmailInbox } from "../lib/email-llm";
import { matchFracaoByEmail, runEmailTicketPipeline } from "../lib/email-ticket-pipeline";
import { fetchNewGmailMessages, formatImapError, isGmailImapConfigured, isImapSessionBusy, sanitizeStoredBody, type FetchedEmail } from "../lib/gmail-imap";
import { sendPlainEmail } from "../lib/ticket-email";

const STATUS_OK = new Set(["novo", "em_analise", "respondido", "convertido_pedido", "ignorado", "spam", "processado"]);
const CATEGORIA_OK = new Set([
  "manutencao", "ruido", "financeiro", "juridico", "administrativo", "fornecedor", "spam", "outro",
]);
const URGENCIA_OK = new Set(["baixa", "normal", "alta", "urgente"]);

/** @deprecated Use runEmailTicketPipeline — mantido para compatibilidade de imports */
export async function ingestFetchedEmail(mail: FetchedEmail): Promise<{
  created: boolean;
  row: typeof emailInbox.$inferSelect;
}> {
  const res = await runEmailTicketPipeline(mail);
  return { created: res.created, row: res.email };
}

export async function syncGmailInbox(): Promise<{
  fetched: number;
  created: number;
  tickets: number;
  errors: string[];
}> {
  if (!isGmailImapConfigured()) {
    return { fetched: 0, created: 0, tickets: 0, errors: ["GMAIL_APP_PASSWORD não configurada."] };
  }
  const errors: string[] = [];
  let created = 0;
  let ticketsCreated = 0;
  let fetched = 0;
  try {
    const mails = await fetchNewGmailMessages({ limit: 8 });
    fetched = mails.length;
    for (const mail of mails) {
      try {
        const res = await runEmailTicketPipeline(mail);
        if (res.created) created++;
        if (res.ticketId) ticketsCreated++;
      } catch (e: any) {
        errors.push(`${mail.externalId}: ${String(e?.message ?? e)}`);
      }
    }
  } catch (e: any) {
    errors.push(formatImapError(e));
  }
  return { fetched, created, tickets: ticketsCreated, errors };
}

export const emailInboxRoutes = new Hono()
  // Ingestão externa (webhook) — secret opcional
  .post("/ingest", async (c) => {
    const secret = process.env.EMAIL_INGEST_SECRET?.trim();
    if (secret) {
      const hdr = c.req.header("x-ingest-secret") || c.req.query("secret");
      if (hdr !== secret) return c.json({ message: "Não autorizado." }, 401);
    }

    const body = await c.req.json().catch(() => ({} as any));
    const fromEmail = String(body.fromEmail ?? body.from ?? "").trim().toLowerCase();
    const subject = String(body.subject ?? "").trim();
    const bodyText = String(body.bodyText ?? body.text ?? body.body ?? "").trim();
    if (!fromEmail) return c.json({ message: "fromEmail obrigatório." }, 400);

    const mail: FetchedEmail = {
      externalId: String(body.externalId ?? body.messageId ?? `ingest-${Date.now()}-${fromEmail}-${subject}`).slice(0, 500),
      fromEmail,
      fromName: body.fromName ? String(body.fromName) : null,
      toEmail: String(body.toEmail ?? CONDOMINIO.email).toLowerCase(),
      subject: subject || "(sem assunto)",
      bodyText,
      bodyHtml: body.bodyHtml ? String(body.bodyHtml) : null,
      receivedAt: body.receivedAt ? new Date(body.receivedAt) : new Date(),
      gmailLabel: body.gmailLabel ? String(body.gmailLabel) : "Caixa de entrada",
    };

    const res = await runEmailTicketPipeline(mail);
    return c.json(res, res.created ? 201 : 200);
  })
  .use(requireAuth)
  .use(requireAdmin)
  .get("/", async (c) => {
    const status = c.req.query("status");
    const label = c.req.query("label");
    const rows = await db
      .select({
        id: emailInbox.id,
        fromEmail: emailInbox.fromEmail,
        fromName: emailInbox.fromName,
        subject: emailInbox.subject,
        categoria: emailInbox.categoria,
        urgencia: emailInbox.urgencia,
        status: emailInbox.status,
        llmResumo: emailInbox.llmResumo,
        gmailLabel: emailInbox.gmailLabel,
        fracaoId: emailInbox.fracaoId,
        fracaoNumero: fracoes.numero,
        ticketId: emailInbox.ticketId,
        receivedAt: emailInbox.receivedAt,
        updatedAt: emailInbox.updatedAt,
      })
      .from(emailInbox)
      .leftJoin(fracoes, eq(emailInbox.fracaoId, fracoes.id))
      .orderBy(desc(emailInbox.receivedAt))
      .limit(200);

    let filtered = rows;
    if (status === "a_tratar") {
      filtered = filtered.filter((r) => r.status === "novo" || r.status === "em_analise");
    } else if (status === "arquivo") {
      filtered = filtered.filter((r) => !["novo", "em_analise"].includes(r.status));
    } else if (status) {
      filtered = filtered.filter((r) => r.status === status);
    }
    if (label) {
      filtered = filtered.filter((r) => (r.gmailLabel || "Caixa de entrada") === label);
    }
    return c.json(filtered);
  })
  .get("/stats", async (c) => {
    const [row] = await db
      .select({
        total: sql<number>`count(*)`,
        novos: sql<number>`sum(case when ${emailInbox.status} = 'novo' then 1 else 0 end)`,
      })
      .from(emailInbox);
    const labelRows = await db
      .select({
        label: emailInbox.gmailLabel,
        n: sql<number>`count(*)`,
      })
      .from(emailInbox)
      .groupBy(emailInbox.gmailLabel);
    const labels = labelRows
      .map((r) => ({
        label: r.label || "Caixa de entrada",
        count: Number(r.n ?? 0),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "pt"));
    return c.json({
      total: Number(row?.total ?? 0),
      novos: Number(row?.novos ?? 0),
      gmailConfigured: isGmailImapConfigured(),
      inboxAddress: CONDOMINIO.email,
      labels,
    });
  })
  .post("/sync", async (c) => {
    if (isImapSessionBusy()) {
      return c.json({
        fetched: 0,
        created: 0,
        tickets: 0,
        errors: ["Sync IMAP já em curso — aguarde."],
      }, 409);
    }
    const result = await syncGmailInbox();
    return c.json(result);
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await db
      .select({
        email: emailInbox,
        fracaoNumero: fracoes.numero,
      })
      .from(emailInbox)
      .leftJoin(fracoes, eq(emailInbox.fracaoId, fracoes.id))
      .where(eq(emailInbox.id, id))
      .limit(1);
    if (!row) return c.json({ message: "Email não encontrado." }, 404);
    const email = row.email;
    return c.json({
      ...email,
      fracaoNumero: row.fracaoNumero,
      bodyText: sanitizeStoredBody(email.bodyText),
      llmResumo: email.llmResumo && /Content-Transfer-Encoding/i.test(email.llmResumo)
        ? null
        : email.llmResumo,
    });
  })
  .patch("/:id", async (c) => {
    const id = c.req.param("id");
    const [existing] = await db.select().from(emailInbox).where(eq(emailInbox.id, id)).limit(1);
    if (!existing) return c.json({ message: "Email não encontrado." }, 404);

    const body = await c.req.json().catch(() => ({} as any));
    const patch: Partial<typeof emailInbox.$inferInsert> = { updatedAt: new Date() };
    if (typeof body.status === "string" && STATUS_OK.has(body.status)) patch.status = body.status;
    if (typeof body.categoria === "string" && CATEGORIA_OK.has(body.categoria)) patch.categoria = body.categoria;
    if (typeof body.urgencia === "string" && URGENCIA_OK.has(body.urgencia)) patch.urgencia = body.urgencia;
    if (typeof body.fracaoId === "string" || body.fracaoId === null) patch.fracaoId = body.fracaoId;
    if (typeof body.llmSugestaoResposta === "string") patch.llmSugestaoResposta = body.llmSugestaoResposta;
    if (typeof body.replyBody === "string") patch.replyBody = body.replyBody;

    const [updated] = await db.update(emailInbox).set(patch).where(eq(emailInbox.id, id)).returning();
    return c.json(updated);
  })
  .post("/:id/triage", async (c) => {
    const id = c.req.param("id");
    const [existing] = await db.select().from(emailInbox).where(eq(emailInbox.id, id)).limit(1);
    if (!existing) return c.json({ message: "Email não encontrado." }, 404);

    let fracaoNumero: string | null = null;
    if (existing.fracaoId) {
      const [f] = await db.select({ numero: fracoes.numero }).from(fracoes).where(eq(fracoes.id, existing.fracaoId)).limit(1);
      fracaoNumero = f?.numero ?? null;
    }

    try {
      const triage = await triarEmailInbox({
        fromEmail: existing.fromEmail,
        fromName: existing.fromName,
        subject: existing.subject,
        bodyText: existing.bodyText || "",
        fracaoNumero,
      });
      const [updated] = await db.update(emailInbox).set({
        categoria: triage.categoria,
        urgencia: triage.urgencia,
        llmResumo: triage.resumo,
        llmSugestaoResposta: triage.sugestaoResposta,
        llmNotasInternas: triage.notasInternas,
        status: triage.isSpam ? "spam" : existing.status === "spam" ? "novo" : existing.status,
        processedAt: triage.isSpam ? new Date() : existing.processedAt,
        updatedAt: new Date(),
      }).where(eq(emailInbox.id, id)).returning();
      return c.json(updated);
    } catch (e: any) {
      return c.json({ message: String(e?.message ?? "Falha na triagem.") }, 500);
    }
  })
  .post("/:id/reply", async (c) => {
    const id = c.req.param("id");
    const [existing] = await db.select().from(emailInbox).where(eq(emailInbox.id, id)).limit(1);
    if (!existing) return c.json({ message: "Email não encontrado." }, 404);

    const body = await c.req.json().catch(() => ({} as any));
    const reply =
      (typeof body.body === "string" && body.body.trim())
      || existing.replyBody?.trim()
      || existing.llmSugestaoResposta?.trim()
      || "";
    if (!reply) return c.json({ message: "Resposta vazia." }, 400);

    const subject = existing.subject.startsWith("Re:")
      ? existing.subject
      : `Re: ${existing.subject}`;

    try {
      await sendPlainEmail({
        to: existing.fromEmail,
        subject,
        html: reply.replace(/\n/g, "<br>\n"),
      });
    } catch (e: any) {
      return c.json({ message: `Falha ao enviar: ${String(e?.message ?? e)}` }, 500);
    }

    const [updated] = await db.update(emailInbox).set({
      replyBody: reply,
      repliedAt: new Date(),
      status: "respondido",
      processedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(emailInbox.id, id)).returning();

    return c.json(updated);
  })
  .post("/:id/criar-pedido", async (c) => {
    const u = c.get("user") as any;
    const id = c.req.param("id");
    const [existing] = await db.select().from(emailInbox).where(eq(emailInbox.id, id)).limit(1);
    if (!existing) return c.json({ message: "Email não encontrado." }, 404);
    if (existing.ticketId) return c.json({ message: "Já convertido em pedido.", ticketId: existing.ticketId }, 400);

    let fracaoId = existing.fracaoId;
    if (!fracaoId) {
      const matched = await matchFracaoByEmail(existing.fromEmail);
      fracaoId = matched?.id ?? null;
    }
    if (!fracaoId) {
      return c.json({ message: "Associe uma fração ao email antes de criar o pedido." }, 400);
    }

    const titulo = existing.subject.slice(0, 180) || "Pedido via email";
    const descricao =
      `Origem: email de ${existing.fromEmail}\n\n` +
      (existing.bodyText || existing.llmResumo || "(sem corpo)");

    const ticketCategoria = ["manutencao", "ruido", "financeiro", "juridico", "administrativo", "outro"].includes(existing.categoria)
      ? existing.categoria
      : "outro";

    const [ticket] = await db.insert(tickets).values({
      fracaoId,
      createdByUserId: u.id,
      titulo,
      descricao,
      categoria: ticketCategoria,
      urgencia: existing.urgencia,
      status: "pendente_aprovacao",
      origem: "email",
      llmCategoria: ticketCategoria,
      llmUrgencia: existing.urgencia,
      llmResumo: existing.llmResumo,
      llmSugestaoResposta: existing.llmSugestaoResposta,
      llmNotasInternas: existing.llmNotasInternas,
    }).returning();

    await db.insert(ticketMessages).values({
      ticketId: ticket.id,
      userId: u.id,
      authorRole: "system",
      body: `Pedido criado a partir do email inbox (${existing.id}). Assunto: ${existing.subject}`,
    });

    const [updated] = await db.update(emailInbox).set({
      ticketId: ticket.id,
      fracaoId,
      status: "convertido_pedido",
      processedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(emailInbox.id, id)).returning();

    return c.json({ email: updated, ticket });
  });

/** Cron: sync Gmail a cada 5 min se credentials presentes */
export function scheduleEmailInboxSync() {
  if (!isGmailImapConfigured()) {
    console.log("[email-inbox] GMAIL_APP_PASSWORD em falta — sync IMAP desactivado. Configure no .env.");
    return;
  }
  const FIVE_MIN = 5 * 60 * 1000;
  console.log(`[email-inbox] Sync Gmail activo para ${CONDOMINIO.email} (cada 5 min)`);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const res = await syncGmailInbox();
      if (res.created > 0 || res.tickets > 0 || res.errors.length > 0) {
        console.log(
          `[email-inbox] sync: fetched=${res.fetched} emails=${res.created} tickets=${res.tickets} errors=${res.errors.length}`,
        );
      }
    } catch (e) {
      console.error("[email-inbox] sync erro:", e);
    } finally {
      running = false;
    }
  };
  setTimeout(() => { void run(); setInterval(run, FIVE_MIN); }, 30_000);
}
