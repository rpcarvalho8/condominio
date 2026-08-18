import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db } from "../database";
import { reunioes } from "../database/schema";
import { requireAdmin } from "../middleware/auth";
import { transcribeAudioWithGroq } from "../lib/stt";

const UPLOAD_DIR = path.join(process.cwd(), "data", "reunioes");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_AUDIO_SIZE_BYTES = 120 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".mp3", ".m4a", ".mp4", ".wav", ".webm"]);

const GROQ_CHAT_MODEL = "llama-3.3-70b-versatile";

async function gerarResumoReuniao(transcricao: string): Promise<string> {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) throw new Error("GROQ_API_KEY não configurada.");

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_CHAT_MODEL,
      temperature: 0.2,
      max_tokens: 1200,
      messages: [
        { role: "system", content: "Resumes reuniões internas de condomínio em PT-PT, de forma concisa e objetiva." },
        {
          role: "user",
          content: `Resume a seguinte transcrição de reunião interna. Inclui:\n1) Participantes (se mencionados)\n2) Temas discutidos\n3) Decisões tomadas\n4) Tarefas/próximos passos\n\nTRANSCRIÇÃO:\n${transcricao}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Falha ao gerar resumo: ${response.status} ${body}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

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
        fs.writeFileSync(absolutePath, buffer);

        transcricao = await transcribeAudioWithGroq(audioFile);
        try {
          resumo = await gerarResumoReuniao(transcricao);
        } catch {
          // non-fatal
        }
      }

      const [created] = await db.insert(reunioes).values({
        titulo,
        data: dataReuniao,
        participantes,
        transcricao,
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
    if (typeof body.data === "string") {
      const dt = new Date(body.data);
      if (Number.isNaN(dt.getTime())) return c.json({ message: "Data inválida." }, 400);
      patch.data = dt;
    }

    const [updated] = await db.update(reunioes).set(patch).where(eq(reunioes.id, id)).returning();
    if (!updated) return c.json({ message: "Reunião não encontrada." }, 404);
    return c.json(updated);
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
