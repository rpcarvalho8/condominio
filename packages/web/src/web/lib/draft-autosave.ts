/**
 * Rascunhos locais (localStorage) com debounce — atas / notas de reunião.
 * Limpar apenas após POST/PUT bem-sucedido no backend.
 */

const PREFIX = "condominio:draft:";

export type DraftMeta = {
  savedAt: number;
  key: string;
};

export function draftStorageKey(scope: string): string {
  return `${PREFIX}${scope}`;
}

export function loadDraft<T>(scope: string): { data: T; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(draftStorageKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: T; savedAt: number };
    if (!parsed || typeof parsed.savedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveDraft<T>(scope: string, data: T): number {
  const savedAt = Date.now();
  localStorage.setItem(draftStorageKey(scope), JSON.stringify({ data, savedAt }));
  return savedAt;
}

export function clearDraft(scope: string): void {
  try {
    localStorage.removeItem(draftStorageKey(scope));
  } catch {
    /* ignore */
  }
}

export function formatDraftTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}
