import { useEffect, useRef, useState } from "react";
import { clearDraft, formatDraftTime, loadDraft, saveDraft } from "../lib/draft-autosave";

/**
 * Autosave com debounce 2s. Restaura rascunho na montagem / mudança de scope.
 * clear() só após sucesso no servidor.
 */
export function useDraftAutosave<T>(opts: {
  scope: string | null;
  value: T;
  enabled?: boolean;
  /** true se o valor actual já veio do servidor (não sobrescrever com draft vazio) */
  isServerHydrated?: boolean;
  onRestore?: (data: T) => void;
  debounceMs?: number;
  /** Evita restaurar se o draft for igual ao valor inicial do servidor */
  isEmpty?: (data: T) => boolean;
}) {
  const {
    scope,
    value,
    enabled = true,
    isServerHydrated = true,
    onRestore,
    debounceMs = 2_000,
    isEmpty,
  } = opts;

  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [restored, setRestored] = useState(false);
  const restoredScopeRef = useRef<string | null>(null);
  const skipNextSaveRef = useRef(false);
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;

  // Restaurar ao abrir scope
  useEffect(() => {
    if (!scope || !enabled) {
      setRestored(false);
      setSavedAt(null);
      restoredScopeRef.current = null;
      return;
    }
    if (restoredScopeRef.current === scope) return;
    restoredScopeRef.current = scope;

    const draft = loadDraft<T>(scope);
    if (!draft) {
      setRestored(false);
      setSavedAt(null);
      return;
    }
    if (isEmpty?.(draft.data)) {
      setRestored(false);
      setSavedAt(null);
      return;
    }
    skipNextSaveRef.current = true;
    onRestoreRef.current?.(draft.data);
    setSavedAt(draft.savedAt);
    setRestored(true);
  }, [scope, enabled, isEmpty]);

  // Debounced save
  useEffect(() => {
    if (!scope || !enabled || !isServerHydrated) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    if (isEmpty?.(value)) return;

    const t = setTimeout(() => {
      try {
        const at = saveDraft(scope, value);
        setSavedAt(at);
      } catch (e) {
        console.warn("[draft-autosave] falha ao guardar:", e);
      }
    }, debounceMs);
    return () => clearTimeout(t);
  }, [scope, value, enabled, isServerHydrated, debounceMs, isEmpty]);

  const clear = () => {
    if (scope) clearDraft(scope);
    setSavedAt(null);
    setRestored(false);
    restoredScopeRef.current = null;
  };

  const statusLabel =
    restored && savedAt
      ? `Rascunho restaurado · Guardado às ${formatDraftTime(savedAt)}`
      : savedAt
        ? `Guardado localmente às ${formatDraftTime(savedAt)}`
        : null;

  return { savedAt, restored, statusLabel, clear };
}
