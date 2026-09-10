import { db } from "../database";
import { auditEvents } from "../database/schema";
import { getCurrentTenantId } from "./tenant";

export type ReuniaoAuditType =
  | "meeting_opened"
  | "recording_segment_started"
  | "recording_segment_closed"
  | "recording_interrupted"
  | "recording_resumed"
  | "recording_upload_failed"
  | "recording_processing_started"
  | "recording_processing_failed"
  | "recording_processing_completed"
  | "meeting_ended";

export async function writeReuniaoAudit(input: {
  type: ReuniaoAuditType;
  reuniaoId: string;
  actorUserId?: string | null;
  payload?: Record<string, unknown>;
  tenantId?: string;
}): Promise<void> {
  const tenantId = input.tenantId ?? getCurrentTenantId();
  try {
    await db.insert(auditEvents).values({
      tenantId,
      type: input.type,
      entityType: "reuniao",
      entityId: input.reuniaoId,
      actorUserId: input.actorUserId ?? null,
      payloadJson: input.payload ? JSON.stringify(input.payload) : null,
      source: "reuniao",
    });
  } catch (e) {
    // Auditoria nunca deve derrubar o fluxo de negócio; logar e continuar.
    console.error("[audit] falha ao gravar evento", input.type, e);
  }
}
