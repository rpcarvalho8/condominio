import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  appendRecordingChunk,
  assembleRecordingFile,
  createRecordingSession,
  deleteRecordingSession,
  formatBytes,
  getRecordingSession,
  listRecoverableSessions,
  newRecordingSessionId,
  updateRecordingSession,
  type PersistedSession,
} from "./recording-idb";

export type RecordingTarget = "ata" | "reuniao";

export type RecordingDraft = {
  titulo: string;
  data: string;
  participantes?: string;
};

export type RecordingStatus = "idle" | "recording" | "paused";

export type RecoverableRecording = {
  session: PersistedSession;
  file: File;
};

type RecordingContextValue = {
  status: RecordingStatus;
  target: RecordingTarget | null;
  draft: RecordingDraft | null;
  sessionTarget: RecordingTarget | null;
  elapsedMs: number;
  error: string | null;
  completedFile: File | null;
  completedTarget: RecordingTarget | null;
  supportsPause: boolean;
  /** Bytes já persistidos no IndexedDB (gravação activa) */
  persistedBytes: number;
  /** Sessões recuperáveis após crash / fecho de aba */
  recoverable: RecoverableRecording[];
  start: (target: RecordingTarget, draft: RecordingDraft) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  updateDraft: (patch: Partial<RecordingDraft>) => void;
  consumeCompletedFile: (target: RecordingTarget) => File | null;
  clearSession: () => void;
  clearCompleted: () => void;
  clearError: () => void;
  /** Restaura gravação guardada localmente para o formulário */
  restoreRecoverable: (sessionId: string) => Promise<void>;
  discardRecoverable: (sessionId: string) => Promise<void>;
  refreshRecoverable: () => Promise<void>;
};

const RecordingContext = createContext<RecordingContextValue | null>(null);

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/aac",
];

/** Constraints optimizadas para voz: mono + cancelamento de eco (ficheiro ~70% mais pequeno). */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: { ideal: 1 },
  echoCancellation: { ideal: true },
  noiseSuppression: { ideal: true },
  autoGainControl: { ideal: true },
};

const AUDIO_BITS_PER_SECOND = 24_000;

function pickMimeType(): string {
  return (
    PREFERRED_MIME_TYPES.find((mt) =>
      typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(mt),
    ) ?? ""
  );
}

function extForMime(mime: string): string {
  if (mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a")) return "m4a";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

function formatPrefix(target: RecordingTarget): string {
  return target === "ata" ? "ata" : "reuniao";
}

export function RecordingProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [target, setTarget] = useState<RecordingTarget | null>(null);
  const [sessionTarget, setSessionTarget] = useState<RecordingTarget | null>(null);
  const [draft, setDraft] = useState<RecordingDraft | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [completedFile, setCompletedFile] = useState<File | null>(null);
  const [completedTarget, setCompletedTarget] = useState<RecordingTarget | null>(null);
  const [supportsPause, setSupportsPause] = useState(true);
  const [persistedBytes, setPersistedBytes] = useState(0);
  const [recoverable, setRecoverable] = useState<RecoverableRecording[]>([]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const mimeRef = useRef("");
  const targetRef = useRef<RecordingTarget | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const draftRef = useRef<RecordingDraft | null>(null);
  const flushQueueRef = useRef<Promise<void>>(Promise.resolve());
  const tickBaseRef = useRef(0);
  const elapsedAtPauseRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusRef = useRef<RecordingStatus>("idle");

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const clearTick = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const startTick = useCallback(() => {
    clearTick();
    tickBaseRef.current = Date.now();
    intervalRef.current = setInterval(() => {
      setElapsedMs(elapsedAtPauseRef.current + (Date.now() - tickBaseRef.current));
    }, 250);
  }, [clearTick]);

  const cleanupStream = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const enqueueFlush = useCallback((blob: Blob) => {
    const sid = sessionIdRef.current;
    if (!sid || !blob.size) return;
    flushQueueRef.current = flushQueueRef.current
      .then(async () => {
        const res = await appendRecordingChunk(sid, blob);
        if (res) setPersistedBytes(res.byteSize);
      })
      .catch((e) => {
        console.warn("[recording-idb] flush falhou:", e);
      });
  }, []);

  const flushPendingData = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    try {
      if (typeof recorder.requestData === "function" && recorder.state === "recording") {
        recorder.requestData();
      }
    } catch { /* ignore */ }
  }, []);

  const refreshRecoverable = useCallback(async () => {
    try {
      const sessions = await listRecoverableSessions();
      // Não listar a sessão activa (ainda a gravar neste processo)
      const activeId = sessionIdRef.current;
      const candidates = sessions.filter((s) => s.id !== activeId);
      const out: RecoverableRecording[] = [];
      for (const session of candidates) {
        const file = await assembleRecordingFile(session);
        if (file && file.size > 0) out.push({ session, file });
      }
      setRecoverable(out);
    } catch (e) {
      console.warn("[recording-idb] refreshRecoverable:", e);
    }
  }, []);

  useEffect(() => {
    void refreshRecoverable();
  }, [refreshRecoverable]);

  // Aviso ao fechar aba / iPad suspende — flush + beforeunload
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden" && statusRef.current !== "idle") {
        flushPendingData();
        const sid = sessionIdRef.current;
        if (sid) {
          const elapsed = elapsedAtPauseRef.current
            + (statusRef.current === "recording" ? Date.now() - tickBaseRef.current : 0);
          void updateRecordingSession(sid, {
            status: statusRef.current === "paused" ? "paused" : "recording",
            elapsedMs: elapsed,
            draft: draftRef.current ?? { titulo: "", data: "" },
          });
        }
      }
    };
    const onPageHide = () => {
      flushPendingData();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (statusRef.current === "idle") return;
      flushPendingData();
      e.preventDefault();
      e.returnValue = "";
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [flushPendingData]);

  useEffect(() => () => {
    clearTick();
    // Não limpar IndexedDB no unmount — é a salvaguarda
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
  }, [clearTick]);

  const start = useCallback(async (nextTarget: RecordingTarget, nextDraft: RecordingDraft) => {
    setError(null);
    if (status === "recording" || status === "paused") {
      setError("Já existe uma gravação em curso. Termine-a antes de iniciar outra.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Gravação de áudio não suportada neste browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      // Garantir mono no track se o browser permitir
      try {
        const track = stream.getAudioTracks()[0];
        if (track?.applyConstraints) {
          await track.applyConstraints({ channelCount: 1 });
        }
      } catch {
        /* alguns browsers ignoram channelCount — não é fatal */
      }

      const mime = pickMimeType();
      mimeRef.current = mime;
      const recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
      console.log(
        `[recording] mime=${mime || recorder.mimeType || "default"} bitrate=${AUDIO_BITS_PER_SECOND} mono`,
      );

      const canPause = typeof recorder.pause === "function" && typeof recorder.resume === "function";
      setSupportsPause(canPause);

      const sessionId = newRecordingSessionId();
      sessionIdRef.current = sessionId;
      await createRecordingSession({
        id: sessionId,
        target: nextTarget,
        draft: nextDraft,
        mimeType: mime || "audio/webm",
        status: "recording",
        startedAt: Date.now(),
        elapsedMs: 0,
      });

      chunksRef.current = [];
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      targetRef.current = nextTarget;
      setPersistedBytes(0);

      recorder.ondataavailable = (event: BlobEvent) => {
        if (!event.data || event.data.size === 0) return;
        chunksRef.current.push(event.data);
        enqueueFlush(event.data);
      };

      recorder.onstop = () => {
        const finalize = async () => {
          // Esperar flushes IndexedDB pendentes
          await flushQueueRef.current.catch(() => undefined);
          const sid = sessionIdRef.current;
          const finalMime = mimeRef.current || recorder.mimeType || "audio/webm";
          const endedTarget = targetRef.current ?? "ata";
          const prefix = formatPrefix(endedTarget);

          let file: File | null = null;
          if (sid) {
            await updateRecordingSession(sid, {
              status: "completed",
              mimeType: finalMime,
              draft: draftRef.current ?? { titulo: "", data: "" },
              elapsedMs: elapsedAtPauseRef.current,
            });
            const session = await getRecordingSession(sid);
            if (session) file = await assembleRecordingFile(session);
          }

          if (!file || file.size === 0) {
            const blob = new Blob(chunksRef.current, { type: finalMime });
            const ext = extForMime(finalMime);
            file = new File([blob], `${prefix}_${Date.now()}.${ext}`, { type: blob.type || finalMime });
          }

          setCompletedFile(file);
          setCompletedTarget(endedTarget);
          setSessionTarget(endedTarget);
          cleanupStream();
          clearTick();
          setStatus("idle");
          setTarget(null);
          elapsedAtPauseRef.current = 0;
          setElapsedMs(0);
          // Mantém sessionId até clearSession (upload OK) para poder apagar IDB
        };

        void finalize().catch((e) => {
          console.error("[recording] finalize:", e);
          setError("Gravação terminou mas falhou a montagem do ficheiro. Tente recuperar na barra inferior.");
          cleanupStream();
          clearTick();
          setStatus("idle");
          setTarget(null);
          void refreshRecoverable();
        });
      };

      recorder.onerror = () => {
        setError("Erro durante a gravação — o áudio já gravado está guardado neste dispositivo.");
        flushPendingData();
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          cleanupStream();
          clearTick();
          setStatus("idle");
          setTarget(null);
          void refreshRecoverable();
        }
      };

      recorder.start(1000);
      setTarget(nextTarget);
      setSessionTarget(nextTarget);
      setDraft(nextDraft);
      setCompletedFile(null);
      setCompletedTarget(null);
      setStatus("recording");
      elapsedAtPauseRef.current = 0;
      setElapsedMs(0);
      startTick();
    } catch (e: any) {
      cleanupStream();
      sessionIdRef.current = null;
      setStatus("idle");
      setTarget(null);
      const msg = String(e?.message ?? "");
      if (/Permission|NotAllowed/i.test(msg)) {
        setError("Microfone bloqueado. Autorize o microfone nas definições do Safari/browser.");
      } else {
        setError("Não foi possível iniciar a gravação. Verifique o microfone e tente outra vez.");
      }
    }
  }, [status, cleanupStream, clearTick, startTick, enqueueFlush, flushPendingData, refreshRecoverable]);

  const pause = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || status !== "recording") return;
    if (typeof recorder.pause !== "function") {
      setError("Pausa não suportada neste dispositivo. Pode terminar a gravação.");
      return;
    }
    try {
      flushPendingData();
      recorder.pause();
      clearTick();
      elapsedAtPauseRef.current = elapsedAtPauseRef.current + (Date.now() - tickBaseRef.current);
      setElapsedMs(elapsedAtPauseRef.current);
      setStatus("paused");
      const sid = sessionIdRef.current;
      if (sid) {
        void updateRecordingSession(sid, {
          status: "paused",
          elapsedMs: elapsedAtPauseRef.current,
          draft: draftRef.current ?? { titulo: "", data: "" },
        });
      }
    } catch {
      setError("Não foi possível pausar. Pode terminar a gravação — o áudio já está guardado.");
    }
  }, [status, clearTick, flushPendingData]);

  const resume = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || status !== "paused") return;
    try {
      recorder.resume();
      setStatus("recording");
      startTick();
      const sid = sessionIdRef.current;
      if (sid) void updateRecordingSession(sid, { status: "recording" });
    } catch {
      setError("Não foi possível retomar. Termine e use «Recuperar gravação» se necessário.");
    }
  }, [status, startTick]);

  const stop = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    try {
      if (recorder.state !== "inactive") {
        if (typeof recorder.requestData === "function" && recorder.state === "recording") {
          try { recorder.requestData(); } catch { /* ignore */ }
        }
        recorder.stop();
      }
      clearTick();
    } catch {
      setError("Erro ao terminar — tente «Recuperar gravação» na barra inferior.");
      cleanupStream();
      setStatus("idle");
      setTarget(null);
      void refreshRecoverable();
    }
  }, [clearTick, cleanupStream, refreshRecoverable]);

  const updateDraft = useCallback((patch: Partial<RecordingDraft>) => {
    setDraft((prev) => {
      const next = prev ? { ...prev, ...patch } : { titulo: "", data: "", ...patch };
      draftRef.current = next;
      const sid = sessionIdRef.current;
      if (sid) void updateRecordingSession(sid, { draft: next });
      return next;
    });
  }, []);

  const consumeCompletedFile = useCallback((forTarget: RecordingTarget) => {
    if (completedTarget !== forTarget || !completedFile) return null;
    const file = completedFile;
    setCompletedFile(null);
    setCompletedTarget(null);
    return file;
  }, [completedFile, completedTarget]);

  const clearCompleted = useCallback(() => {
    setCompletedFile(null);
    setCompletedTarget(null);
  }, []);

  const clearSession = useCallback(() => {
    const sid = sessionIdRef.current;
    setCompletedFile(null);
    setCompletedTarget(null);
    setDraft(null);
    setSessionTarget(null);
    setPersistedBytes(0);
    sessionIdRef.current = null;
    if (sid) void deleteRecordingSession(sid).then(() => refreshRecoverable());
  }, [refreshRecoverable]);

  const clearError = useCallback(() => setError(null), []);

  const restoreRecoverable = useCallback(async (sessionId: string) => {
    const entry = recoverable.find((r) => r.session.id === sessionId);
    if (!entry) {
      setError("Gravação não encontrada neste dispositivo.");
      return;
    }
    await updateRecordingSession(sessionId, { status: "completed" });
    sessionIdRef.current = sessionId;
    setCompletedFile(entry.file);
    setCompletedTarget(entry.session.target);
    setSessionTarget(entry.session.target);
    setDraft(entry.session.draft);
    setPersistedBytes(entry.session.byteSize);
    setRecoverable((prev) => prev.filter((r) => r.session.id !== sessionId));
  }, [recoverable]);

  const discardRecoverable = useCallback(async (sessionId: string) => {
    await deleteRecordingSession(sessionId);
    if (sessionIdRef.current === sessionId) sessionIdRef.current = null;
    setRecoverable((prev) => prev.filter((r) => r.session.id !== sessionId));
  }, []);

  const value = useMemo<RecordingContextValue>(() => ({
    status,
    target,
    draft,
    sessionTarget,
    elapsedMs,
    error,
    completedFile,
    completedTarget,
    supportsPause,
    persistedBytes,
    recoverable,
    start,
    pause,
    resume,
    stop,
    updateDraft,
    consumeCompletedFile,
    clearSession,
    clearCompleted,
    clearError,
    restoreRecoverable,
    discardRecoverable,
    refreshRecoverable,
  }), [
    status, target, draft, sessionTarget, elapsedMs, error, completedFile, completedTarget, supportsPause,
    persistedBytes, recoverable,
    start, pause, resume, stop, updateDraft, consumeCompletedFile, clearSession, clearCompleted, clearError,
    restoreRecoverable, discardRecoverable, refreshRecoverable,
  ]);

  return (
    <RecordingContext.Provider value={value}>
      {children}
    </RecordingContext.Provider>
  );
}

export function useRecording(): RecordingContextValue {
  const ctx = useContext(RecordingContext);
  if (!ctx) throw new Error("useRecording deve ser usado dentro de RecordingProvider");
  return ctx;
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function recordingReturnPath(target: RecordingTarget): string {
  return target === "ata" ? "/atas" : "/reunioes";
}

export function recordingLabel(target: RecordingTarget): string {
  return target === "ata" ? "Assembleia (Ata)" : "Reunião";
}

export { formatBytes };
