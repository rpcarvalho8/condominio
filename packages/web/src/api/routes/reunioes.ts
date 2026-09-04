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
import { resolveUploadedAudioPath } from "./uploads";

const UPLOAD_DIR = path.join(process.cwd(), "data", "reunioes");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_AUDIO_SIZE_BYTES = 120 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".mp3", ".m4a", ".mp4", ".wav", ".webm"]);

function toPosix(p: string) {
  return p.replace(/\\/g, "/");
}

function resolveAudioFromBody(uploadId: string, audioPathIn: string): {
  absolutePath: string;
  relativePath: string;
  filename: string;
} | { error: string; status: 400 | 404 } {
  let relative = audioPathIn;
  if (uploadId && !relative) {
    const metaFile = path.join(process.cwd(), "data", "uploads", uploadId, "meta.json");
    if (!fs.existsSync(metaFile)) {
      return { error: "Upload não encontrado. Complete o envio do áudio primeiro.", status: 400 };
    }
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as {
        finalRelativePath?: string;
        status?: string;
      };
      if (meta.status !== "completed" || !meta.finalRelativePath) {
        return { error: "Upload incompleto. Aguarde o complete do áudio.", status: 400 };
      }
      relative = meta.finalRelativePath;
    } catch {
      return { error: "Metadados do upload inválidos.", status: 400 };
    }
  }
  relative = toPosix(relative);
  const absolutePath = resolveUploadedAudioPath(relative);
  if (!absolutePath) {
    return { error: "Ficheiro de áudio não encontrado no servidor.", status: 404 };
  }
  return { absolutePath, relativePath: relative, filename: path.basename(absolutePath) };
}

/** STT + LLM → UPDATE do registo. Corre após create/reprocess (await no pedido HTTP). */
async function runReuniaoSttPipeline(reuniaoId: string): Promise<void> {
  const [row] = await db.select().from(reunioes).where(eq(reunioes.id, reuniaoId)).limit(1);
  if (!row?.audioPath) {
    await db.update(reunioes).set({
      status: "erro_audio",
      resumo: "Sem ficheiro de áudio associado.",
      updatedAt: new Date(),
    }).where(eq(reunioes.id, reuniaoId));
    return;
  }

  const absolutePath = path.join(process.cwd(), row.audioPath);
  if (!fs.existsSync(absolutePath)) {
    await db.update(reunioes).set({
      status: "erro_audio",
      resumo: "Ficheiro de áudio não encontrado no disco.",
      updatedAt: new Date(),
    }).where(eq(reunioes.id, reuniaoId));
    return;
  }

  try {
    console.log("[STT] Iniciando transcrição do áudio...", { reuniaoId, path: row.audioPath });
    const transcricao = await transcribeAudioFilePath(absolutePath, path.basename(row.audioPath), {
      cacheKey: `reuniao_${reuniaoId}`,
    });
    if (!transcricao?.trim()) {
      await db.update(reunioes).set({
        status: "erro_audio",
        transcricao: null,
        resumo: "Transcrição vazia. Use «Tentar novamente gerar».",
        updatedAt: new Date(),
      }).where(eq(reunioes.id, reuniaoId));
      return;
    }

    console.log("[STT] Transcrição concluída. Invocando LLM...", {
      reuniaoId,
      chars: transcricao.length,
    });

    let tipo = row.tipo || "interna";
    let fornecedorNome = row.fornecedorNome;
    let resumoJson: string | null = null;
    let resumo: string | null = null;
    let llmWarning: string | null = null;

    try {
      const result = await gerarResumoReuniao(transcricao);
      tipo = result.tipo;
      fornecedorNome = result.fornecedorNome;
      resumoJson = JSON.stringify(result.content);
      resumo = result.resumoTexto;
    } catch (e: any) {
      llmWarning = String(e?.message ?? "Falha ao gerar resumo estruturado.");
      resumo = `Transcrição OK, mas o resumo automático falhou: ${llmWarning}\n\n---\n${transcricao}`;
    }

    await db.update(reunioes).set({
      status: "rascunho",
      transcricao,
      tipo,
      fornecedorNome,
      resumoJson,
      resumo,
      updatedAt: new Date(),
    }).where(eq(reunioes.id, reuniaoId));

    console.log("[STT/LLM] Conteúdo guardado na BD para o ID:", reuniaoId);
    if (llmWarning) console.warn(`[reunioes] LLM warning id=${reuniaoId}:`, llmWarning);
  } catch (e: any) {
    const msg = String(e?.message ?? "Falha na transcrição.");
    console.error(`[reunioes] STT falhou id=${reuniaoId}:`, msg);
    await db.update(reunioes).set({
      status: "erro_audio",
      resumo: `Falha na transcrição: ${msg}`,
      updatedAt: new Date(),
    }).where(eq(reunioes.id, reuniaoId));
  }
}

export const reunioesPdfRoutes = new Hono().get("/:filename", async (c) => {
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
});

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
      const uploadId = String(body.uploadId ?? "").trim();
      const audioPathIn = String(body.audioPath ?? "").trim();

      if (!titulo) return c.json({ message: "Título é obrigatório." }, 400);
      if (!dataRaw) return c.json({ message: "Data é obrigatória." }, 400);

      const dataReuniao = new Date(dataRaw);
      if (Number.isNaN(dataReuniao.getTime())) return c.json({ message: "Data inválida." }, 400);

      let audioRelativePath: string | null = null;

      if (uploadId || audioPathIn) {
        const resolved = resolveAudioFromBody(uploadId, audioPathIn);
        if ("error" in resolved) return c.json({ message: resolved.error }, resolved.status);
        audioRelativePath = resolved.relativePath;
      } else if (audio && typeof audio !== "string") {
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
        const buffer = Buffer.from(await audioFile.arrayBuffer());
        if (buffer.length === 0) return c.json({ message: "Ficheiro de áudio vazio." }, 400);
        fs.writeFileSync(absolutePath, buffer);
        audioRelativePath = toPosix(path.join("data", "reunioes", filename));
      }

      if (audioRelativePath) {
        const [created] = await db.insert(reunioes).values({
          titulo,
          data: dataReuniao,
          tipo: "interna",
          fornecedorNome: null,
          participantes,
          transcricao: null,
          resumoJson: null,
          resumo: "A transcrever áudio e a gerar notas com IA…",
          audioPath: audioRelativePath,
          status: "processando_audio",
        }).returning();

        // Aguardar STT+LLM no pedido — o plugin Vite corta trabalho em background após a response
        await runReuniaoSttPipeline(created.id);
        const [updated] = await db.select().from(reunioes).where(eq(reunioes.id, created.id)).limit(1);
        return c.json(updated ?? created, 201);
      }

      const [created] = await db.insert(reunioes).values({
        titulo,
        data: dataReuniao,
        tipo: "interna",
        fornecedorNome: null,
        participantes,
        transcricao: null,
        resumoJson: null,
        resumo: null,
        audioPath: null,
        status: "rascunho",
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

    await db.update(reunioes).set({
      status: "processando_audio",
      resumo: "A regenerar transcrição e resumo…",
      updatedAt: new Date(),
    }).where(eq(reunioes.id, id));

    await runReuniaoSttPipeline(id);
    const [updated] = await db.select().from(reunioes).where(eq(reunioes.id, id)).limit(1);
    if (!updated) return c.json({ message: "Reunião não encontrada." }, 404);
    if (updated.status === "erro_audio") {
      return c.json({ ...updated, warning: updated.resumo || "Falha ao regenerar." });
    }
    return c.json(updated);
  })
  .patch("/:id/aprovar", async (c) => {
    const id = c.req.param("id");
    const [row] = await db.select().from(reunioes).where(eq(reunioes.id, id)).limit(1);
    if (!row) return c.json({ message: "Reunião não encontrada." }, 404);
    if (row.status === "aprovada") return c.json({ message: "Reunião já aprovada." }, 400);
    if (row.status === "processando_audio") {
      return c.json({ message: "Aguarde o fim da transcrição antes de aprovar." }, 400);
    }

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
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = await db.select().from(reunioes).where(eq(reunioes.id, id)).limit(1);
    if (!row) return c.json({ message: "Reunião não encontrada." }, 404);

    if (row.audioPath) {
      const abs = path.join(process.cwd(), row.audioPath);
      try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch { /* ignore */ }
    }

    await db.delete(reunioes).where(eq(reunioes.id, id));
    return c.json({ message: "Eliminada." });
  });
