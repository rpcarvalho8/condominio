import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IosPushSpikeNote } from "../components/PwaInstallPrompt";
import { authClient, clearToken, getToken } from "../lib/auth";
import { probeNetworkOnline } from "../lib/pwa";

type Debt = {
  obligationId: string;
  kind: string;
  periodYear: number;
  amountCents: number;
  allocatedCents: number;
  openCents: number;
  status: string;
};

type FractionBalance = {
  source: "ledger";
  fracaoId: string;
  fracaoCodigo: string;
  permilagem: number;
  originalCents: number;
  allocatedCents: number;
  openCents: number;
  debts: Debt[];
};

type PortalDocument = {
  id: string;
  docType: string;
  periodLabel: string | null;
  issuedAt: string;
  amountCents: number;
  documentNumber: string | null;
  generatedFrom: Record<string, unknown>;
};

function formatCents(cents: number) {
  return (cents / 100).toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

function docLabel(docType: string) {
  if (docType === "PaymentNotice") return "Aviso de Débito";
  if (docType === "Receipt") return "Recibo";
  if (docType === "AccountStatement") return "Extrato";
  return docType;
}

async function portalFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api/f3${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export default function F3PortalPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { data: session, isPending } = authClient.useSession();
  const [error, setError] = useState("");

  const saldo = useQuery({
    queryKey: ["f3-portal-saldo"],
    queryFn: () => portalFetch<{ source: "ledger"; fractions: FractionBalance[] }>("/portal/saldo"),
    enabled: Boolean(session),
  });
  const documents = useQuery({
    queryKey: ["f3-portal-docs"],
    queryFn: () => portalFetch<{ documents: PortalDocument[] }>("/portal/documents"),
    enabled: Boolean(session),
  });

  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [networkReady, setNetworkReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const apply = (value: boolean) => {
      if (!cancelled) setOnline(value);
    };
    const probe = () => {
      void probeNetworkOnline(fetch, navigator.onLine).then((value) => {
        apply(value);
        if (!cancelled) setNetworkReady(true);
      });
    };
    const on = () => probe();
    const off = () => {
      apply(false);
      if (!cancelled) setNetworkReady(true);
    };
    probe();
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      cancelled = true;
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    if (!networkReady || !online) return;
    if (!isPending && !session) navigate("/login");
  }, [isPending, session, navigate, online, networkReady]);

  const firstFracaoId = saldo.data?.fractions[0]?.fracaoId ?? null;
  const statement = useMutation({
    mutationFn: () =>
      portalFetch("/portal/documents/account-statement", {
        method: "POST",
        body: JSON.stringify({ fracaoId: firstFracaoId }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["f3-portal-docs"] }),
  });

  const openCents = useMemo(
    () => (saldo.data?.fractions ?? []).reduce((s, f) => s + f.openCents, 0),
    [saldo.data],
  );

  async function handleLogout() {
    await authClient.signOut();
    clearToken();
    navigate("/login");
  }

  async function downloadDoc(id: string, filename: string) {
    setError("");
    try {
      const token = getToken();
      const res = await fetch(`/api/f3/portal/documents/${id}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      qc.invalidateQueries({ queryKey: ["f3-activation"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível descarregar");
    }
  }

  if (!online) {
    return (
      <div className="min-h-screen" style={{ background: "#F5F5F7" }}>
        <header className="bg-white border-b" style={{ borderColor: "#E5E5EA" }}>
          <div className="max-w-3xl mx-auto px-4 py-4">
            <p className="text-xs uppercase tracking-wider" style={{ color: "#D0021B" }}>
              Portal do condómino
            </p>
            <h1 className="text-lg font-semibold">Sem ligação</h1>
          </div>
        </header>
        <main className="max-w-3xl mx-auto px-4 py-6 space-y-3">
          <section className="bg-white rounded-2xl border p-5" style={{ borderColor: "#E5E5EA" }}>
            <p className="text-sm text-neutral-600">
              A app está instalada. O saldo do Ledger e os documentos precisam de rede — não há
              cópia offline de dívidas.
            </p>
            <button
              type="button"
              className="mt-4 rounded-lg px-3 py-2 text-sm text-white"
              style={{ background: "#D0021B" }}
              onClick={() => window.location.reload()}
            >
              Tentar novamente
            </button>
          </section>
        </main>
      </div>
    );
  }

  if (!networkReady || isPending || (session && saldo.isLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#F5F5F7" }}>
        <p className="text-neutral-500">A carregar o portal…</p>
      </div>
    );
  }

  if (!session) {
    return null;
  }

  return (
    <div className="min-h-screen" style={{ background: "#F5F5F7" }}>
      <header className="bg-white border-b sticky top-0 z-10" style={{ borderColor: "#E5E5EA" }}>
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-wider" style={{ color: "#D0021B" }}>
              Portal do condómino
            </p>
            <h1 className="text-lg font-semibold">Saldo e documentos</h1>
          </div>
          <button type="button" onClick={handleLogout} className="text-sm text-neutral-500">
            Sair
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <section className="bg-white rounded-2xl border p-5" style={{ borderColor: "#E5E5EA" }}>
          <p className="text-sm text-neutral-500">Em aberto (Ledger)</p>
          <p className="text-3xl font-semibold mt-1" style={{ color: openCents > 0 ? "#D0021B" : "#111" }}>
            {formatCents(openCents)}
          </p>
          <p className="text-xs text-neutral-400 mt-2">Fonte: Ledger F2 — nunca Quota.pago.</p>
        </section>

        {(saldo.data?.fractions ?? []).map((fracao) => (
          <section key={fracao.fracaoId} className="bg-white rounded-2xl border p-5 space-y-3" style={{ borderColor: "#E5E5EA" }}>
            <div>
              <h2 className="font-semibold">Fração {fracao.fracaoCodigo}</h2>
              <p className="text-sm text-neutral-500">
                Permilagem {fracao.permilagem}‰ · Original {formatCents(fracao.originalCents)} ·
                Alocado {formatCents(fracao.allocatedCents)}
              </p>
            </div>
            {fracao.debts.filter((d) => d.openCents > 0).length === 0 ? (
              <p className="text-sm text-neutral-500">Sem dívidas em aberto.</p>
            ) : (
              <div className="space-y-2">
                {fracao.debts
                  .filter((d) => d.openCents > 0)
                  .map((d) => (
                    <div key={d.obligationId} className="flex justify-between text-sm border-t pt-2" style={{ borderColor: "#E5E5EA" }}>
                      <span>
                        {d.kind} · {d.periodYear}
                      </span>
                      <span className="font-medium">{formatCents(d.openCents)}</span>
                    </div>
                  ))}
              </div>
            )}
          </section>
        ))}

        <section className="bg-white rounded-2xl border p-5 space-y-3" style={{ borderColor: "#E5E5EA" }}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Documentos financeiros</h2>
            <button
              type="button"
              onClick={() => statement.mutate()}
              disabled={!firstFracaoId || statement.isPending}
              className="rounded-lg px-3 py-2 text-sm text-white"
              style={{ background: "#D0021B" }}
            >
              Pedir extrato
            </button>
          </div>
          {(documents.data?.documents ?? []).length === 0 ? (
            <p className="text-sm text-neutral-500">Ainda não há avisos, recibos ou extratos.</p>
          ) : (
            <div className="space-y-2">
              {(documents.data?.documents ?? []).map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between gap-3 border-t pt-3"
                  style={{ borderColor: "#E5E5EA" }}
                >
                  <div>
                    <p className="text-sm font-medium">
                      {docLabel(doc.docType)} · {doc.documentNumber ?? "—"}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {new Date(doc.issuedAt).toLocaleDateString("pt-PT")} · {formatCents(doc.amountCents)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="text-sm underline"
                    style={{ color: "#A80015" }}
                    onClick={() => downloadDoc(doc.id, `${doc.documentNumber ?? doc.id}.html`)}
                  >
                    Descarregar
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {(error || saldo.error || documents.error || statement.error) && (
          <p className="text-sm" style={{ color: "#D0021B" }}>
            {error ||
              (saldo.error as Error | undefined)?.message ||
              (documents.error as Error | undefined)?.message ||
              (statement.error as Error | undefined)?.message}
          </p>
        )}

        <IosPushSpikeNote />
      </main>
    </div>
  );
}
