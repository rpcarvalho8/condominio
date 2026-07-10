import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getToken } from "../lib/auth";

const SYNC_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutos
const LS_KEY = "bank_last_sync_ts";

async function callBankEndpoint(path: string): Promise<{ ok: boolean; error?: string }> {
  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const res = await fetch(path, { method: "POST", headers });
    const body = await res.json().catch(() => ({} as any));
    if (!res.ok) {
      return { ok: false, error: (body as any).error ?? `HTTP ${res.status}` };
    }
    // A rota pode devolver 200 com ok:false ou syncErrors preenchido (falha parcial/total
    // da Enable Banking) — isto TEM de ser tratado como erro visível na UI.
    if ((body as any).ok === false || ((body as any).syncErrors?.length ?? 0) > 0) {
      const primeiroErro = (body as any).syncErrors?.[0] ?? "Erro desconhecido na sincronização";
      return { ok: false, error: (body as any).needsReconnect ? `Ligação bancária expirada — reconecta em Importar. (${primeiroErro})` : primeiroErro };
    }
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : "Erro de rede" };
  }
}

export interface BankSyncState {
  isSyncing: boolean;
  syncError: string | null;
  syncDone: boolean;
}

export function useBankSync(): BankSyncState {
  const qc = useQueryClient();
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncDone, setSyncDone] = useState(false);
  const didRun = useRef(false);

  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;

    const last = Number(localStorage.getItem(LS_KEY) ?? 0);
    if (Date.now() - last < SYNC_DEBOUNCE_MS) return; // dentro da janela de debounce

    (async () => {
      setIsSyncing(true);
      setSyncError(null);

      // 1. Sincronizar transações do banco
      const syncResult = await callBankEndpoint("/api/bank/sync");
      if (!syncResult.ok) {
        // Token expirado ou sem ligação — não é fatal, apenas avisa
        setIsSyncing(false);
        setSyncError(syncResult.error ?? "Erro ao sincronizar banco");
        return;
      }

      // 2. Processar staged (pode ser no-op se sync já processou)
      await callBankEndpoint("/api/bank/process-staged");

      // 3. Recalcular saldos persisted
      await fetch("/api/dashboard/recalcular", {
        method: "POST",
        headers: (() => {
          const token = getToken();
          const h: Record<string, string> = {};
          if (token) h["Authorization"] = `Bearer ${token}`;
          return h;
        })(),
      }).catch(() => {/* best-effort */});

      // 4. Invalidar cache do dashboard
      await qc.invalidateQueries({ queryKey: ["dashboard"] });

      // 5. Guardar timestamp para debounce
      localStorage.setItem(LS_KEY, String(Date.now()));

      setIsSyncing(false);
      setSyncDone(true);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { isSyncing, syncError, syncDone };
}
