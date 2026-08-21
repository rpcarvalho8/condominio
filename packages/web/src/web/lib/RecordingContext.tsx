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

export type RecordingTarget = "ata" | "reuniao";

export type RecordingDraft = {
  titulo: string;
  data: string;
  participantes?: string;
};

export type RecordingStatus = "idle" | "recording" | "paused";

type RecordingContextValue = {
  status: RecordingStatus;
  /** Destino da gravação activa (null quando idle) */
  target: RecordingTarget | null;
  /** Rascunho do formulário (mantém-se após terminar até clearSession) */
  draft: RecordingDraft | null;
  /** Destino da última sessão (activa ou acabada de terminar) — para restaurar o formulário */
  sessionTarget: RecordingTarget | null;
  elapsedMs: number;
  error: string | null;
  completedFile: File | null;
  completedTarget: RecordingTarget | null;
  supportsPause: boolean;
  start: (target: RecordingTarget, draft: RecordingDraft) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  updateDraft: (patch: Partial<RecordingDraft>) => void;
  consumeCompletedFile: (target: RecordingTarget) => File | null;
  /** Limpa ficheiro + rascunho pendente (após criar ata/reunião com sucesso) */
  clearSession: () => void;
  clearCompleted: () => void;
  clearError: () => void;
};

const RecordingContext = createContext<RecordingContextValue | null>(null);

const PREFERRED_MIME_TYPES = [
  "audio/mp4",
  "audio/aac",
  "audio/webm;codecs=opus",
  "audio/webm",
];

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

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const mimeRef = useRef("");
  const targetRef = useRef<RecordingTarget | null>(null);
  const tickBaseRef = useRef(0);
  const elapsedAtPauseRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  useEffect(() => () => {
    clearTick();
    cleanupStream();
  }, [clearTick, cleanupStream]);

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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMimeType();
      mimeRef.current = mime;
      const recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: 24000,
      });

      const canPause = typeof recorder.pause === "function" && typeof recorder.resume === "function";
      setSupportsPause(canPause);

      chunksRef.current = [];
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      targetRef.current = nextTarget;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const finalMime = mimeRef.current || recorder.mimeType || "audio/webm";
        const ext = extForMime(finalMime);
        const endedTarget = targetRef.current ?? "ata";
        const prefix = formatPrefix(endedTarget);
        const blob = new Blob(chunksRef.current, { type: finalMime });
        const file = new File([blob], `${prefix}_${Date.now()}.${ext}`, { type: blob.type || finalMime });
        setCompletedFile(file);
        setCompletedTarget(endedTarget);
        setSessionTarget(endedTarget);
        // draft mantém-se para restaurar o formulário ao voltar à página
        cleanupStream();
        clearTick();
        setStatus("idle");
        setTarget(null);
        elapsedAtPauseRef.current = 0;
        setElapsedMs(0);
      };

      recorder.onerror = () => {
        setError("Erro durante a gravação.");
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          cleanupStream();
          clearTick();
          setStatus("idle");
          setTarget(null);
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
      setStatus("idle");
      setTarget(null);
      setError(e?.message ?? "Erro ao iniciar gravação. Verifica permissões do microfone.");
    }
  }, [status, cleanupStream, clearTick, startTick]);

  const pause = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || status !== "recording") return;
    if (typeof recorder.pause !== "function") {
      setError("Pausa não suportada neste dispositivo. Pode terminar a gravação.");
      return;
    }
    try {
      recorder.pause();
      clearTick();
      elapsedAtPauseRef.current = elapsedAtPauseRef.current + (Date.now() - tickBaseRef.current);
      setElapsedMs(elapsedAtPauseRef.current);
      setStatus("paused");
    } catch (e: any) {
      setError(e?.message ?? "Erro ao pausar gravação.");
    }
  }, [status, clearTick]);

  const resume = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || status !== "paused") return;
    try {
      recorder.resume();
      setStatus("recording");
      startTick();
    } catch (e: any) {
      setError(e?.message ?? "Erro ao retomar gravação.");
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
    } catch (e: any) {
      setError(e?.message ?? "Erro ao terminar gravação.");
      cleanupStream();
      setStatus("idle");
      setTarget(null);
    }
  }, [clearTick, cleanupStream]);

  const updateDraft = useCallback((patch: Partial<RecordingDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : { titulo: "", data: "", ...patch }));
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
    setCompletedFile(null);
    setCompletedTarget(null);
    setDraft(null);
    setSessionTarget(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

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
    start,
    pause,
    resume,
    stop,
    updateDraft,
    consumeCompletedFile,
    clearSession,
    clearCompleted,
    clearError,
  }), [
    status, target, draft, sessionTarget, elapsedMs, error, completedFile, completedTarget, supportsPause,
    start, pause, resume, stop, updateDraft, consumeCompletedFile, clearSession, clearCompleted, clearError,
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
