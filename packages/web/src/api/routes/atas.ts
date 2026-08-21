import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db } from "../database";
import { ataVotes, atas, configuracoes, fracoes, user } from "../database/schema";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { transcribeAudioFilePath } from "../lib/stt";
import { gerarRascunhoAta } from "../lib/atas-llm";
import { gerarAtaPdf } from "../lib/ata-pdf";
import {
  conteudoToMarkdown,
  normalizeConteudo,
  resolveConteudo,
  serializeConteudo,
} from "../lib/ata-conteudo";

const UPLOAD_DIR = path.join(process.cwd(), "data", "assembleias");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_AUDIO_SIZE_BYTES = 120 * 1024 * 1024; // ~120MB (MediaRecorder/webm friendly)
const ALLOWED_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/webm",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/x-pn-wav",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
]);
const ALLOWED_EXTENSIONS = new Set([".mp3", ".m4a", ".mp4", ".wav", ".webm"]);

function isAllowedAudio(file: File): boolean {
  const ext = path.extname(file.name).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext) && (ALLOWED_MIME_TYPES.has(file.type) || file.type === "");
}

function sanitizeFilenamePart(input: string): string {
  return input.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 80);
}

function deleteFileIfExists(relativeOrAbsolute: string) {
  if (!relativeOrAbsolute || relativeOrAbsolute.includes("..")) return;
  const absolutePath = path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.join(process.cwd(), relativeOrAbsolute);
  try {
    if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  } catch {
    // Non-fatal
  }
}

function deletePdfByUrl(pdfUrl: string | null | undefined) {
  if (!pdfUrl) return;
  const match = pdfUrl.match(/\/api\/atas\/pdf\/([^/?]+)/);
  if (!match?.[1]) return;
  deleteFileIfExists(path.join("data", "atas", match[1]));
}

function canReadAta(user: any, status: string): boolean {
  if (user?.role === "admin") return true;
  return ["aprovada", "rejeitada", "aguardando_votos"].includes(status);
}

function toPublicAtaRow(row: typeof atas.$inferSelect) {
  return {
    id: row.id,
    titulo: row.titulo,
    dataReuniao: row.dataReuniao,
    status: row.status,
    ataTexto: row.ataTexto,
    conteudoJson: row.conteudoJson,
    resumoDeliberacoes: row.resumoDeliberacoes,
    pdfUrl: row.pdfUrl,
    pdfFinalizedAt: row.pdfFinalizedAt,
    approvalDeadlineAt: row.approvalDeadlineAt,
    audioAvailableUntil: row.audioAvailableUntil,
    approvedAt: row.approvedAt,
    rejectedAt: row.rejectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function tryAutoCloseVoting(ataRow: typeof atas.$inferSelect, force = false): Promise<typeof atas.$inferSelect> {
  if (ataRow.status !== "aguardando_votos") return ataRow;
  if (!force && (!ataRow.approvalDeadlineAt || new Date(ataRow.approvalDeadlineAt).getTime() > Date.now())) return ataRow;

  const [thresholdRow] = await db
    .select()
    .from(configuracoes)
    .where(eq(configuracoes.chave, "atas_aprovacao_threshold_percent"))
    .limit(1);
  const thresholdPercent = thresholdRow?.valor ? Number(thresholdRow.valor) : 50;

  const allFracoes = await db.select().from(fracoes).where(eq(fracoes.ativo, true));
  const totalPermilagem = allFracoes.reduce((sum, f) => sum + (Number(f.permilagem ?? 0) || 0), 0);

  const votes = await db.select({
    vote: ataVotes.vote,
    permilagem: fracoes.permilagem,
  })
    .from(ataVotes)
    .leftJoin(user, eq(ataVotes.userId, user.id))
    .leftJoin(fracoes, eq(user.fracaoId, fracoes.id))
    .where(eq(ataVotes.ataId, ataRow.id));

  const approvedPermilagem = votes
    .filter((v) => v.vote === "approve")
    .reduce((sum, v) => sum + (Number(v.permilagem ?? 0) || 0), 0);

  const approved =
    totalPermilagem > 0 &&
    (approvedPermilagem / totalPermilagem) * 100 >= thresholdPercent;

  const now = new Date();
  const newStatus = approved ? "aprovada" : "rejeitada";

  // Audio cleanup on final status
  if (ataRow.audioPath) {
    const audioAbsolutePath = path.join(process.cwd(), ataRow.audioPath);
    try {
      if (fs.existsSync(audioAbsolutePath)) fs.unlinkSync(audioAbsolutePath);
    } catch {
      // Non-fatal
    }
  }

  const [updated] = await db.update(atas).set({
    status: newStatus,
    approvedAt: approved ? now : null,
    rejectedAt: !approved ? now : null,
    audioPath: null,
    audioAvailableUntil: null,
    updatedAt: now,
  }).where(eq(atas.id, ataRow.id)).returning();

  return updated;
}

export const atasRoutes = new Hono()
  .use(requireAuth)
  .post("/", requireAdmin, async (c) => {
    try {
      const body = await c.req.parseBody();
      const audio = body.file;
      const titulo = String(body.titulo ?? "").trim();
      const dataReuniaoRaw = String(body.dataReuniao ?? "").trim();

      if (!audio || typeof audio === "string") {
        return c.json({ message: "Ficheiro de áudio obrigatório." }, 400);
      }
      if (!titulo) return c.json({ message: "Título é obrigatório." }, 400);
      if (!dataReuniaoRaw) return c.json({ message: "Data da reunião é obrigatória." }, 400);

      const dataReuniao = new Date(dataReuniaoRaw);
      if (Number.isNaN(dataReuniao.getTime())) {
        return c.json({ message: "Data da reunião inválida." }, 400);
      }

      const audioFile = audio as File;
      if (!isAllowedAudio(audioFile)) {
        return c.json({ message: "Formato inválido. Use MP3, M4A, WAV ou WEBM." }, 400);
      }
      if (audioFile.size > MAX_AUDIO_SIZE_BYTES) {
        return c.json({ message: "Ficheiro demasiado grande. Máximo: 25MB." }, 400);
      }

      const ext = path.extname(audioFile.name).toLowerCase();
      const safeTitle = sanitizeFilenamePart(titulo) || "reuniao";
      const filename = `${Date.now()}_${safeTitle}${ext}`;
      const absolutePath = path.join(UPLOAD_DIR, filename);
      const relativePath = path.join("data", "assembleias", filename);

      const buffer = Buffer.from(await audioFile.arrayBuffer());
      if (buffer.length === 0) {
        return c.json({ message: "Ficheiro de áudio vazio." }, 400);
      }
      fs.writeFileSync(absolutePath, buffer);

      const transcricaoRaw = await transcribeAudioFilePath(absolutePath, filename);
      const rascunho = await gerarRascunhoAta(transcricaoRaw, dataReuniao);

      const [created] = await db.insert(atas).values({
        titulo,
        dataReuniao,
        status: "rascunho",
        transcricaoRaw,
        ataTexto: rascunho.ataTexto,
        conteudoJson: serializeConteudo(rascunho.conteudo),
        resumoDeliberacoes: null,
        audioPath: relativePath,
      }).returning();

      return c.json(created, 201);
    } catch (error: any) {
      const message = String(error?.message ?? "Erro inesperado ao criar ata.");
      if (message.includes("GROQ_API_KEY")) {
        return c.json({ message: "GROQ_API_KEY em falta no servidor. Configure para usar STT/LLM." }, 400);
      }
      return c.json({ message }, 500);
    }
  })
  .get("/", async (c) => {
    const user = c.get("user") as any;
    const visibleStatuses = ["aprovada", "rejeitada", "aguardando_votos"];

    if (user?.role !== "admin") {
      const whereClause = inArray(atas.status, visibleStatuses);
      const userId = user?.id as string | undefined;
      if (!userId) return c.json({ message: "Utilizador inválido." }, 401);

      const rows = await db
        .select({
          id: atas.id,
          titulo: atas.titulo,
          dataReuniao: atas.dataReuniao,
          status: atas.status,
          ataTexto: atas.ataTexto,
          conteudoJson: atas.conteudoJson,
          resumoDeliberacoes: atas.resumoDeliberacoes,
          pdfUrl: atas.pdfUrl,
          pdfFinalizedAt: atas.pdfFinalizedAt,
          approvalDeadlineAt: atas.approvalDeadlineAt,
          audioAvailableUntil: atas.audioAvailableUntil,
          approvedAt: atas.approvedAt,
          rejectedAt: atas.rejectedAt,
          createdAt: atas.createdAt,
          updatedAt: atas.updatedAt,
          userVote: ataVotes.vote,
          userVotedAt: ataVotes.votedAt,
        })
        .from(atas)
        .leftJoin(
          ataVotes,
          and(
            eq(ataVotes.ataId, atas.id),
            eq(ataVotes.userId, userId),
          ),
        )
        .where(whereClause)
        .orderBy(desc(atas.dataReuniao), desc(atas.createdAt));

      // Lazy auto-close expired voting for each row
      const resolvedRows = [];
      for (const row of rows) {
        if (row.status === "aguardando_votos" && row.approvalDeadlineAt && new Date(row.approvalDeadlineAt).getTime() <= Date.now()) {
          const [fullRow] = await db.select().from(atas).where(eq(atas.id, row.id)).limit(1);
          if (fullRow) {
            const closed = await tryAutoCloseVoting(fullRow);
            // Re-fetch user vote info
            const [voteRow] = userId
              ? await db.select().from(ataVotes).where(and(eq(ataVotes.ataId, row.id), eq(ataVotes.userId, userId))).limit(1)
              : [null];
            resolvedRows.push({
              id: closed.id, titulo: closed.titulo, dataReuniao: closed.dataReuniao,
              status: closed.status, ataTexto: closed.ataTexto, conteudoJson: closed.conteudoJson, resumoDeliberacoes: closed.resumoDeliberacoes,
              pdfUrl: closed.pdfUrl, pdfFinalizedAt: closed.pdfFinalizedAt,
              approvalDeadlineAt: closed.approvalDeadlineAt, audioAvailableUntil: closed.audioAvailableUntil,
              approvedAt: closed.approvedAt, rejectedAt: closed.rejectedAt,
              createdAt: closed.createdAt, updatedAt: closed.updatedAt,
              userVote: voteRow?.vote ?? null, userVotedAt: voteRow?.votedAt ?? null,
            });
            continue;
          }
        }
        resolvedRows.push({
          id: row.id, titulo: row.titulo, dataReuniao: row.dataReuniao,
          status: row.status, ataTexto: row.ataTexto, conteudoJson: row.conteudoJson, resumoDeliberacoes: row.resumoDeliberacoes,
          pdfUrl: row.pdfUrl, pdfFinalizedAt: row.pdfFinalizedAt,
          approvalDeadlineAt: row.approvalDeadlineAt, audioAvailableUntil: row.audioAvailableUntil,
          approvedAt: row.approvedAt, rejectedAt: row.rejectedAt,
          createdAt: row.createdAt, updatedAt: row.updatedAt,
          userVote: row.userVote, userVotedAt: row.userVotedAt,
        });
      }
      return c.json(resolvedRows);
    }

    const allRows = await db
      .select({
        id: atas.id,
        titulo: atas.titulo,
        dataReuniao: atas.dataReuniao,
        status: atas.status,
        ataTexto: atas.ataTexto,
        conteudoJson: atas.conteudoJson,
        resumoDeliberacoes: atas.resumoDeliberacoes,
        pdfUrl: atas.pdfUrl,
        pdfFinalizedAt: atas.pdfFinalizedAt,
        approvalDeadlineAt: atas.approvalDeadlineAt,
        audioAvailableUntil: atas.audioAvailableUntil,
        approvedAt: atas.approvedAt,
        rejectedAt: atas.rejectedAt,
        createdAt: atas.createdAt,
        updatedAt: atas.updatedAt,
      })
      .from(atas)
      .orderBy(desc(atas.dataReuniao), desc(atas.createdAt));

    const resolved = await Promise.all(
      allRows.map(async (row) => {
        const [fullRow] = await db.select().from(atas).where(eq(atas.id, row.id)).limit(1);
        if (!fullRow) return row;
        const closed = await tryAutoCloseVoting(fullRow);
        return toPublicAtaRow(closed);
      }),
    );
    return c.json(resolved);
  })
  .get("/:id", async (c) => {
    const user = c.get("user") as any;
    const id = c.req.param("id");
    let [row] = await db.select().from(atas).where(eq(atas.id, id)).limit(1);
    if (!row) return c.json({ message: "Ata não encontrada." }, 404);
    row = await tryAutoCloseVoting(row);
    if (!canReadAta(user, row.status)) return c.json({ message: "Acesso negado." }, 403);

    if (user?.role !== "admin") {
      const userId = user?.id as string | undefined;
      const [voteRow] = userId
        ? await db
          .select()
          .from(ataVotes)
          .where(and(eq(ataVotes.ataId, row.id), eq(ataVotes.userId, userId)))
          .limit(1)
        : [null];
      return c.json({
        id: row.id,
        titulo: row.titulo,
        dataReuniao: row.dataReuniao,
        status: row.status,
        ataTexto: row.ataTexto,
        conteudoJson: row.conteudoJson,
        resumoDeliberacoes: row.resumoDeliberacoes,
        approvedAt: row.approvedAt,
        rejectedAt: row.rejectedAt,
        pdfUrl: row.pdfUrl,
        pdfFinalizedAt: row.pdfFinalizedAt,
        approvalDeadlineAt: row.approvalDeadlineAt,
        audioAvailableUntil: row.audioAvailableUntil,
        userVote: voteRow?.vote ?? null,
        userVotedAt: voteRow?.votedAt ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
    return c.json(toPublicAtaRow(row));
  })
  .patch("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");

    const [existing] = await db.select().from(atas).where(eq(atas.id, id)).limit(1);
    if (!existing) return c.json({ message: "Ata não encontrada." }, 404);
    if (!["rascunho", "rejeitada"].includes(existing.status)) {
      return c.json({ message: "Edição só permitida quando a ata está em rascunho ou rejeitada." }, 403);
    }

    const body = await c.req.json().catch(() => ({} as any));

    const patch: Partial<typeof atas.$inferInsert> = { updatedAt: new Date() };
    if (typeof body.titulo === "string") patch.titulo = body.titulo.trim();
    if (typeof body.transcricaoRaw === "string") patch.transcricaoRaw = body.transcricaoRaw;
    if (typeof body.resumoDeliberacoes === "string" || body.resumoDeliberacoes === null) {
      patch.resumoDeliberacoes = body.resumoDeliberacoes;
    }

    let dataReuniao = existing.dataReuniao;
    if (typeof body.dataReuniao === "string") {
      const dt = new Date(body.dataReuniao);
      if (Number.isNaN(dt.getTime())) return c.json({ message: "Data da reunião inválida." }, 400);
      patch.dataReuniao = dt;
      dataReuniao = dt;
    }

    if (body.conteudoJson && typeof body.conteudoJson === "object") {
      const conteudo = normalizeConteudo(body.conteudoJson, new Date(dataReuniao));
      conteudo.cabecalho.dataReuniao = new Date(dataReuniao).toISOString().slice(0, 10);
      patch.conteudoJson = serializeConteudo(conteudo);
      patch.ataTexto = conteudoToMarkdown(conteudo);
    } else if (typeof body.ataTexto === "string") {
      patch.ataTexto = body.ataTexto;
      const conteudo = resolveConteudo(existing.conteudoJson, body.ataTexto, new Date(dataReuniao));
      patch.conteudoJson = serializeConteudo(conteudo);
    }

    const [updated] = await db.update(atas).set(patch).where(eq(atas.id, id)).returning();
    if (!updated) return c.json({ message: "Ata não encontrada." }, 404);
    return c.json(toPublicAtaRow(updated));
  })
  .patch("/:id/aprovar", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const [updated] = await db.update(atas).set({
      status: "aprovada",
      approvedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(atas.id, id)).returning();

    if (!updated) return c.json({ message: "Ata não encontrada." }, 404);
    return c.json(updated);
  })
  // POST /api/atas/:id/audio → (re)attach audio + regenerate transcription/draft
  .post("/:id/audio", requireAdmin, async (c) => {
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const audio = (body as any).file;
    if (!audio || typeof audio === "string") {
      return c.json({ message: "Ficheiro de áudio obrigatório." }, 400);
    }

    const ata = await db.select().from(atas).where(eq(atas.id, id)).limit(1);
    const existing = ata[0];
    if (!existing) return c.json({ message: "Ata não encontrada." }, 404);

    const audioFile = audio as File;
    if (!isAllowedAudio(audioFile)) {
      return c.json({ message: "Formato inválido. Use MP3, M4A, WAV ou WEBM." }, 400);
    }
    if (audioFile.size > MAX_AUDIO_SIZE_BYTES) {
      return c.json({ message: `Ficheiro demasiado grande. Máximo: ${Math.round(MAX_AUDIO_SIZE_BYTES / (1024 * 1024))}MB.` }, 400);
    }

    const ext = path.extname(audioFile.name).toLowerCase();
    const safeTitle = sanitizeFilenamePart(existing.titulo) || "reuniao";
    const filename = `${Date.now()}_${safeTitle}${ext}`;
    const absolutePath = path.join(UPLOAD_DIR, filename);
    const relativePath = path.join("data", "assembleias", filename);

    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const buffer = Buffer.from(await audioFile.arrayBuffer());
    if (buffer.length === 0) {
      return c.json({ message: "Ficheiro de áudio vazio." }, 400);
    }
    fs.writeFileSync(absolutePath, buffer);

    // Regerar draft (transcrição + markdown)
    const transcricaoRaw = await transcribeAudioFilePath(absolutePath, filename);
    const rascunho = await gerarRascunhoAta(transcricaoRaw, new Date(existing.dataReuniao));

    // Mantém o áudio; só será disponibilizado ao portal durante a janela de votação.
    const [updated] = await db
      .update(atas)
      .set({
        audioPath: relativePath,
        transcricaoRaw,
        ataTexto: rascunho.ataTexto,
        conteudoJson: serializeConteudo(rascunho.conteudo),
        resumoDeliberacoes: null,
        status: "rascunho",
        pdfUrl: null,
        pdfFinalizedAt: null,
        approvalDeadlineAt: null,
        audioAvailableUntil: null,
        approvedAt: null,
        rejectedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(atas.id, id))
      .returning();

    return c.json(updated);
  })
  // GET /api/atas/:id/audio → stream (authenticated) within audioAvailableUntil
  .get("/:id/audio", requireAuth, async (c) => {
    const id = c.req.param("id");
    const user = c.get("user") as any;

    const [ataRow] = await db.select().from(atas).where(eq(atas.id, id)).limit(1);
    if (!ataRow) return c.json({ message: "Ata não encontrada." }, 404);

    if (!canReadAta(user, ataRow.status)) return c.json({ message: "Acesso negado." }, 403);
    if (!ataRow.audioPath) return c.json({ message: "Áudio indisponível." }, 404);
    if (["aprovada", "rejeitada"].includes(ataRow.status)) return c.json({ message: "Áudio já não está disponível." }, 403);

    const audioPath = ataRow.audioPath;
    // Security: `audioPath` stored internally as relative path.
    if (audioPath.includes("..")) return c.json({ message: "Path inválido." }, 400);

    const absolutePath = path.join(process.cwd(), audioPath);
    if (!fs.existsSync(absolutePath)) return c.json({ message: "Arquivo de áudio não encontrado." }, 404);

    const ext = path.extname(audioPath).toLowerCase();
    const contentType =
      ext === ".webm" ? "audio/webm" :
      ext === ".mp3" ? "audio/mpeg" :
      ext === ".wav" ? "audio/wav" :
      "application/octet-stream";

    const buf = fs.readFileSync(absolutePath);
    return new Response(buf, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${path.basename(audioPath)}"`,
      },
    });
  })
  // POST /api/atas/:id/votes → condómino aprova/rejeita (uma vez, dentro do deadline)
  .post("/:id/votes", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user") as any;
    if (!user) return c.json({ message: "Não autenticado." }, 401);

    const body = await c.req.json().catch(() => ({} as any));
    const vote = body.vote as "approve" | "reject" | undefined;
    if (vote !== "approve" && vote !== "reject") {
      return c.json({ message: "Voto inválido. Use approve ou reject." }, 400);
    }

    let [ataRow] = await db.select().from(atas).where(eq(atas.id, id)).limit(1);
    if (!ataRow) return c.json({ message: "Ata não encontrada." }, 404);
    if (user.role === "admin") {
      // Admin pode votar, mas o fluxo é orientado a condóminos.
    }

    // Lazy auto-close if deadline passed
    if (ataRow.status === "aguardando_votos" && ataRow.approvalDeadlineAt && new Date(ataRow.approvalDeadlineAt).getTime() < Date.now()) {
      ataRow = await tryAutoCloseVoting(ataRow);
      return c.json({ message: "Prazo de votação expirado. Votação encerrada automaticamente." }, 400);
    }

    if (ataRow.status !== "aguardando_votos") return c.json({ message: "Votação não está aberta." }, 400);

    // Condómino precisa estar ligado a uma fração (para permilagem).
    if (!user.fracaoId) return c.json({ message: "Fração não associada." }, 400);

    const userId = user.id as string;
    const [existingVote] = await db
      .select()
      .from(ataVotes)
      .where(and(eq(ataVotes.ataId, id), eq(ataVotes.userId, userId)))
      .limit(1);

    const now = new Date();

    let updated;
    if (existingVote) {
      const [v] = await db
        .update(ataVotes)
        .set({ vote, votedAt: now })
        .where(eq(ataVotes.id, existingVote.id))
        .returning();
      updated = v;
    } else {
      const [v] = await db
        .insert(ataVotes)
        .values({
          ataId: id,
          userId,
          vote,
          votedAt: now,
        })
        .returning();
      updated = v;
    }

    return c.json({
      id: updated.id,
      ataId: updated.ataId,
      userId: updated.userId,
      vote: updated.vote,
      votedAt: updated.votedAt,
    });
  })
  // PATCH /api/atas/:id/publicar → gera PDF, abre votação (30 min)
  .patch("/:id/publicar", requireAdmin, async (c) => {
    const id = c.req.param("id");

    const [ataRow] = await db.select().from(atas).where(eq(atas.id, id)).limit(1);
    if (!ataRow) return c.json({ message: "Ata não encontrada." }, 404);
    if (ataRow.status === "aguardando_votos") return c.json({ message: "Votação já está aberta." }, 400);

    const pdfUrl = await gerarAtaPdf({
      id: ataRow.id,
      titulo: ataRow.titulo,
      dataReuniao: ataRow.dataReuniao,
      ataTexto: ataRow.ataTexto,
      conteudoJson: ataRow.conteudoJson,
      resumoDeliberacoes: ataRow.resumoDeliberacoes,
    });

    const [windowRow] = await db
      .select()
      .from(configuracoes)
      .where(eq(configuracoes.chave, "atas_aprovacao_window_minutes"))
      .limit(1);
    const windowMinutes = windowRow?.valor ? Math.max(1, Number(windowRow.valor)) : 30;

    const now = new Date();
    const approvalDeadlineAt = new Date(now.getTime() + windowMinutes * 60 * 1000);

    const [updated] = await db.update(atas).set({
      pdfUrl,
      pdfFinalizedAt: now,
      status: "aguardando_votos",
      approvalDeadlineAt,
      audioAvailableUntil: null, // available until approved/rejected
      updatedAt: now,
      approvedAt: null,
      rejectedAt: null,
    }).where(eq(atas.id, id)).returning();

    return c.json(toPublicAtaRow(updated));
  })
  // GET /api/atas/pdf/:filename → stream PDF
  .get("/pdf/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (filename.includes("..") || filename.includes("/")) {
      return c.json({ message: "Path inválido." }, 400);
    }
    const pdfDir = path.join(process.cwd(), "data", "atas");
    const pdfPath = path.join(pdfDir, filename);
    if (!fs.existsSync(pdfPath)) return c.json({ message: "PDF não encontrado." }, 404);

    const buf = fs.readFileSync(pdfPath);
    return new Response(buf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
      },
    });
  })
  // PATCH /api/atas/:id/fechar-votacao → admin fecha votação manualmente (fallback)
  .patch("/:id/fechar-votacao", requireAdmin, async (c) => {
    const id = c.req.param("id");

    const [ataRow] = await db.select().from(atas).where(eq(atas.id, id)).limit(1);
    if (!ataRow) return c.json({ message: "Ata não encontrada." }, 404);
    if (ataRow.status !== "aguardando_votos") return c.json({ message: "Votação não está aberta." }, 400);

    const updated = await tryAutoCloseVoting(ataRow, true);
    return c.json(toPublicAtaRow(updated));
  })
  .delete("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");

    const [existing] = await db.select().from(atas).where(eq(atas.id, id)).limit(1);
    if (!existing) return c.json({ message: "Ata não encontrada." }, 404);

    if (existing.audioPath) deleteFileIfExists(existing.audioPath);
    deletePdfByUrl(existing.pdfUrl);

    await db.delete(atas).where(eq(atas.id, id));

    return c.json({ ok: true, id });
  });
