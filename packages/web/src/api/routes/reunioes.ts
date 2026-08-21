import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db } from "../database";
import { reunioes } from "../database/schema";
import { requireAdmin } from "../middleware/auth";
import { transcribeAudioFilePath } from "../lib/stt";
import { gerarResumoReuniao } from "../lib/reuniao-llm";
import { gerarReuniaoPdf } from "../lib/reuniao-pdf";

const UPLOAD_DIR = path.join(process.cwd(), "data", "reunioes");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_AUDIO_SIZE_BYTES = 120 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".mp3", ".m4a", ".mp4", ".wav", ".webm"]);

export const reunioesRoutes = new Hono()
  .use(requireAdmin)
  .get("/", async (c) => {
    const rows = await db.select().from(reunioes).orderBy(desc(reunioes.data), desc(reunioes.createdAt));
    return c.json(rows);
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await db.select().from(reunioes).where(eq(reunioes.id, id)).limit(1);
    if (!row) return c.json({ message: "Reunião não encontrada." }, 404);
    return c.json(row);
  })
  .post("/", async (c) => {
    try {
      const body = await c.req.parseBody();
      const audio = body.file;
      const titulo = String(body.titulo ?? "").trim();
      const dataRaw = String(body.data ?? "").trim();
      const participantes = String(body.participantes ?? "").trim() || null;

      if (!titulo) return c.json({ message: "Título é obrigatório." }, 400);
      if (!dataRaw) return c.json({ message: "Data é obrigatória." }, 400);

      const dataReuniao = new Date(dataRaw);
      if (Number.isNaN(dataReuniao.getTime())) return c.json({ message: "Data inválida." }, 400);

      let transcricao: string | null = null;
      let resumo: string | null = null;
      let resumoJson: string | null = null;
      let tipo: string = "interna";
      let fornecedorNome: string | null = null;
      let audioRelativePath: string | null = null;

      if (audio && typeof audio !== "string") {
        const audioFile = audio as File;
        const ext = path.extname(audioFile.name).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) {
          return c.json({ message: "Formato inválido. Use MP3, M4A, WAV ou WEBM." }, 400);
        }
        if (audioFile.size > MAX_AUDIO_SIZE_BYTES) {
          return c.json({ message: `Ficheiro demasiado grande. Máximo: ${Math.round(MAX_AUDIO_SIZE_BYTES / (1024 * 1024))}MB.` }, 400);
        }

        const filename = `${Date.now()}_${titulo.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 80)}${ext}`;
        const absolutePath = path.join(UPLOAD_DIR, filename);
        audioRelativePath = path.join("data", "reunioes", filename);

        const buffer = Buffer.from(await audioFile.arrayBuffer());
        if (buffer.length === 0) {
          return c.json({ message: "Ficheiro de áudio vazio." }, 400);
        }
        fs.writeFileSync(absolutePath, buffer);

        let sttError: string | null = null;
        let llmError: string | null = null;
        try {
          transcricao = await transcribeAudioFilePath(absolutePath, filename);
        } catch (e: any) {
          sttError = String(e?.message ?? "Falha na transcrição.");
        }

        if (transcricao) {
          try {
            const result = await gerarResumoReuniao(transcricao);
            tipo = result.tipo;
            fornecedorNome = result.fornecedorNome;
            resumoJson = JSON.stringify(result.content);
            resumo = result.resumoTexto;
          } catch (e: any) {
            llmError = String(e?.message ?? "Falha ao gerar resumo estruturado.");
            resumo = `Transcrição disponível, mas o resumo automático falhou: ${llmError}\n\n---\n${transcricao}`;
          }
        }

        const [created] = await db.insert(reunioes).values({
          titulo,
          data: dataReuniao,
          tipo,
          fornecedorNome,
          participantes,
          transcricao,
          resumoJson,
          resumo,
          audioPath: audioRelativePath,
        }).returning();

        if (sttError) {
          return c.json({
            ...created,
            warning: `Reunião criada, mas a transcrição falhou: ${sttError}`,
          }, 201);
        }
        if (llmError) {
          return c.json({
            ...created,
            warning: `Transcrição OK, mas o resumo estruturado falhou: ${llmError}`,
          }, 201);
        }

        return c.json(created, 201);
      }

      const [created] = await db.insert(reunioes).values({
        titulo,
        data: dataReuniao,
        tipo,
        fornecedorNome,
        participantes,
        transcricao,
        resumoJson,
        resumo,
        audioPath: audioRelativePath,
      }).returning();

      return c.json(created, 201);
    } catch (error: any) {
      return c.json({ message: String(error?.message ?? "Erro inesperado.") }, 500);
    }
  })
  .patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({} as any));

    const patch: Partial<typeof reunioes.$inferInsert> = { updatedAt: new Date() };
    if (typeof body.titulo === "string") patch.titulo = body.titulo.trim();
    if (typeof body.participantes === "string" || body.participantes === null) patch.participantes = body.participantes;
    if (typeof body.transcricao === "string") patch.transcricao = body.transcricao;
    if (typeof body.resumo === "string" || body.resumo === null) patch.resumo = body.resumo;
    if (typeof body.resumoJson === "string" || body.resumoJson === null) patch.resumoJson = body.resumoJson;
    if (typeof body.tipo === "string" && (body.tipo === "interna" || body.tipo === "fornecedor")) patch.tipo = body.tipo;
    if (typeof body.fornecedorNome === "string" || body.fornecedorNome === null) patch.fornecedorNome = body.fornecedorNome;
    if (typeof body.data === "string") {
      const dt = new Date(body.data);
      if (Number.isNaN(dt.getTime())) return c.json({ message: "Data inválida." }, 400);
      patch.data = dt;
    }

    const [updated] = await db.update(reunioes).set(patch).where(eq(reunioes.id, id)).returning();
    if (!updated) return c.json({ message: "Reunião não encontrada." }, 404);
    return c.json(updated);
  })
  .post("/:id/reprocessar", async (c) => {
    const id = c.req.param("id");
    const [row] = await db.select().from(reunioes).where(eq(reunioes.id, id)).limit(1);
    if (!row) return c.json({ message: "Reunião não encontrada." }, 404);
    if (!row.audioPath) return c.json({ message: "Esta reunião não tem áudio guardado." }, 400);

    const absolutePath = path.join(process.cwd(), row.audioPath);
    if (!fs.existsSync(absolutePath)) {
      return c.json({ message: "Ficheiro de áudio não encontrado no servidor." }, 404);
    }

    try {
      const transcricao = await transcribeAudioFilePath(absolutePath, path.basename(row.audioPath));
      let tipo = row.tipo;
      let fornecedorNome = row.fornecedorNome;
      let resumoJson = row.resumoJson;
      let resumo = row.resumo;
      let warning: string | undefined;

      try {
        const result = await gerarResumoReuniao(transcricao);
        tipo = result.tipo;
        fornecedorNome = result.fornecedorNome;
        resumoJson = JSON.stringify(result.content);
        resumo = result.resumoTexto;
      } catch (e: any) {
        warning = String(e?.message ?? "Falha ao gerar resumo estruturado.");
        resumo = `Transcrição regenerada, mas o resumo falhou: ${warning}\n\n---\n${transcricao}`;
      }

      const [updated] = await db.update(reunioes).set({
        transcricao,
        tipo,
        fornecedorNome,
        resumoJson,
        resumo,
        updatedAt: new Date(),
      }).where(eq(reunioes.id, id)).returning();

      return c.json(warning ? { ...updated, warning } : updated);
    } catch (e: any) {
      return c.json({ message: String(e?.message ?? "Falha ao reprocessar áudio.") }, 500);
    }
  })
  .patch("/:id/aprovar", async (c) => {
    const id = c.req.param("id");
    const [row] = await db.select().from(reunioes).where(eq(reunioes.id, id)).limit(1);
    if (!row) return c.json({ message: "Reunião não encontrada." }, 404);
    if (row.status === "aprovada") return c.json({ message: "Reunião já aprovada." }, 400);

    const pdfUrl = await gerarReuniaoPdf({
      id: row.id,
      titulo: row.titulo,
      data: row.data,
      tipo: row.tipo,
      resumoJson: row.resumoJson,
      resumo: row.resumo,
    });

    const [updated] = await db.update(reunioes).set({
      status: "aprovada",
      pdfUrl,
      approvedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(reunioes.id, id)).returning();

    return c.json(updated);
  })
  .get("/pdf/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (filename.includes("..") || filename.includes("/")) {
      return c.json({ message: "Path inválido." }, 400);
    }
    const pdfDir = path.join(process.cwd(), "data", "reunioes-pdf");
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
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await db.select().from(reunioes).where(eq(reunioes.id, id)).limit(1);
    if (!row) return c.json({ message: "Reunião não encontrada." }, 404);

    if (row.audioPath) {
      const abs = path.join(process.cwd(), row.audioPath);
      try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch {}
    }

    await db.delete(reunioes).where(eq(reunioes.id, id));
    return c.json({ message: "Eliminada." });
  });
