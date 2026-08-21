import { useState } from "react";
import { Link } from "wouter";
import { Mic, Pause, Play, Square, ExternalLink } from "lucide-react";
import { Button } from "./ui/Button";
import {
  formatElapsed,
  recordingLabel,
  recordingReturnPath,
  useRecording,
} from "../lib/RecordingContext";

export function RecordingBar() {
  const {
    status,
    target,
    draft,
    sessionTarget,
    elapsedMs,
    error,
    completedFile,
    completedTarget,
    supportsPause,
    pause,
    resume,
    stop,
    clearError,
  } = useRecording();
  const [readyBannerHidden, setReadyBannerHidden] = useState(false);

  const readyTarget = completedTarget ?? (status === "idle" && completedFile ? sessionTarget : null);

  if (status === "idle" && completedFile && readyTarget && !readyBannerHidden) {
    const returnPath = recordingReturnPath(readyTarget);
    return (
      <div
        className="fixed bottom-4 left-1/2 z-50 w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border shadow-xl px-4 py-3"
        style={{ background: "var(--bg-elevated)", borderColor: "var(--green)" }}
        role="status"
      >
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold" style={{ color: "var(--green)" }}>
              Gravação pronta
            </p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              {recordingLabel(readyTarget)}
              {draft?.titulo ? ` · ${draft.titulo}` : ""} · {completedFile.name}
            </p>
          </div>
          <Link
            href={returnPath}
            className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium"
            style={{ background: "var(--blue-primary)", color: "white" }}
          >
            Continuar
          </Link>
          <Button variant="ghost" size="sm" onClick={() => setReadyBannerHidden(true)}>
            Minimizar
          </Button>
        </div>
      </div>
    );
  }

  if (status === "idle" && completedFile && readyTarget && readyBannerHidden) {
    const returnPath = recordingReturnPath(readyTarget);
    return (
      <Link
        href={returnPath}
        className="fixed bottom-4 right-4 z-50 rounded-full border px-3 py-2 text-xs font-medium shadow-lg"
        style={{ background: "var(--bg-elevated)", borderColor: "var(--green)", color: "var(--green)" }}
      >
        Áudio pronto · Continuar
      </Link>
    );
  }

  if (status === "idle" || !target) {
    if (!error) return null;
    return (
      <div
        className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border px-4 py-3 shadow-lg"
        style={{
          background: "var(--bg-elevated)",
          borderColor: "var(--red)",
          color: "var(--text-primary)",
        }}
      >
        <p className="text-sm" style={{ color: "var(--red)" }}>{error}</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={clearError}>
          Fechar
        </Button>
      </div>
    );
  }

  const isPaused = status === "paused";
  const returnPath = recordingReturnPath(target);

  return (
    <div
      className="fixed bottom-4 left-1/2 z-50 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border shadow-xl"
      style={{
        background: "var(--bg-elevated)",
        borderColor: isPaused ? "var(--amber)" : "var(--red)",
      }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{
            background: isPaused ? "var(--amber)" : "var(--red)",
            color: "white",
          }}
        >
          <Mic size={16} className={isPaused ? "" : "animate-pulse"} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              {isPaused ? "Gravação em pausa" : "A gravar"}
            </span>
            <span
              className="font-mono text-sm tabular-nums"
              style={{ color: isPaused ? "var(--amber)" : "var(--red)" }}
            >
              {formatElapsed(elapsedMs)}
            </span>
          </div>
          <p className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
            {recordingLabel(target)}
            {draft?.titulo ? ` · ${draft.titulo}` : ""}
          </p>
          {error && (
            <p className="text-xs mt-0.5" style={{ color: "var(--red)" }}>{error}</p>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {supportsPause && (
            isPaused ? (
              <Button variant="secondary" size="sm" onClick={resume} title="Retomar">
                <Play size={14} />
                Retomar
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={pause} title="Pausar">
                <Pause size={14} />
                Pausar
              </Button>
            )
          )}
          <Button variant="danger" size="sm" onClick={stop} title="Terminar">
            <Square size={12} />
            Terminar
          </Button>
          <Link
            href={returnPath}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium hover:opacity-80"
            style={{ color: "var(--blue-primary)", border: "1px solid var(--border-strong)" }}
            title="Voltar à página da gravação"
          >
            <ExternalLink size={12} />
            Abrir
          </Link>
        </div>
      </div>
      <p className="px-4 pb-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
        Pode navegar na app normalmente. A gravação continua em segundo plano.
      </p>
    </div>
  );
}
