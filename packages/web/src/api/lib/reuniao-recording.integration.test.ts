/**
 * Testes de integração — Reunião + RecordingSegment (BD real sqlite).
 * Casos obrigatórios Parte E da auditoria final.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, asc, eq, max } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

const DB_PATH = path.join(import.meta.dir, "..", "..", "..", ".tmp-test-reuniao.db");
const DB_URL = `file:${DB_PATH}`;

const reunioes = sqliteTable(
  "reunioes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    titulo: text("titulo").notNull(),
    data: integer("data", { mode: "timestamp" }).notNull(),
    status: text("status").notNull().default("em_curso"),
    audioPath: text("audio_path"),
    transcricao: text("transcricao"),
    resumo: text("resumo"),
    processingGeneration: integer("processing_generation").notNull().default(0),
    processingStartedAt: integer("processing_started_at", { mode: "timestamp" }),
    processingCompletedAt: integer("processing_completed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    tenantIdx: index("reunioes_tenant_idx").on(t.tenantId),
  }),
);

const recordingSegments = sqliteTable(
  "recording_segments",
  {
    id: text("id").primaryKey(),
    reuniaoId: text("reuniao_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp" }),
    reasonEnded: text("reason_ended"),
    storagePath: text("storage_path"),
    byteSize: integer("byte_size").notNull().default(0),
    status: text("status").notNull().default("closed"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    uq: uniqueIndex("recording_segments_reuniao_ordinal_uq").on(t.reuniaoId, t.ordinal),
  }),
);

const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  type: text("type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  payloadJson: text("payload_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

const schema = { reunioes, recordingSegments, auditEvents };

let client: ReturnType<typeof createClient>;
let db: ReturnType<typeof drizzle>;

const TENANT_A = "tenant-A-nif";
const TENANT_B = "tenant-B-nif";

async function allocateOrdinal(reuniaoId: string): Promise<number> {
  const [row] = await db
    .select({ m: max(recordingSegments.ordinal) })
    .from(recordingSegments)
    .where(eq(recordingSegments.reuniaoId, reuniaoId));
  return (row?.m ?? 0) + 1;
}

async function insertSegmentSafe(
  reuniaoId: string,
  reasonEnded: string,
  maxAttempts = 16,
) {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    const ordinal = await allocateOrdinal(reuniaoId);
    try {
      const [seg] = await db
        .insert(recordingSegments)
        .values({
          id: crypto.randomUUID(),
          reuniaoId,
          ordinal,
          startedAt: new Date(),
          endedAt: new Date(),
          reasonEnded,
          storagePath: `data/reunioes/${reuniaoId}_${ordinal}.webm`,
          byteSize: 100,
          status: "closed",
          createdAt: new Date(),
        })
        .returning();
      return seg!;
    } catch (e: any) {
      lastErr = e;
      const blob = [
        e?.message,
        e?.cause?.message,
        e?.code,
        e?.cause?.code,
        e?.cause?.cause?.message,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!blob.includes("unique") && !blob.includes("constraint")) throw e;
      await new Promise((r) => setTimeout(r, 5 + i * 3));
    }
  }
  throw lastErr;
}

async function openMeeting(tenantId: string, titulo = "Teste") {
  const [row] = await db
    .insert(reunioes)
    .values({
      id: crypto.randomUUID(),
      tenantId,
      titulo,
      data: new Date(),
      status: "em_curso",
      audioPath: null,
      transcricao: null,
      resumo: "em curso",
      processingGeneration: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  await db.insert(auditEvents).values({
    id: crypto.randomUUID(),
    tenantId,
    type: "meeting_opened",
    entityType: "reuniao",
    entityId: row!.id,
    payloadJson: null,
    createdAt: new Date(),
  });
  return row!;
}

async function findForTenant(id: string, tenantId: string) {
  const [row] = await db
    .select()
    .from(reunioes)
    .where(and(eq(reunioes.id, id), eq(reunioes.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

/** Simula pipeline idempotente (sem STT real). */
async function endMeetingProcess(reuniaoId: string, tenantId: string) {
  const row = await findForTenant(reuniaoId, tenantId);
  if (!row) return { status: 404 as const, body: null };

  if (row.status === "rascunho" && row.transcricao && row.processingCompletedAt) {
    return { status: 200 as const, body: row, skipped: true };
  }
  if (row.status === "processando_audio") {
    return { status: 200 as const, body: row, skipped: true };
  }

  const segs = await db
    .select()
    .from(recordingSegments)
    .where(eq(recordingSegments.reuniaoId, reuniaoId));
  if (segs.length === 0) return { status: 400 as const, body: null };

  const nextGen = (row.processingGeneration ?? 0) + 1;
  await db
    .update(reunioes)
    .set({
      status: "processando_audio",
      processingGeneration: nextGen,
      processingStartedAt: new Date(),
      processingCompletedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(reunioes.id, reuniaoId), eq(reunioes.tenantId, tenantId)));

  // "pipeline" — uma única transcrição lógica
  const ordered = [...segs].sort((a, b) => a.ordinal - b.ordinal);
  const transcricao = ordered.map((s) => `seg${s.ordinal}`).join("\n");

  await db
    .update(reunioes)
    .set({
      status: "rascunho",
      transcricao,
      resumo: "ok",
      processingCompletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(reunioes.id, reuniaoId), eq(reunioes.tenantId, tenantId)));

  await db.insert(auditEvents).values({
    id: crypto.randomUUID(),
    tenantId,
    type: "meeting_ended",
    entityType: "reuniao",
    entityId: reuniaoId,
    payloadJson: JSON.stringify({ generation: nextGen }),
    createdAt: new Date(),
  });

  const updated = await findForTenant(reuniaoId, tenantId);
  return { status: 200 as const, body: updated, skipped: false };
}

beforeAll(async () => {
  try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  } catch {
    /* ignore */
  }
  client = createClient({ url: DB_URL });
  db = drizzle(client, { schema });

  await client.executeMultiple(`
    CREATE TABLE reunioes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      data INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'em_curso',
      audio_path TEXT,
      transcricao TEXT,
      resumo TEXT,
      processing_generation INTEGER NOT NULL DEFAULT 0,
      processing_started_at INTEGER,
      processing_completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE recording_segments (
      id TEXT PRIMARY KEY,
      reuniao_id TEXT NOT NULL REFERENCES reunioes(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      reason_ended TEXT,
      storage_path TEXT,
      byte_size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'closed',
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX recording_segments_reuniao_ordinal_uq
      ON recording_segments (reuniao_id, ordinal);
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT,
      created_at INTEGER NOT NULL
    );
  `);
});

beforeEach(async () => {
  await client.execute("DELETE FROM recording_segments");
  await client.execute("DELETE FROM audit_events");
  await client.execute("DELETE FROM reunioes");
});

afterAll(async () => {
  try {
    client.close();
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  } catch {
    /* ignore */
  }
});

describe("Integração Reunião / RecordingSegment", () => {
  test("Caso 1 — gravação normal: 1 reunião, 1 segmento", async () => {
    const r = await openMeeting(TENANT_A);
    await insertSegmentSafe(r.id, "user_end_meeting");
    const end = await endMeetingProcess(r.id, TENANT_A);
    expect(end.status).toBe(200);
    expect(end.skipped).toBe(false);

    const segs = await db
      .select()
      .from(recordingSegments)
      .where(eq(recordingSegments.reuniaoId, r.id));
    expect(segs.length).toBe(1);
    expect(end.body?.status).toBe("rascunho");
    expect(end.body?.transcricao).toContain("seg1");
  });

  test("Caso 2 — interrupção + resume: 1 reuniaoId, 2 segmentos", async () => {
    const r = await openMeeting(TENANT_A);
    const s1 = await insertSegmentSafe(r.id, "technical_interrupt");
    const s2 = await insertSegmentSafe(r.id, "user_end_meeting");
    expect(s1.reuniaoId).toBe(s2.reuniaoId);
    expect(s1.ordinal).toBe(1);
    expect(s2.ordinal).toBe(2);

    const end = await endMeetingProcess(r.id, TENANT_A);
    expect(end.body?.transcricao).toBe("seg1\nseg2");
    const all = await db.select().from(reunioes);
    expect(all.length).toBe(1);
  });

  test("Caso 3 — múltiplas interrupções: S1..S4, um reuniaoId", async () => {
    const r = await openMeeting(TENANT_A);
    for (let i = 0; i < 4; i++) {
      await insertSegmentSafe(
        r.id,
        i < 3 ? "technical_interrupt" : "user_end_meeting",
      );
    }
    const segs = await db
      .select()
      .from(recordingSegments)
      .where(eq(recordingSegments.reuniaoId, r.id))
      .orderBy(asc(recordingSegments.ordinal));
    expect(segs.map((s) => s.ordinal)).toEqual([1, 2, 3, 4]);
    expect(new Set(segs.map((s) => s.reuniaoId)).size).toBe(1);
  });

  test("Caso 4 — resume NÃO cria nova Reunião", async () => {
    const r = await openMeeting(TENANT_A);
    await insertSegmentSafe(r.id, "technical_interrupt");
    // resume = novo segmento no mesmo id (ensureOpenReuniao no FE)
    await insertSegmentSafe(r.id, "user_stop_segment");
    const all = await db.select().from(reunioes).where(eq(reunioes.tenantId, TENANT_A));
    expect(all.length).toBe(1);
    expect(all[0]!.id).toBe(r.id);
  });

  test("Caso 5 — requests concorrentes: ordinal único", async () => {
    const r = await openMeeting(TENANT_A);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => insertSegmentSafe(r.id, "user_stop_segment")),
    );
    const ordinals = results.map((s) => s.ordinal).sort((a, b) => a - b);
    expect(ordinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(ordinals).size).toBe(10);
  });

  test("Caso 6 — tenant isolation", async () => {
    const a = await openMeeting(TENANT_A, "A");
    const b = await openMeeting(TENANT_B, "B");

    expect(await findForTenant(b.id, TENANT_A)).toBeNull();
    expect(await findForTenant(a.id, TENANT_B)).toBeNull();

    // Tenant A não inserir segmento em reunião B
    const owned = await findForTenant(b.id, TENANT_A);
    expect(owned).toBeNull();

    // Terminar reunião B como tenant A falha
    const end = await endMeetingProcess(b.id, TENANT_A);
    expect(end.status).toBe(404);

    // Tenant B consegue
    await insertSegmentSafe(b.id, "user_end_meeting");
    const endB = await endMeetingProcess(b.id, TENANT_B);
    expect(endB.status).toBe(200);
  });

  test("Caso 7 — end-meeting idempotente", async () => {
    const r = await openMeeting(TENANT_A);
    await insertSegmentSafe(r.id, "user_end_meeting");
    const first = await endMeetingProcess(r.id, TENANT_A);
    expect(first.skipped).toBe(false);
    const gen1 = first.body!.processingGeneration;

    const second = await endMeetingProcess(r.id, TENANT_A);
    expect(second.skipped).toBe(true);
    expect(second.body!.processingGeneration).toBe(gen1);
    expect(second.body!.transcricao).toBe(first.body!.transcricao);

    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, r.id));
    const ends = audits.filter((a) => a.type === "meeting_ended");
    expect(ends.length).toBe(1);
  });

  test("Caso 8 — processamento repetido não duplica efeitos", async () => {
    const r = await openMeeting(TENANT_A);
    await insertSegmentSafe(r.id, "user_end_meeting");
    await endMeetingProcess(r.id, TENANT_A);
    const before = await findForTenant(r.id, TENANT_A);
    await endMeetingProcess(r.id, TENANT_A);
    await endMeetingProcess(r.id, TENANT_A);
    const after = await findForTenant(r.id, TENANT_A);
    expect(after!.transcricao).toBe(before!.transcricao);
    expect(after!.processingGeneration).toBe(before!.processingGeneration);
  });
});
