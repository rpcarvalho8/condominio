import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { authClient, clearToken } from "../lib/auth";
import { api } from "../lib/api";

type PortalData = {
  fracao: {
    numero: string;
    andar: number | null;
    proprietarioNome: string | null;
    proprietarioEmail: string | null;
    proprietarioTelefone: string | null;
    quotaMensal: number;
    permilagem: number | null;
  };
  quotas: Array<{
    id: string;
    mes: number;
    ano: number;
    valor: number;
    tipo: string;
    pago: boolean;
    dataPagamento: string | null;
    metodoPagamento: string | null;
    observacoes: string | null;
  }>;
  recibos: Array<{
    id: string;
    numeroRecibo: string | null;
    valor: number;
    pdfUrl: string | null;
    createdAt: string;
  }>;
  resumo: {
    totalDívida: number;
    totalPago: number;
    quotasPendentes: number;
    quotasPagas: number;
  };
};

type AtaPortal = {
  id: string;
  titulo: string;
  dataReuniao: string;
  status: "aprovada" | "rejeitada" | "aguardando_votos" | "pdf_definitiva" | "rascunho" | "em_revisao";
  ataTexto: string;
  resumoDeliberacoes: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  pdfUrl: string | null;
  pdfFinalizedAt: string | null;
  approvalDeadlineAt: string | null;
  audioAvailableUntil: string | null;
  userVote: "approve" | "reject" | null;
  userVotedAt: string | null;
};

const MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function formatEur(v: number) {
  return v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

function tipoLabel(tipo: string) {
  const map: Record<string, string> = {
    condominio: "Condomínio",
    obras: "Obras",
    extra: "Extra",
    fundo_reserva: "Fundo Reserva",
  };
  return map[tipo] ?? tipo;
}

function AtaAudioPlayer({
  ataId,
  canPlay,
  token,
}: {
  ataId: string;
  canPlay: boolean;
  token: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!canPlay) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/atas/${ataId}/audio`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      setLoading(false);
    };
  }, [ataId, canPlay, token]);

  return (
    <div className="mt-3">
      {loading && <p className="text-xs text-gray-500">A carregar áudio...</p>}
      {src ? <audio controls src={src} className="w-full" /> : !loading && canPlay ? <p className="text-xs text-gray-500">Áudio indisponível.</p> : null}
    </div>
  );
}

export default function PortalPage() {
  const [, navigate] = useLocation();
  const { data: session, isPending } = authClient.useSession();
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"quotas" | "recibos" | "atas">("quotas");
  const [anoFiltro, setAnoFiltro] = useState(new Date().getFullYear());
  const [atas, setAtas] = useState<AtaPortal[]>([]);
  const token = localStorage.getItem("bm_token") ?? "";

  useEffect(() => {
    if (isPending) return;
    if (!session) { navigate("/login"); return; }
    const user = session.user as any;
    // Admins don't use portal — go to dashboard
    if (user?.role === "admin") { navigate("/"); return; }
    loadData();
  }, [session, isPending]);

  async function loadData() {
    try {
      const headers = {
        Authorization: `Bearer ${localStorage.getItem("bm_token") ?? ""}`,
      };
      const [resFracao, resAtas] = await Promise.all([
        fetch("/api/portal/minha-fracao", { headers }),
        fetch("/api/atas", { headers }),
      ]);
      if (resFracao.ok) {
        const d = await resFracao.json();
        setData(d);
      }
      if (resAtas.ok) {
        const listaAtas = await resAtas.json() as AtaPortal[];
        setAtas(listaAtas);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    await authClient.signOut();
    clearToken();
    navigate("/login");
  }

  async function submitAtaVote(ataId: string, vote: "approve" | "reject") {
    const res = await fetch(`/api/atas/${ataId}/votes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ vote }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message ?? "Erro ao submeter voto.");
    }
    await loadData();
  }

  if (isPending || loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400">A carregar...</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <h1 className="text-white text-lg font-semibold mb-2">
            Olá{session?.user?.name ? `, ${session.user.name}` : ""}
          </h1>
          <p className="text-gray-400 mb-2">A sua conta está ativa, mas ainda não tem fração associada.</p>
          <p className="text-gray-600 text-sm">Peça ao administrador do condomínio para ligar a sua fração à conta.</p>
          <button onClick={handleLogout} className="mt-6 text-blue-400 hover:underline text-sm">
            Sair
          </button>
        </div>
      </div>
    );
  }

  const quotasDoAno = data.quotas.filter(q => q.ano === anoFiltro);
  const anos = [...new Set(data.quotas.map(q => q.ano))].sort((a, b) => b - a);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <div>
              <p className="font-semibold text-sm">Gestão Condomínio</p>
              <p className="text-gray-500 text-xs">Fração {data.fracao.numero}</p>
            </div>
          </div>
          <button onClick={handleLogout} className="text-gray-400 hover:text-white text-sm transition">
            Sair
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {/* Welcome + Info */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <h1 className="text-xl font-semibold mb-1">
            Olá, {data.fracao.proprietarioNome ?? session?.user?.name}
          </h1>
          <p className="text-gray-400 text-sm">Fração {data.fracao.numero} · Permilagem: {data.fracao.permilagem?.toFixed(1) ?? "—"}‰</p>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            {data.fracao.proprietarioEmail && (
              <div>
                <span className="text-gray-500">Email</span>
                <p className="text-gray-200">{data.fracao.proprietarioEmail}</p>
              </div>
            )}
            {data.fracao.proprietarioTelefone && (
              <div>
                <span className="text-gray-500">Telefone</span>
                <p className="text-gray-200">{data.fracao.proprietarioTelefone}</p>
              </div>
            )}
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-1">Quota Mensal</p>
            <p className="text-lg font-bold text-white">{formatEur(data.fracao.quotaMensal)}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-1">Em Dívida</p>
            <p className={`text-lg font-bold ${data.resumo.totalDívida > 0 ? "text-red-400" : "text-green-400"}`}>
              {formatEur(data.resumo.totalDívida)}
            </p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-1">Total Pago</p>
            <p className="text-lg font-bold text-green-400">{formatEur(data.resumo.totalPago)}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-1">Pendentes</p>
            <p className={`text-lg font-bold ${data.resumo.quotasPendentes > 0 ? "text-amber-400" : "text-gray-400"}`}>
              {data.resumo.quotasPendentes}
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="flex border-b border-gray-800">
            <button
              onClick={() => setTab("quotas")}
              className={`flex-1 py-3 text-sm font-medium transition ${tab === "quotas" ? "text-white border-b-2 border-blue-500" : "text-gray-500 hover:text-gray-300"}`}
            >
              Quotas
            </button>
            <button
              onClick={() => setTab("recibos")}
              className={`flex-1 py-3 text-sm font-medium transition ${tab === "recibos" ? "text-white border-b-2 border-blue-500" : "text-gray-500 hover:text-gray-300"}`}
            >
              Recibos
            </button>
            <button
              onClick={() => setTab("atas")}
              className={`flex-1 py-3 text-sm font-medium transition ${tab === "atas" ? "text-white border-b-2 border-blue-500" : "text-gray-500 hover:text-gray-300"}`}
            >
              Atas
            </button>
          </div>

          {tab === "quotas" && (
            <div className="p-4">
              {/* Year filter */}
              <div className="flex items-center gap-2 mb-4">
                <span className="text-gray-500 text-sm">Ano:</span>
                <div className="flex gap-1">
                  {anos.map(ano => (
                    <button
                      key={ano}
                      onClick={() => setAnoFiltro(ano)}
                      className={`px-3 py-1 rounded-lg text-sm transition ${anoFiltro === ano ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`}
                    >
                      {ano}
                    </button>
                  ))}
                </div>
              </div>

              {/* Quotas grid */}
              <div className="space-y-2">
                {quotasDoAno.length === 0 ? (
                  <p className="text-gray-500 text-sm text-center py-6">Sem quotas para {anoFiltro}</p>
                ) : (
                  quotasDoAno.map(q => (
                    <div key={q.id} className="flex items-center justify-between py-3 border-b border-gray-800 last:border-0">
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${q.pago ? "bg-green-400" : "bg-amber-400"}`} />
                        <div>
                          <p className="text-sm font-medium">{MESES[q.mes - 1]} {q.ano}</p>
                          <p className="text-xs text-gray-500">{tipoLabel(q.tipo)}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-semibold ${q.pago ? "text-green-400" : "text-amber-400"}`}>
                          {formatEur(q.valor)}
                        </p>
                        {q.pago && q.dataPagamento && (
                          <p className="text-xs text-gray-500">
                            Pago em {new Date(q.dataPagamento).toLocaleDateString("pt-PT")}
                          </p>
                        )}
                        {!q.pago && (
                          <p className="text-xs text-amber-500/70">Pendente</p>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {tab === "recibos" && (
            <div className="p-4">
              {data.recibos.length === 0 ? (
                <p className="text-gray-500 text-sm text-center py-6">Sem recibos emitidos</p>
              ) : (
                <div className="space-y-2">
                  {data.recibos.map(r => (
                    <div key={r.id} className="flex items-center justify-between py-3 border-b border-gray-800 last:border-0">
                      <div>
                        <p className="text-sm font-medium">{r.numeroRecibo ?? "—"}</p>
                        <p className="text-xs text-gray-500">
                          {new Date(r.createdAt).toLocaleDateString("pt-PT")}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <p className="text-sm font-semibold text-green-400">{formatEur(r.valor)}</p>
                        {r.pdfUrl && (
                          <a href={r.pdfUrl} target="_blank" rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 transition">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "atas" && (
            <div className="p-4">
              {atas.length === 0 ? (
                <p className="text-gray-500 text-sm text-center py-6">Sem atas publicadas ainda.</p>
              ) : (
                <div className="space-y-4">
                  {atas.map((ata) => (
                    <div key={ata.id} className="rounded-xl border border-gray-800 p-4 bg-gray-950/50">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="text-sm font-semibold">{ata.titulo}</h3>
                          <span className="text-xs text-gray-500">
                            {new Date(ata.dataReuniao).toLocaleDateString("pt-PT")}
                          </span>
                        </div>
                        <span className="text-xs text-gray-500">{ata.status}</span>
                      </div>
                      {ata.resumoDeliberacoes && (
                        <p className="text-xs text-gray-400 mt-2 whitespace-pre-wrap">{ata.resumoDeliberacoes}</p>
                      )}

                      {ata.pdfUrl && (
                        <div className="mt-3">
                          <a
                            href={ata.pdfUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 transition text-sm"
                          >
                            Abrir PDF definitivo
                          </a>
                        </div>
                      )}

                      {ata.status === "aguardando_votos" && ata.approvalDeadlineAt && (
                        <div className="mt-3">
                          <p className="text-xs text-amber-300">
                            Votação termina em{" "}
                            {Math.max(0, Math.ceil((new Date(ata.approvalDeadlineAt).getTime() - Date.now()) / 60000))} min
                          </p>

                          <div className="flex flex-wrap gap-2 mt-2">
                            <button
                              className="px-3 py-1.5 rounded-md text-sm"
                              style={{
                                background: ata.userVote === "approve" ? "var(--green-subtle)" : "var(--blue-primary)",
                                color: ata.userVote === "approve" ? "var(--green)" : "white",
                                border: "1px solid var(--border-strong)",
                                cursor: ata.userVote === "approve" ? "not-allowed" : "pointer",
                              }}
                              disabled={
                                ata.userVote === "approve" ||
                                new Date(ata.approvalDeadlineAt).getTime() < Date.now()
                              }
                              onClick={() => submitAtaVote(ata.id, "approve")}
                            >
                              Aprovar
                            </button>
                            <button
                              className="px-3 py-1.5 rounded-md text-sm"
                              style={{
                                background: ata.userVote === "reject" ? "var(--red-subtle)" : "var(--bg-secondary)",
                                color: ata.userVote === "reject" ? "var(--red)" : "var(--text-primary)",
                                border: "1px solid var(--border-strong)",
                                cursor: ata.userVote === "reject" ? "not-allowed" : "pointer",
                              }}
                              disabled={
                                ata.userVote === "reject" ||
                                new Date(ata.approvalDeadlineAt).getTime() < Date.now()
                              }
                              onClick={() => submitAtaVote(ata.id, "reject")}
                            >
                              Rejeitar
                            </button>
                          </div>

                          <AtaAudioPlayer
                            ataId={ata.id}
                            token={token}
                            canPlay={ata.status === "aguardando_votos"}
                          />
                        </div>
                      )}

                      {ata.status === "aprovada" && (
                        <p className="mt-3 text-xs text-green-300">Aprovada e publicada.</p>
                      )}
                      {ata.status === "rejeitada" && (
                        <p className="mt-3 text-xs text-red-300">Rejeitada.</p>
                      )}

                      <pre className="mt-3 text-xs text-gray-200 whitespace-pre-wrap font-sans leading-relaxed">
                        {ata.ataTexto}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Note */}
        <p className="text-center text-gray-600 text-xs">
          Para questões sobre pagamentos contacte a administração do condomínio.
        </p>
      </main>
    </div>
  );
}
