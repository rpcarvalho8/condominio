import { Hono } from "hono";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db } from "../database";
import {
  fracoes,
  ticketAttachments,
  ticketLlmFeedback,
  ticketMessages,
  tickets,
  user,
} from "../database/schema";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { triarPedidoTicket } from "../lib/ticket-llm";
import {
  enviarConfirmacaoPedidoRecebido,
  notificarAdminNovoPedido,
  resolverEmailFracao,
} from "../lib/ticket-email";

const STATUS_OK = new Set(["aberto", "em_curso", "aguarda_condomino", "resolvido", "cancelado"]);
const CATEGORIA_OK = new Set(["manutencao", "ruido", "financeiro", "juridico", "administrativo", "outro"]);
const URGENCIA_OK = new Set(["baixa", "normal", "alta", "urgente"]);

const UPLOAD_DIR = path.join(process.cwd(), "data", "tickets");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_FILES = 5;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v"]);

function isAdmin(u: any) {
  return u?.role === "admin";
}

async function loadTicketOr404(id: string) {
  const [row] = await db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
  return row ?? null;
}

function canAccessTicket(u: any, ticket: typeof tickets.$inferSelect) {
  if (isAdmin(u)) return true;
  return Boolean(u?.fracaoId && u.fracaoId === ticket.fracaoId);
}

function detectKind(ext: string, mime: string): "image" | "video" | null {
  if (IMAGE_EXT.has(ext) || mime.startsWith("image/")) return "image";
  if (VIDEO_EXT.has(ext) || mime.startsWith("video/")) return "video";
  return null;
}

async function saveUploadedFiles(opts: {
  ticketId: string;
  messageId: string | null;
  userId: string;
  files: File[];
}) {
  const saved: Array<typeof ticketAttachments.$inferSelect> = [];
  for (const file of opts.files.slice(0, MAX_FILES)) {
    const ext = path.extname(file.name).toLowerCase() || "";
    const mime = file.type || "application/octet-stream";
    const kind = detectKind(ext, mime);
    if (!kind) continue;
    if (file.size > MAX_FILE_BYTES) continue;

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length === 0) continue;

    const filename = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}${ext || (kind === "image" ? ".jpg" : ".mp4")}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);

    const [row] = await db.insert(ticketAttachments).values({
      ticketId: opts.ticketId,
      messageId: opts.messageId,
      uploadedByUserId: opts.userId,
      kind,
      mimeType: mime,
      originalName: file.name.slice(0, 180),
      filename,
      sizeBytes: buffer.length,
    }).returning();
    saved.push(row);
  }
  return saved;
}

function collectFilesFromBody(body: Record<string, unknown>): File[] {
  const files: File[] = [];
  const raw = body.files ?? body.file;
  if (!raw) return files;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const item of list) {
    if (item && typeof item !== "string") files.push(item as File);
  }
  return files;
}

async function exemplosArea(categoria: string): Promise<string | undefined> {
  const positivelyRated = await db
    .select({
      titulo: tickets.titulo,
      resumo: tickets.llmResumo,
      urgencia: tickets.urgencia,
      sugestao: tickets.llmSugestaoResposta,
      rating: tickets.llmFeedbackRating,
    })
    .from(tickets)
    .where(and(
      eq(tickets.categoria, categoria),
      eq(tickets.llmFeedbackRating, "positive"),
      ne(tickets.status, "cancelado"),
    ))
    .orderBy(desc(tickets.llmFeedbackAt))
    .limit(4);

  const recent = await db
    .select({
      titulo: tickets.titulo,
      resumo: tickets.llmResumo,
      urgencia: tickets.urgencia,
      sugestao: tickets.llmSugestaoResposta,
      rating: tickets.llmFeedbackRating,
    })
    .from(tickets)
    .where(and(eq(tickets.categoria, categoria), ne(tickets.status, "cancelado")))
    .orderBy(desc(tickets.updatedAt))
    .limit(3);

  const corrections = await db
    .select({
      comment: ticketLlmFeedback.comment,
      correctedCategoria: ticketLlmFeedback.correctedCategoria,
      correctedUrgencia: ticketLlmFeedback.correctedUrgencia,
      correctedResposta: ticketLlmFeedback.correctedResposta,
      llmCategoria: ticketLlmFeedback.llmCategoria,
      llmUrgencia: ticketLlmFeedback.llmUrgencia,
      rating: ticketLlmFeedback.rating,
    })
    .from(ticketLlmFeedback)
    .innerJoin(tickets, eq(ticketLlmFeedback.ticketId, tickets.id))
    .where(and(
      eq(tickets.categoria, categoria),
      eq(ticketLlmFeedback.rating, "negative"),
    ))
    .orderBy(desc(ticketLlmFeedback.createdAt))
    .limit(4);

  const parts: string[] = [];

  if (positivelyRated.length > 0) {
    parts.push(
      "Exemplos aprovados pela administração (imitar tom e estrutura):",
      ...positivelyRated.map((r, i) =>
        `${i + 1}. [${r.urgencia}] ${r.titulo} — ${r.resumo ?? ""}\nResposta modelo (excerto): ${(r.sugestao ?? "").slice(0, 280)}`,
      ),
    );
  } else if (recent.length > 0) {
    parts.push(
      "Casos recentes desta área:",
      ...recent.map((r, i) => `${i + 1}. [${r.urgencia}] ${r.titulo} — ${r.resumo ?? ""}`),
    );
  }

  if (corrections.length > 0) {
    parts.push(
      "Correcções (evitar estes erros):",
      ...corrections.map((c, i) => {
        const bits = [
          c.llmCategoria && c.correctedCategoria && c.llmCategoria !== c.correctedCategoria
            ? `categoria LLM=${c.llmCategoria} → correcta=${c.correctedCategoria}`
            : null,
          c.llmUrgencia && c.correctedUrgencia && c.llmUrgencia !== c.correctedUrgencia
            ? `urgência LLM=${c.llmUrgencia} → correcta=${c.correctedUrgencia}`
            : null,
          c.comment ? `nota: ${c.comment}` : null,
          c.correctedResposta ? `resposta preferida (excerto): ${c.correctedResposta.slice(0, 200)}` : null,
        ].filter(Boolean);
        return `${i + 1}. ${bits.join("; ") || "sugestão rejeitada"}`;
      }),
    );
  }

  return parts.length > 0 ? parts.join("\n") : undefined;
}

export const ticketsRoutes = new Hono()
  .use(requireAuth)
  .get("/", async (c) => {
    const u = c.get("user") as any;
    const statusFilter = c.req.query("status");

    let rows;
    if (isAdmin(u)) {
      rows = await db
        .select({
          id: tickets.id,
          fracaoId: tickets.fracaoId,
          fracaoNumero: fracoes.numero,
          createdByUserId: tickets.createdByUserId,
          titulo: tickets.titulo,
          descricao: tickets.descricao,
          categoria: tickets.categoria,
          urgencia: tickets.urgencia,
          status: tickets.status,
          llmResumo: tickets.llmResumo,
          llmSugestaoResposta: tickets.llmSugestaoResposta,
          llmNotasInternas: tickets.llmNotasInternas,
          llmFeedbackRating: tickets.llmFeedbackRating,
          llmFeedbackAt: tickets.llmFeedbackAt,
          createdAt: tickets.createdAt,
          updatedAt: tickets.updatedAt,
          resolvedAt: tickets.resolvedAt,
        })
        .from(tickets)
        .leftJoin(fracoes, eq(tickets.fracaoId, fracoes.id))
        .orderBy(desc(tickets.updatedAt));
    } else {
      if (!u.fracaoId) return c.json({ message: "Sem fração associada." }, 400);
      rows = await db
        .select({
          id: tickets.id,
          fracaoId: tickets.fracaoId,
          fracaoNumero: fracoes.numero,
          createdByUserId: tickets.createdByUserId,
          titulo: tickets.titulo,
          descricao: tickets.descricao,
          categoria: tickets.categoria,
          urgencia: tickets.urgencia,
          status: tickets.status,
          llmResumo: tickets.llmResumo,
          llmSugestaoResposta: tickets.llmSugestaoResposta,
          llmNotasInternas: tickets.llmNotasInternas,
          llmFeedbackRating: tickets.llmFeedbackRating,
          llmFeedbackAt: tickets.llmFeedbackAt,
          createdAt: tickets.createdAt,
          updatedAt: tickets.updatedAt,
          resolvedAt: tickets.resolvedAt,
        })
        .from(tickets)
        .leftJoin(fracoes, eq(tickets.fracaoId, fracoes.id))
        .where(eq(tickets.fracaoId, u.fracaoId))
        .orderBy(desc(tickets.updatedAt));
    }

    const filtered = statusFilter
      ? rows.filter((r) => r.status === statusFilter)
      : rows;
    return c.json(filtered);
  })
  .get("/attachments/:attachmentId", async (c) => {
    const u = c.get("user") as any;
    const attachmentId = c.req.param("attachmentId");
    const [att] = await db.select().from(ticketAttachments).where(eq(ticketAttachments.id, attachmentId)).limit(1);
    if (!att) return c.json({ message: "Anexo não encontrado." }, 404);
    const ticket = await loadTicketOr404(att.ticketId);
    if (!ticket || !canAccessTicket(u, ticket)) return c.json({ message: "Acesso negado." }, 403);

    const absolute = path.join(UPLOAD_DIR, att.filename);
    if (!fs.existsSync(absolute)) return c.json({ message: "Ficheiro em falta." }, 404);
    const buf = fs.readFileSync(absolute);
    return new Response(buf, {
      headers: {
        "Content-Type": att.mimeType,
        "Content-Disposition": `inline; filename="${att.originalName.replace(/"/g, "")}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  })
  .get("/:id", async (c) => {
    const u = c.get("user") as any;
    const id = c.req.param("id");
    const ticket = await loadTicketOr404(id);
    if (!ticket) return c.json({ message: "Pedido não encontrado." }, 404);
    if (!canAccessTicket(u, ticket)) return c.json({ message: "Acesso negado." }, 403);

    const [fracao] = await db.select({ numero: fracoes.numero }).from(fracoes).where(eq(fracoes.id, ticket.fracaoId)).limit(1);
    const messages = await db
      .select({
        id: ticketMessages.id,
        ticketId: ticketMessages.ticketId,
        userId: ticketMessages.userId,
        authorRole: ticketMessages.authorRole,
        body: ticketMessages.body,
        createdAt: ticketMessages.createdAt,
        authorName: user.name,
      })
      .from(ticketMessages)
      .leftJoin(user, eq(ticketMessages.userId, user.id))
      .where(eq(ticketMessages.ticketId, id))
      .orderBy(asc(ticketMessages.createdAt));

    const attachments = await db
      .select({
        id: ticketAttachments.id,
        ticketId: ticketAttachments.ticketId,
        messageId: ticketAttachments.messageId,
        kind: ticketAttachments.kind,
        mimeType: ticketAttachments.mimeType,
        originalName: ticketAttachments.originalName,
        sizeBytes: ticketAttachments.sizeBytes,
        createdAt: ticketAttachments.createdAt,
        url: ticketAttachments.id,
      })
      .from(ticketAttachments)
      .where(eq(ticketAttachments.ticketId, id))
      .orderBy(asc(ticketAttachments.createdAt));

    return c.json({
      ...ticket,
      fracaoNumero: fracao?.numero ?? null,
      messages,
      attachments: attachments.map((a) => ({
        ...a,
        url: `/api/tickets/attachments/${a.id}`,
      })),
      // notas internas só para admin
      llmNotasInternas: isAdmin(u) ? ticket.llmNotasInternas : undefined,
    });
  })
  .post("/", async (c) => {
    const u = c.get("user") as any;
    const contentType = c.req.header("content-type") ?? "";
    let titulo = "";
    let descricao = "";
    let fracaoId = u.fracaoId as string | null;
    let files: File[] = [];

    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody({ all: true });
      titulo = String(body.titulo ?? "").trim();
      descricao = String(body.descricao ?? "").trim();
      if (isAdmin(u) && typeof body.fracaoId === "string") fracaoId = body.fracaoId;
      files = collectFilesFromBody(body as Record<string, unknown>);
    } else {
      const body = await c.req.json().catch(() => ({} as any));
      titulo = String(body.titulo ?? "").trim();
      descricao = String(body.descricao ?? "").trim();
      if (isAdmin(u) && typeof body.fracaoId === "string") fracaoId = body.fracaoId;
    }

    if (!titulo) return c.json({ message: "Título é obrigatório." }, 400);
    if (!descricao) return c.json({ message: "Descrição é obrigatória." }, 400);
    if (!fracaoId) return c.json({ message: "Fração não associada. Contacte a administração." }, 400);

    const [fracao] = await db.select().from(fracoes).where(eq(fracoes.id, fracaoId)).limit(1);
    if (!fracao) return c.json({ message: "Fração inválida." }, 400);

    let triage = await triarPedidoTicket({
      titulo,
      descricao,
      anexosCount: files.length,
    }).catch(() => null);

    if (!triage) {
      triage = {
        categoria: "outro",
        urgencia: "normal",
        resumo: descricao.slice(0, 200),
        sugestaoResposta: "Confirmamos a receção do pedido. A administração irá analisar em breve.",
        notasInternas: "Triagem automática indisponível.",
      };
    } else {
      // 2ª passagem com memória da área (casos semelhantes)
      try {
        const exemplos = await exemplosArea(triage.categoria);
        if (exemplos) {
          triage = await triarPedidoTicket({
            titulo,
            descricao,
            anexosCount: files.length,
            exemplosArea: exemplos,
          });
        }
      } catch {
        // mantém primeira triagem
      }
    }

    const [created] = await db.insert(tickets).values({
      fracaoId,
      createdByUserId: u.id,
      titulo,
      descricao,
      categoria: triage.categoria,
      urgencia: triage.urgencia,
      status: "aberto",
      llmCategoria: triage.categoria,
      llmUrgencia: triage.urgencia,
      llmResumo: triage.resumo,
      llmSugestaoResposta: triage.sugestaoResposta,
      llmNotasInternas: triage.notasInternas,
    }).returning();

    const [firstMsg] = await db.insert(ticketMessages).values({
      ticketId: created.id,
      userId: u.id,
      authorRole: isAdmin(u) ? "admin" : "condomino",
      body: descricao,
    }).returning();

    if (files.length > 0) {
      await saveUploadedFiles({
        ticketId: created.id,
        messageId: firstMsg.id,
        userId: u.id,
        files,
      });
    }

    await db.insert(ticketMessages).values({
      ticketId: created.id,
      userId: u.id,
      authorRole: "system",
      body: `Triagem automática: categoria=${triage.categoria}, urgência=${triage.urgencia}. ${triage.resumo}`,
    });

    // Destino: email da fração na BD; fallback só se a fração não tiver email
    const emailTo = resolverEmailFracao({
      fracaoEmail: fracao.proprietarioEmail,
      userEmail: u.email,
    });
    const nome = fracao.proprietarioNome || (u.name as string | undefined) || "Condómino";

    if (emailTo) {
      try {
        await enviarConfirmacaoPedidoRecebido({
          para: emailTo,
          nome,
          titulo,
          fracaoNumero: fracao.numero,
        });
        await db.insert(ticketMessages).values({
          ticketId: created.id,
          userId: u.id,
          authorRole: "system",
          body: `Email de confirmação enviado para ${emailTo} (email da fração).`,
        });
      } catch (e: any) {
        console.error("[tickets] email confirmação:", e);
        await db.insert(ticketMessages).values({
          ticketId: created.id,
          userId: u.id,
          authorRole: "system",
          body: `Falha ao enviar email de confirmação para ${emailTo}: ${String(e?.message ?? e).slice(0, 200)}`,
        });
      }
    } else {
      await db.insert(ticketMessages).values({
        ticketId: created.id,
        userId: u.id,
        authorRole: "system",
        body: "Sem email na fração (proprietario_email) nem no utilizador — confirmação por email não enviada.",
      });
    }

    try {
      await notificarAdminNovoPedido({
        titulo,
        fracaoNumero: fracao.numero,
        categoria: triage.categoria,
        urgencia: triage.urgencia,
        resumo: triage.resumo,
      });
    } catch (e) {
      console.error("[tickets] email admin:", e);
    }

    return c.json({ ...created, emailConfirmacao: emailTo }, 201);
  })
  .post("/:id/attachments", async (c) => {
    const u = c.get("user") as any;
    const id = c.req.param("id");
    const ticket = await loadTicketOr404(id);
    if (!ticket) return c.json({ message: "Pedido não encontrado." }, 404);
    if (!canAccessTicket(u, ticket)) return c.json({ message: "Acesso negado." }, 403);

    const body = await c.req.parseBody({ all: true });
    const files = collectFilesFromBody(body as Record<string, unknown>);
    if (files.length === 0) return c.json({ message: "Sem ficheiros válidos (imagem/vídeo)." }, 400);

    const saved = await saveUploadedFiles({
      ticketId: id,
      messageId: null,
      userId: u.id,
      files,
    });
    if (saved.length === 0) {
      return c.json({ message: "Formatos não suportados ou ficheiros demasiado grandes (máx. 40MB)." }, 400);
    }

    await db.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, id));
    return c.json(saved.map((a) => ({ ...a, url: `/api/tickets/attachments/${a.id}` })), 201);
  })
  .patch("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const ticket = await loadTicketOr404(id);
    if (!ticket) return c.json({ message: "Pedido não encontrado." }, 404);

    const body = await c.req.json().catch(() => ({} as any));
    const patch: Partial<typeof tickets.$inferInsert> = { updatedAt: new Date() };

    if (typeof body.titulo === "string") patch.titulo = body.titulo.trim();
    if (typeof body.descricao === "string") patch.descricao = body.descricao.trim();
    if (typeof body.status === "string" && STATUS_OK.has(body.status)) {
      patch.status = body.status;
      if (body.status === "resolvido") patch.resolvedAt = new Date();
      if (body.status !== "resolvido") patch.resolvedAt = null;
    }
    if (typeof body.categoria === "string" && CATEGORIA_OK.has(body.categoria)) patch.categoria = body.categoria;
    if (typeof body.urgencia === "string" && URGENCIA_OK.has(body.urgencia)) patch.urgencia = body.urgencia;
    if (typeof body.llmSugestaoResposta === "string") patch.llmSugestaoResposta = body.llmSugestaoResposta;

    const [updated] = await db.update(tickets).set(patch).where(eq(tickets.id, id)).returning();
    return c.json(updated);
  })
  .post("/:id/messages", async (c) => {
    const u = c.get("user") as any;
    const id = c.req.param("id");
    const ticket = await loadTicketOr404(id);
    if (!ticket) return c.json({ message: "Pedido não encontrado." }, 404);
    if (!canAccessTicket(u, ticket)) return c.json({ message: "Acesso negado." }, 403);
    if (["resolvido", "cancelado"].includes(ticket.status) && !isAdmin(u)) {
      return c.json({ message: "Pedido fechado. Contacte a administração para reabrir." }, 400);
    }

    const contentType = c.req.header("content-type") ?? "";
    let text = "";
    let files: File[] = [];
    let marcarAguarda = false;

    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody({ all: true });
      text = String(body.body ?? "").trim();
      marcarAguarda = String(body.marcarAguarda ?? "") === "true";
      files = collectFilesFromBody(body as Record<string, unknown>);
    } else {
      const body = await c.req.json().catch(() => ({} as any));
      text = String(body.body ?? "").trim();
      marcarAguarda = body.marcarAguarda === true;
    }

    if (!text && files.length === 0) return c.json({ message: "Mensagem vazia." }, 400);

    const [msg] = await db.insert(ticketMessages).values({
      ticketId: id,
      userId: u.id,
      authorRole: isAdmin(u) ? "admin" : "condomino",
      body: text || "(anexo multimédia)",
    }).returning();

    if (files.length > 0) {
      await saveUploadedFiles({
        ticketId: id,
        messageId: msg.id,
        userId: u.id,
        files,
      });
    }

    const statusPatch: Partial<typeof tickets.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (isAdmin(u) && ticket.status === "aberto") statusPatch.status = "em_curso";
    if (!isAdmin(u) && ticket.status === "aguarda_condomino") statusPatch.status = "em_curso";
    if (isAdmin(u) && marcarAguarda) statusPatch.status = "aguarda_condomino";

    await db.update(tickets).set(statusPatch).where(eq(tickets.id, id));

    return c.json(msg, 201);
  })
  .post("/:id/triage", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const ticket = await loadTicketOr404(id);
    if (!ticket) return c.json({ message: "Pedido não encontrado." }, 404);

    const msgs = await db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, id))
      .orderBy(desc(ticketMessages.createdAt))
      .limit(10);

    const anexos = await db
      .select({ id: ticketAttachments.id })
      .from(ticketAttachments)
      .where(eq(ticketAttachments.ticketId, id));

    const historico = msgs
      .reverse()
      .map((m) => `[${m.authorRole}] ${m.body}`)
      .join("\n");

    try {
      const exemplos = await exemplosArea(ticket.categoria);
      const triage = await triarPedidoTicket({
        titulo: ticket.titulo,
        descricao: ticket.descricao,
        historico,
        anexosCount: anexos.length,
        exemplosArea: exemplos,
      });

      const [updated] = await db.update(tickets).set({
        categoria: triage.categoria,
        urgencia: triage.urgencia,
        llmCategoria: triage.categoria,
        llmUrgencia: triage.urgencia,
        llmResumo: triage.resumo,
        llmSugestaoResposta: triage.sugestaoResposta,
        llmNotasInternas: triage.notasInternas,
        updatedAt: new Date(),
      }).where(eq(tickets.id, id)).returning();

      return c.json(updated);
    } catch (e: any) {
      return c.json({ message: String(e?.message ?? "Falha na triagem.") }, 500);
    }
  })
  .post("/:id/feedback", requireAdmin, async (c) => {
    const u = c.get("user") as any;
    const id = c.req.param("id");
    const ticket = await loadTicketOr404(id);
    if (!ticket) return c.json({ message: "Pedido não encontrado." }, 404);

    const body = await c.req.json().catch(() => ({} as any));
    const rating = String(body.rating ?? "").trim();
    if (rating !== "positive" && rating !== "negative") {
      return c.json({ message: "rating deve ser positive ou negative." }, 400);
    }

    const target = ["sugestao", "categoria", "urgencia", "geral"].includes(String(body.target))
      ? String(body.target)
      : "geral";
    const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 1000) : null;

    // Se negativo e o admin já corrigiu categoria/urgência no pedido, grava como verdade
    const correctedCategoria =
      typeof body.correctedCategoria === "string" && CATEGORIA_OK.has(body.correctedCategoria)
        ? body.correctedCategoria
        : ticket.categoria !== ticket.llmCategoria
          ? ticket.categoria
          : null;
    const correctedUrgencia =
      typeof body.correctedUrgencia === "string" && URGENCIA_OK.has(body.correctedUrgencia)
        ? body.correctedUrgencia
        : ticket.urgencia !== ticket.llmUrgencia
          ? ticket.urgencia
          : null;
    const correctedResposta =
      typeof body.correctedResposta === "string" && body.correctedResposta.trim()
        ? body.correctedResposta.trim().slice(0, 4000)
        : null;

    // Se positive e a resposta no textarea for a enviada, pode gravar como modelo
    const positiveResposta =
      rating === "positive" && typeof body.correctedResposta === "string" && body.correctedResposta.trim()
        ? body.correctedResposta.trim().slice(0, 4000)
        : rating === "positive"
          ? ticket.llmSugestaoResposta
          : correctedResposta;

    const [fb] = await db.insert(ticketLlmFeedback).values({
      ticketId: id,
      userId: u.id,
      rating,
      target,
      comment,
      correctedCategoria: rating === "negative" ? correctedCategoria : null,
      correctedUrgencia: rating === "negative" ? correctedUrgencia : null,
      correctedResposta: rating === "negative" ? correctedResposta : (positiveResposta ?? null),
      llmCategoria: ticket.llmCategoria,
      llmUrgencia: ticket.llmUrgencia,
      llmSugestaoResposta: ticket.llmSugestaoResposta,
    }).returning();

    await db.update(tickets).set({
      llmFeedbackRating: rating,
      llmFeedbackAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(tickets.id, id));

    await db.insert(ticketMessages).values({
      ticketId: id,
      userId: u.id,
      authorRole: "system",
      body: rating === "positive"
        ? "Feedback LLM: sugestão marcada como útil — será usada como exemplo nesta área."
        : `Feedback LLM: sugestão rejeitada${comment ? ` (${comment})` : ""}. Correcção guardada para aprendizagem.`,
    });

    return c.json(fb, 201);
  })
  .delete("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const ticket = await loadTicketOr404(id);
    if (!ticket) return c.json({ message: "Pedido não encontrado." }, 404);

    const atts = await db.select().from(ticketAttachments).where(eq(ticketAttachments.ticketId, id));
    for (const a of atts) {
      const p = path.join(UPLOAD_DIR, a.filename);
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
    await db.delete(tickets).where(eq(tickets.id, id));
    return c.json({ ok: true });
  });
