import { Hono } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db } from "../database";
import { reunioes, recordingSegments } from "../database/schema";
import { requireAdmin } from "../middleware/auth";
import { transcribeAudioFilePath } from "../lib/stt";
import { gerarResumoReuniao } from "../lib/reuniao-llm";
import { gerarReuniaoPdf } from "../lib/reuniao-pdf";
import { resolveUploadedAudioPath } from "./uploads";
import { getCurrentTenantId } from "../lib/tenant";
import { findReuniaoForCurrentTenant } from "../lib/reuniao-access";
import {
  insertSegmentWithOrdinalRetry,
  isOrdinalUniqueViolation,
} from "../lib/reuniao-ordinal";
import { writeReuniaoAudit } from "../lib/reuniao-audit";
import { withIdempotency } from "../lib/idempotency";

const UPLOAD_DIR = path.join(process.cwd(), "data", "reunioes");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_AUDIO_SIZE_BYTES = 120 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".mp3", ".m4a", ".mp4", ".wav", ".webm"]);

function toPosix(p: string) {
  return p.replace(/\\/g, "/");
}

function actorUserId(c: { get: (k: string) => unknown }): string | null {
  const user = c.get("user") as { id?: string } | null;
  return user?.id ?? null;
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

function parseOptionalClientTs(raw: unknown): Date | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw));
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * STT + LLM sobre TODOS os segmentos (ordinal), uma única transcrição lógica.
 *
 * Nota de arquitectura (Fonte actual): corre no pedido HTTP porque o plugin Vite
 * corta trabalho em background após a response. Em F0 (ADR-038) isto migra para
 * job persistente. Idempotência: se já existir transcrição para a mesma
 * processingGeneration, não reescreve Acta.
 */
export async function runReuniaoSttPipeline(
  reuniaoId: string,
  opts?: { force?: boolean; expectedGeneration?: number },
): Promise<void> {
  const tenantId = getCurrentTenantId();
  const [row] = await db
    .select()
    .from(reunioes)
    .where(and(eq(reunioes.id, reuniaoId), eq(reunioes.tenantId, tenantId)))
    .limit(1);
  if (!row) return;

  if (
    !opts?.force &&
    row.transcricao &&
    row.status === "rascunho" &&
    opts?.expectedGeneration != null &&
    row.processingGeneration === opts.expectedGeneration &&
    row.processingCompletedAt
  ) {
    return;
  }

  const segments = await db
    .select()
    .from(recordingSegments)
    .where(eq(recordingSegments.reuniaoId, reuniaoId))
    .orderBy(asc(recordingSegments.ordinal));

  const audioJobs: Array<{ absolutePath: string; label: string; ordinal: number }> = [];
  for (const seg of segments) {
    if (!seg.storagePath) continue;
    const absolutePath = path.join(process.cwd(), seg.storagePath);
    if (fs.existsSync(absolutePath)) {
      audioJobs.push({
        absolutePath,
        label: path.basename(absolutePath),
        ordinal: seg.ordinal,
      });
    }
  }
  if (audioJobs.length === 0 && row.audioPath) {
    const absolutePath = path.join(process.cwd(), row.audioPath);
    if (fs.existsSync(absolutePath)) {
      audioJobs.push({ absolutePath, label: path.basename(absolutePath), ordinal: 0 });
    }
  }

  if (audioJobs.length === 0) {
    await db.update(reunioes).set({
      status: "erro_audio",
      resumo: "Sem ficheiro de áudio associado.",
      updatedAt: new Date(),
    }).where(and(eq(reunioes.id, reuniaoId), eq(reunioes.tenantId, tenantId)));
    await writeReuniaoAudit({
      type: "recording_processing_failed",
      reuniaoId,
      payload: { reason: "no_audio" },
    });
    return;
  }

  try {
    const parts: string[] = [];
    for (let i = 0; i < audioJobs.length; i++) {
      const job = audioJobs[i]!;
      console.log("[STT] Transcrevendo segmento...", {
        reuniaoId,
        ordinal: job.ordinal,
        i: i + 1,
        path: job.absolutePath,
      });
      const text = await transcribeAudioFilePath(job.absolutePath, job.label, {
        cacheKey: `reuniao_${reuniaoId}_ord${job.ordinal || i + 1}`,
      });
      if (text?.trim()) {
        parts.push(
          audioJobs.length > 1
            ? `--- Segmento ${job.ordinal || i + 1}/${audioJobs.length} ---\n${text.trim()}`
            : text.trim(),
        );
      }
    }
    const transcricao = parts.join("\n\n");
    if (!transcricao?.trim()) {
      await db.update(reunioes).set({
        status: "erro_audio",
        transcricao: null,
        resumo: "Transcrição vazia. Use «Tentar novamente gerar».",
        updatedAt: new Date(),
      }).where(and(eq(reunioes.id, reuniaoId), eq(reunioes.tenantId, tenantId)));
      await writeReuniaoAudit({
        type: "recording_processing_failed",
        reuniaoId,
        payload: { reason: "empty_transcription" },
      });
      return;
    }

    console.log("[STT] Transcrição concluída. Invocando LLM...", {
      reuniaoId,
      chars: transcricao.length,
      segments: audioJobs.length,
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
      processingCompletedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(reunioes.id, reuniaoId), eq(reunioes.tenantId, tenantId)));

    await writeReuniaoAudit({
      type: "recording_processing_completed",
      reuniaoId,
      payload: {
        segments: audioJobs.length,
        generation: row.processingGeneration,
        llmWarning: llmWarning ?? undefined,
      },
    });

    console.log("[STT/LLM] Conteúdo guardado na BD para o ID:", reuniaoId);
    if (llmWarning) console.warn(`[reunioes] LLM warning id=${reuniaoId}:`, llmWarning);
  } catch (e: any) {
    const msg = String(e?.message ?? "Falha na transcrição.");
    console.error(`[reunioes] STT falhou id=${reuniaoId}:`, msg);
    await db.update(reunioes).set({
      status: "erro_audio",
      resumo: `Falha na transcrição: ${msg}`,
      updatedAt: new Date(),
    }).where(and(eq(reunioes.id, reuniaoId), eq(reunioes.tenantId, tenantId)));
    await writeReuniaoAudit({
      type: "recording_processing_failed",
      reuniaoId,
      payload: { reason: msg },
    });
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
    const tenantId = getCurrentTenantId();
    const rows = await db
      .select()
      .from(reunioes)
      .where(eq(reunioes.tenantId, tenantId))
      .orderBy(desc(reunioes.data), desc(reunioes.createdAt));
    return c.json(rows);
  })
  /** Abre uma reunião em curso (antes / ao iniciar a primeira gravação). */
  .post("/open", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const titulo = String(body.titulo ?? "").trim();
      const dataRaw = String(body.data ?? "").trim();
      const participantes = String(body.participantes ?? "").trim() || null;
      if (!titulo) return c.json({ message: "Título é obrigatório." }, 400);
      if (!dataRaw) return c.json({ message: "Data é obrigatória." }, 400);
      const dataReuniao = new Date(dataRaw);
      if (Number.isNaN(dataReuniao.getTime())) return c.json({ message: "Data inválida." }, 400);

      const tenantId = getCurrentTenantId();
      const [created] = await db.insert(reunioes).values({
        tenantId,
        titulo,
        data: dataReuniao,
        tipo: "interna",
        fornecedorNome: null,
        participantes,
        transcricao: null,
        resumoJson: null,
        resumo: "Reunião em curso — gravação contínua (vários segmentos possíveis).",
        audioPath: null,
        status: "em_curso",
      }).returning();

      await writeReuniaoAudit({
        type: "meeting_opened",
        reuniaoId: created.id,
        actorUserId: actorUserId(c),
        payload: { titulo },
      });

      return c.json(created, 201);
    } catch (error: any) {
      return c.json({ message: String(error?.message ?? "Erro inesperado.") }, 500);
    }
  })
  .get("/:id/segments", async (c) => {
    const id = c.req.param("id");
    const row = await findReuniaoForCurrentTenant(id);
    if (!row) return c.json({ message: "Reunião não encontrada." }, 404);
    const segs = await db
      .select()
      .from(recordingSegments)
      .where(eq(recordingSegments.reuniaoId, id))
      .orderBy(asc(recordingSegments.ordinal));
    return c.json({ reuniao: row, segments: segs });
  })
  /** Persiste um segmento de áudio na mesma reunião (não cria reunião nova). */
  .post("/:id/segments", async (c) => {
    try {
      const id = c.req.param("id");
      const row = await findReuniaoForCurrentTenant(id);
      if (!row) return c.json({ message: "Reunião não encontrada." }, 404);
      if (row.status !== "em_curso" && row.status !== "rascunho") {
        return c.json({
          message: "Só se podem acrescentar segmentos a uma reunião em curso.",
        }, 400);
      }

      const body = await c.req.parseBody();
      const uploadId = String(body.uploadId ?? "").trim();
      const audioPathIn = String(body.audioPath ?? "").trim();
      const reasonEnded = String(body.reasonEnded ?? "user_stop_segment").trim();
      const allowedReasons = new Set([
        "user_stop_segment",
        "technical_interrupt",
        "user_end_meeting",
      ]);
      if (!allowedReasons.has(reasonEnded)) {
        return c.json({ message: "reasonEnded inválido." }, 400);
      }

      const resolved = resolveAudioFromBody(uploadId, audioPathIn);
      if ("error" in resolved) {
        await writeReuniaoAudit({
          type: "recording_upload_failed",
          reuniaoId: id,
          actorUserId: actorUserId(c),
          payload: { error: resolved.error },
        });
        return c.json({ message: resolved.error }, resolved.status);
      }

      const byteSize = fs.existsSync(resolved.absolutePath)
        ? fs.statSync(resolved.absolutePath).size
        : 0;
      const now = new Date();
      const clientStartedAt = parseOptionalClientTs(body.clientStartedAt);
      const clientEndedAt = parseOptionalClientTs(body.clientEndedAt);

      const seg = await insertSegmentWithOrdinalRetry(
        db,
        id,
        (ordinal) => ({
          reuniaoId: id,
          ordinal,
          startedAt: now,
          endedAt: now,
          clientStartedAt,
          clientEndedAt,
          reasonEnded,
          storagePath: resolved.relativePath,
          byteSize,
          status: "closed",
        }),
        async (values) =>
          db.insert(recordingSegments).values(values as any).returning(),
      );

      const tenantId = getCurrentTenantId();
      if (!row.audioPath) {
        await db.update(reunioes).set({
          audioPath: resolved.relativePath,
          status: "em_curso",
          updatedAt: new Date(),
        }).where(and(eq(reunioes.id, id), eq(reunioes.tenantId, tenantId)));
      } else {
        await db.update(reunioes).set({
          status: "em_curso",
          updatedAt: new Date(),
        }).where(and(eq(reunioes.id, id), eq(reunioes.tenantId, tenantId)));
      }

      await writeReuniaoAudit({
        type:
          reasonEnded === "technical_interrupt"
            ? "recording_interrupted"
            : "recording_segment_closed",
        reuniaoId: id,
        actorUserId: actorUserId(c),
        payload: {
          segmentId: (seg as any).id,
          ordinal: (seg as any).ordinal,
          reasonEnded,
          byteSize,
        },
      });

      return c.json({ segment: seg, reuniaoId: id }, 201);
    } catch (error: any) {
      if (isOrdinalUniqueViolation(error)) {
        return c.json({ message: "Conflito de ordinal — tente novamente." }, 409);
      }
      return c.json({ message: String(error?.message ?? "Erro inesperado.") }, 500);
    }
  })
  /**
   * Termina a reunião por intenção humana.
   * Falha técnica NÃO deve chamar este endpoint.
   *
   * Idempotente: segunda chamada enquanto processando / já rascunho
   * não dispara segundo pipeline.
   *
   * Fonte: STT/LLM ainda corre no pedido (limitação Vite). F0 → job ADR-038.
   */
  .post("/:id/end-meeting", async (c) => {
    const id = c.req.param("id");
    return withIdempotency(c, `reunioes:end:${id}`, async () => {
      const row = await findReuniaoForCurrentTenant(id);
      if (!row) return { status: 404 as const, body: { message: "Reunião não encontrada." } };
      if (row.status === "aprovada") {
        return { status: 400 as const, body: { message: "Reunião já aprovada." } };
      }

      // Já processado com sucesso nesta geração → devolver sem reprocessar
      if (row.status === "rascunho" && row.transcricao && row.processingCompletedAt) {
        return { status: 200 as const, body: row };
      }
      // Já em processamento → não arrancar segundo pipeline
      if (row.status === "processando_audio") {
        return { status: 200 as const, body: row };
      }

      const segs = await db
        .select()
        .from(recordingSegments)
        .where(eq(recordingSegments.reuniaoId, id));
      if (segs.length === 0 && !row.audioPath) {
        return {
          status: 400 as const,
          body: { message: "Não há segmentos de áudio para processar." },
        };
      }

      const tenantId = getCurrentTenantId();
      const nextGen = (row.processingGeneration ?? 0) + 1;
      await db.update(reunioes).set({
        status: "processando_audio",
        resumo: "A transcrever segmentos de áudio e a gerar notas com IA…",
        processingGeneration: nextGen,
        processingStartedAt: new Date(),
        processingCompletedAt: null,
        updatedAt: new Date(),
      }).where(and(eq(reunioes.id, id), eq(reunioes.tenantId, tenantId)));

      await writeReuniaoAudit({
        type: "meeting_ended",
        reuniaoId: id,
        actorUserId: actorUserId(c),
        payload: { generation: nextGen, segments: segs.length },
      });
      await writeReuniaoAudit({
        type: "recording_processing_started",
        reuniaoId: id,
        actorUserId: actorUserId(c),
        payload: { generation: nextGen },
      });

      await runReuniaoSttPipeline(id, { expectedGeneration: nextGen });
      const updated = await findReuniaoForCurrentTenant(id);
      return { status: 200 as const, body: updated ?? row };
    });
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const row = await findReuniaoForCurrentTenant(id);
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
      const tenantId = getCurrentTenantId();

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
          tenantId,
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
          processingGeneration: 1,
          processingStartedAt: new Date(),
        }).returning();

        await writeReuniaoAudit({
          type: "meeting_opened",
          reuniaoId: created.id,
          actorUserId: actorUserId(c),
          payload: { legacyCreate: true },
        });
        await writeReuniaoAudit({
          type: "recording_processing_started",
          reuniaoId: created.id,
          actorUserId: actorUserId(c),
          payload: { generation: 1 },
        });

        await runReuniaoSttPipeline(created.id, { expectedGeneration: 1 });
        const updated = await findReuniaoForCurrentTenant(created.id);
        return c.json(updated ?? created, 201);
      }

      const [created] = await db.insert(reunioes).values({
        tenantId,
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
    const existing = await findReuniaoForCurrentTenant(id);
    if (!existing) return c.json({ message: "Reunião não encontrada." }, 404);

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

    const tenantId = getCurrentTenantId();
    const [updated] = await db
      .update(reunioes)
      .set(patch)
      .where(and(eq(reunioes.id, id), eq(reunioes.tenantId, tenantId)))
      .returning();
    if (!updated) return c.json({ message: "Reunião não encontrada." }, 404);
    return c.json(updated);
  })
  .post("/:id/reprocessar", async (c) => {
    const id = c.req.param("id");
    const row = await findReuniaoForCurrentTenant(id);
    if (!row) return c.json({ message: "Reunião não encontrada." }, 404);

    const segs = await db
      .select()
      .from(recordingSegments)
      .where(eq(recordingSegments.reuniaoId, id));
    if (segs.length === 0 && !row.audioPath) {
      return c.json({ message: "Esta reunião não tem áudio guardado." }, 400);
    }

    const tenantId = getCurrentTenantId();
    const nextGen = (row.processingGeneration ?? 0) + 1;
    await db.update(reunioes).set({
      status: "processando_audio",
      resumo: "A regenerar transcrição e resumo…",
      processingGeneration: nextGen,
      processingStartedAt: new Date(),
      processingCompletedAt: null,
      updatedAt: new Date(),
    }).where(and(eq(reunioes.id, id), eq(reunioes.tenantId, tenantId)));

    await writeReuniaoAudit({
      type: "recording_processing_started",
      reuniaoId: id,
      actorUserId: actorUserId(c),
      payload: { generation: nextGen, reprocess: true },
    });

    await runReuniaoSttPipeline(id, { force: true, expectedGeneration: nextGen });
    const updated = await findReuniaoForCurrentTenant(id);
    if (!updated) return c.json({ message: "Reunião não encontrada." }, 404);
    if (updated.status === "erro_audio") {
      return c.json({ ...updated, warning: updated.resumo || "Falha ao regenerar." });
    }
    return c.json(updated);
  })
  .patch("/:id/aprovar", async (c) => {
    const id = c.req.param("id");
    const row = await findReuniaoForCurrentTenant(id);
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

    const tenantId = getCurrentTenantId();
    const [updated] = await db.update(reunioes).set({
      status: "aprovada",
      pdfUrl,
      approvedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(reunioes.id, id), eq(reunioes.tenantId, tenantId))).returning();

    return c.json(updated);
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const row = await findReuniaoForCurrentTenant(id);
    if (!row) return c.json({ message: "Reunião não encontrada." }, 404);

    if (row.audioPath) {
      const abs = path.join(process.cwd(), row.audioPath);
      try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch { /* ignore */ }
    }

    const tenantId = getCurrentTenantId();
    await db.delete(reunioes).where(and(eq(reunioes.id, id), eq(reunioes.tenantId, tenantId)));
    return c.json({ message: "Eliminada." });
  });
