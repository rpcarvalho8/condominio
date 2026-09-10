/**
 * Domínio de gravação contínua de Reunião.
 * Uma falha técnica fecha um RecordingSegment — nunca a Reunião.
 */

export type ReuniaoLifecycleStatus = "draft" | "in_progress" | "ended";

export type SegmentEndReason =
  | "user_stop_segment"
  | "technical_interrupt"
  | "user_end_meeting";

export type RecordingSegmentState = {
  ordinal: number;
  startedAt: number;
  endedAt: number | null;
  reasonEnded: SegmentEndReason | null;
  status: "open" | "closed";
};

export type ReuniaoRecordingState = {
  reuniaoId: string;
  lifecycle: ReuniaoLifecycleStatus;
  segments: RecordingSegmentState[];
};

export function createOpenReuniao(reuniaoId: string, now = Date.now()): ReuniaoRecordingState {
  return {
    reuniaoId,
    lifecycle: "in_progress",
    segments: [
      {
        ordinal: 1,
        startedAt: now,
        endedAt: null,
        reasonEnded: null,
        status: "open",
      },
    ],
  };
}

function openSegment(state: ReuniaoRecordingState): RecordingSegmentState | undefined {
  return state.segments.find((s) => s.status === "open");
}

/** Interrupção técnica ou stop de segmento: fecha o segmento aberto; reunião continua. */
export function closeCurrentSegment(
  state: ReuniaoRecordingState,
  reason: SegmentEndReason,
  now = Date.now(),
): ReuniaoRecordingState {
  if (state.lifecycle === "ended") {
    throw new Error("Não é possível fechar segmento numa reunião já terminada.");
  }
  const open = openSegment(state);
  if (!open) {
    return { ...state, segments: [...state.segments] };
  }
  return {
    ...state,
    lifecycle: "in_progress",
    segments: state.segments.map((s) =>
      s.ordinal === open.ordinal
        ? { ...s, status: "closed", endedAt: now, reasonEnded: reason }
        : s,
    ),
  };
}

/** Retoma gravação na mesma reunião — novo segmento. */
export function resumeRecording(
  state: ReuniaoRecordingState,
  now = Date.now(),
): ReuniaoRecordingState {
  if (state.lifecycle === "ended") {
    throw new Error("Não é possível retomar uma reunião terminada.");
  }
  if (openSegment(state)) {
    throw new Error("Já existe um segmento de gravação aberto.");
  }
  const nextOrdinal =
    state.segments.reduce((max, s) => Math.max(max, s.ordinal), 0) + 1;
  return {
    reuniaoId: state.reuniaoId,
    lifecycle: "in_progress",
    segments: [
      ...state.segments,
      {
        ordinal: nextOrdinal,
        startedAt: now,
        endedAt: null,
        reasonEnded: null,
        status: "open",
      },
    ],
  };
}

/**
 * Terminar reunião — única transição para `ended`.
 * reason deve ser user_end_meeting (intenção humana).
 */
export function endMeeting(
  state: ReuniaoRecordingState,
  now = Date.now(),
): ReuniaoRecordingState {
  if (state.lifecycle === "ended") {
    return state;
  }
  let next = state;
  if (openSegment(state)) {
    next = closeCurrentSegment(state, "user_end_meeting", now);
  }
  return {
    ...next,
    lifecycle: "ended",
  };
}

/** Falha técnica NUNCA equivale a ended. */
export function applyTechnicalInterrupt(
  state: ReuniaoRecordingState,
  now = Date.now(),
): ReuniaoRecordingState {
  return closeCurrentSegment(state, "technical_interrupt", now);
}

export function assertSingleReuniao(states: ReuniaoRecordingState[]): string {
  const ids = new Set(states.map((s) => s.reuniaoId));
  if (ids.size !== 1) {
    throw new Error(`Esperava 1 reuniaoId, obtive ${ids.size}`);
  }
  return [...ids][0]!;
}

export function segmentCount(state: ReuniaoRecordingState): number {
  return state.segments.length;
}

export function isMeetingOpen(state: ReuniaoRecordingState): boolean {
  return state.lifecycle !== "ended";
}

/** Mapeia lifecycle de domínio → status persistido na app actual. */
export function toPersistedReuniaoStatus(
  lifecycle: ReuniaoLifecycleStatus,
  phase: "recording" | "processing" | "draft" = "recording",
): string {
  if (lifecycle === "draft") return "rascunho";
  if (lifecycle === "in_progress") return "em_curso";
  if (phase === "processing") return "processando_audio";
  return "terminada";
}
