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

type TicketPortal = {
  id: string;
  titulo: string;
  descricao: string;
  categoria: string;
  urgencia: string;
  status: string;
  llmResumo: string | null;
  createdAt: string;
  updatedAt: string;
  messages?: Array<{
    id: string;
    authorRole: string;
    body: string;
    createdAt: string;
    authorName: string | null;
  }>;
  attachments?: Array<{
    id: string;
    kind: string;
    originalName: string;
    url: string;
  }>;
};

const MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

const TICKET_STATUS: Record<string, string> = {
  aberto: "Aberto",
  em_curso: "Em curso",
  aguarda_condomino: "Aguarda a sua resposta",
  resolvido: "Resolvido",
  cancelado: "Cancelado",
};

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

/** Botões com área de toque confortável em mobile */
const BTN =
  "rounded-lg font-medium transition disabled:opacity-40 py-3 px-4 text-base md:py-2 md:px-3 md:text-sm";
const BTN_TAB =
  "flex-1 py-3 px-2 text-base font-medium transition md:py-3 md:text-sm min-h-[44px]";

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
      {loading && <p className="text-sm md:text-xs text-gray-500">A carregar áudio...</p>}
      {src ? <audio controls src={src} className="w-full" /> : !loading && canPlay ? <p className="text-sm md:text-xs text-gray-500">Áudio indisponível.</p> : null}
    </div>
  );
}

export default function PortalPage() {
  const [, navigate] = useLocation();
  const { data: session, isPending } = authClient.useSession();
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"quotas" | "recibos" | "atas" | "pedidos">("quotas");
  const [anoFiltro, setAnoFiltro] = useState(new Date().getFullYear());
  const [atas, setAtas] = useState<AtaPortal[]>([]);
  const [tickets, setTickets] = useState<TicketPortal[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState("");
  const [ticketDetail, setTicketDetail] = useState<TicketPortal | null>(null);
  const [novoTitulo, setNovoTitulo] = useState("");
  const [novaDescricao, setNovaDescricao] = useState("");
  const [novosAnexos, setNovosAnexos] = useState<FileList | null>(null);
  const [ticketReply, setTicketReply] = useState("");
  const [ticketReplyFiles, setTicketReplyFiles] = useState<FileList | null>(null);
  const [ticketMsg, setTicketMsg] = useState("");
  const [ticketBusy, setTicketBusy] = useState(false);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
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
      const [resFracao, resAtas, resTickets] = await Promise.all([
        fetch("/api/portal/minha-fracao", { headers }),
        fetch("/api/atas", { headers }),
        fetch("/api/tickets", { headers }),
      ]);
      if (resFracao.ok) {
        const d = await resFracao.json();
        setData(d);
      }
      if (resAtas.ok) {
        const listaAtas = await resAtas.json() as AtaPortal[];
        setAtas(listaAtas);
      }
      if (resTickets.ok) {
        setTickets(await resTickets.json());
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadTicketDetail(id: string) {
    setSelectedTicketId(id);
    const res = await fetch(`/api/tickets/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const detail = await res.json() as TicketPortal & {
        attachments?: Array<{ id: string; kind: string; originalName: string; url: string }>;
      };
      setTicketDetail(detail);
      // Carregar anexos com token (img/video não enviam Authorization)
      for (const a of detail.attachments ?? []) {
        if (mediaUrls[a.id]) continue;
        try {
          const fr = await fetch(a.url, { headers: { Authorization: `Bearer ${token}` } });
          if (!fr.ok) continue;
          const blob = await fr.blob();
          const objectUrl = URL.createObjectURL(blob);
          setMediaUrls((prev) => ({ ...prev, [a.id]: objectUrl }));
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function createTicket() {
    setTicketBusy(true);
    setTicketMsg("");
    try {
      const form = new FormData();
      form.append("titulo", novoTitulo);
      form.append("descricao", novaDescricao);
      if (novosAnexos) {
        Array.from(novosAnexos).slice(0, 5).forEach((f) => form.append("files", f));
      }
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message ?? "Erro ao criar pedido.");
      setNovoTitulo("");
      setNovaDescricao("");
      setNovosAnexos(null);
      setTicketMsg(
        body.emailConfirmacao
          ? `Pedido criado. Confirmação enviada para ${body.emailConfirmacao}.`
          : "Pedido criado. Sem email na fração — confirmação não enviada (verifique proprietario_email).",
      );
      await loadData();
      await loadTicketDetail(body.id);
    } catch (e: any) {
      setTicketMsg(e.message ?? "Erro ao criar pedido.");
    } finally {
      setTicketBusy(false);
    }
  }

  async function sendTicketReply() {
    if (!selectedTicketId || (!ticketReply.trim() && !ticketReplyFiles?.length)) return;
    setTicketBusy(true);
    try {
      const form = new FormData();
      form.append("body", ticketReply);
      if (ticketReplyFiles) {
        Array.from(ticketReplyFiles).slice(0, 5).forEach((f) => form.append("files", f));
      }
      const res = await fetch(`/api/tickets/${selectedTicketId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message ?? "Erro ao enviar mensagem.");
      setTicketReply("");
      setTicketReplyFiles(null);
      await loadTicketDetail(selectedTicketId);
      await loadData();
    } catch (e: any) {
      setTicketMsg(e.message ?? "Erro ao enviar.");
    } finally {
      setTicketBusy(false);
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
          <p className="text-gray-600 text-base md:text-sm">Peça ao administrador do condomínio para ligar a sua fração à conta.</p>
          <button onClick={handleLogout} className={`mt-6 text-blue-400 hover:underline ${BTN} bg-transparent text-blue-400`}>
            Sair
          </button>
        </div>
      </div>
    );
  }

  const quotasDoAno = data.quotas.filter(q => q.ano === anoFiltro);
  const anos = [...new Set(data.quotas.map(q => q.ano))].sort((a, b) => b - a);

  return (
    <div className="min-h-screen bg-gray-950 text-white text-base md:text-sm">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 md:w-8 md:h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
            </div>
            <div>
              <p className="font-semibold text-base md:text-sm">Gestão Condomínio</p>
              <p className="text-gray-500 text-sm md:text-xs">Fração {data.fracao.numero}</p>
            </div>
          </div>
          <button onClick={handleLogout} className={`self-start sm:self-auto text-gray-400 hover:text-white ${BTN} bg-transparent !py-2 !px-3`}>
            Sair
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 md:py-8 space-y-6">
        {/* Welcome + Info */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 md:p-6">
          <h1 className="text-xl md:text-xl font-semibold mb-1">
            Olá, {data.fracao.proprietarioNome ?? session?.user?.name}
          </h1>
          <p className="text-gray-400 text-base md:text-sm">Fração {data.fracao.numero} · Permilagem: {data.fracao.permilagem?.toFixed(1) ?? "—"}‰</p>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 md:gap-3 text-base md:text-sm">
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 md:p-4">
            <p className="text-gray-500 text-sm md:text-xs uppercase tracking-wider mb-1">Quota Mensal</p>
            <p className="text-xl md:text-lg font-bold text-white">{formatEur(data.fracao.quotaMensal)}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 md:p-4">
            <p className="text-gray-500 text-sm md:text-xs uppercase tracking-wider mb-1">Em Dívida</p>
            <p className={`text-xl md:text-lg font-bold ${data.resumo.totalDívida > 0 ? "text-red-400" : "text-green-400"}`}>
              {formatEur(data.resumo.totalDívida)}
            </p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 md:p-4">
            <p className="text-gray-500 text-sm md:text-xs uppercase tracking-wider mb-1">Total Pago</p>
            <p className="text-xl md:text-lg font-bold text-green-400">{formatEur(data.resumo.totalPago)}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 md:p-4">
            <p className="text-gray-500 text-sm md:text-xs uppercase tracking-wider mb-1">Pendentes</p>
            <p className={`text-xl md:text-lg font-bold ${data.resumo.quotasPendentes > 0 ? "text-amber-400" : "text-gray-400"}`}>
              {data.resumo.quotasPendentes}
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="flex flex-col sm:flex-row border-b border-gray-800">
            <button
              onClick={() => setTab("quotas")}
              className={`${BTN_TAB} ${tab === "quotas" ? "text-white border-b-2 border-blue-500 bg-gray-950/50 sm:bg-transparent" : "text-gray-500 hover:text-gray-300"}`}
            >
              Quotas
            </button>
            <button
              onClick={() => setTab("recibos")}
              className={`${BTN_TAB} ${tab === "recibos" ? "text-white border-b-2 border-blue-500 bg-gray-950/50 sm:bg-transparent" : "text-gray-500 hover:text-gray-300"}`}
            >
              Recibos
            </button>
            <button
              onClick={() => setTab("atas")}
              className={`${BTN_TAB} ${tab === "atas" ? "text-white border-b-2 border-blue-500 bg-gray-950/50 sm:bg-transparent" : "text-gray-500 hover:text-gray-300"}`}
            >
              Atas
            </button>
            <button
              onClick={() => setTab("pedidos")}
              className={`${BTN_TAB} ${tab === "pedidos" ? "text-white border-b-2 border-blue-500 bg-gray-950/50 sm:bg-transparent" : "text-gray-500 hover:text-gray-300"}`}
            >
              Pedidos
            </button>
          </div>

          {tab === "quotas" && (
            <div className="p-4 md:p-4">
              {/* Year filter */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center mb-4">
                <span className="text-gray-500 text-base md:text-sm">Ano:</span>
                <div className="flex flex-wrap gap-2">
                  {anos.map(ano => (
                    <button
                      key={ano}
                      onClick={() => setAnoFiltro(ano)}
                      className={`${BTN} ${anoFiltro === ano ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`}
                    >
                      {ano}
                    </button>
                  ))}
                </div>
              </div>

              {/* Quotas — cards empilhados em mobile */}
              <div className="space-y-3 md:space-y-2">
                {quotasDoAno.length === 0 ? (
                  <p className="text-gray-500 text-base md:text-sm text-center py-6">Sem quotas para {anoFiltro}</p>
                ) : (
                  quotasDoAno.map(q => (
                    <div
                      key={q.id}
                      className="rounded-xl border border-gray-800 bg-gray-950/40 p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:py-3 md:px-0 md:border-0 md:border-b md:border-gray-800 md:rounded-none md:bg-transparent md:last:border-0"
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-3 h-3 md:w-2 md:h-2 rounded-full shrink-0 ${q.pago ? "bg-green-400" : "bg-amber-400"}`} />
                        <div>
                          <p className="text-base md:text-sm font-medium">{MESES[q.mes - 1]} {q.ano}</p>
                          <p className="text-sm md:text-xs text-gray-500">{tipoLabel(q.tipo)}</p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3 md:block md:text-right pl-6 md:pl-0">
                        <p className={`text-lg md:text-sm font-semibold ${q.pago ? "text-green-400" : "text-amber-400"}`}>
                          {formatEur(q.valor)}
                        </p>
                        {q.pago && q.dataPagamento && (
                          <p className="text-sm md:text-xs text-gray-500">
                            Pago em {new Date(q.dataPagamento).toLocaleDateString("pt-PT")}
                          </p>
                        )}
                        {!q.pago && (
                          <p className="text-sm md:text-xs text-amber-500/70">Pendente</p>
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
                <p className="text-gray-500 text-base md:text-sm text-center py-6">Sem recibos emitidos</p>
              ) : (
                <div className="space-y-3 md:space-y-2">
                  {data.recibos.map(r => (
                    <div
                      key={r.id}
                      className="rounded-xl border border-gray-800 bg-gray-950/40 p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:py-3 md:px-0 md:border-0 md:border-b md:border-gray-800 md:rounded-none md:bg-transparent md:last:border-0"
                    >
                      <div>
                        <p className="text-base md:text-sm font-medium">{r.numeroRecibo ?? "—"}</p>
                        <p className="text-sm md:text-xs text-gray-500">
                          {new Date(r.createdAt).toLocaleDateString("pt-PT")}
                        </p>
                      </div>
                      <div className="flex items-center justify-between gap-3 md:justify-end">
                        <p className="text-lg md:text-sm font-semibold text-green-400">{formatEur(r.valor)}</p>
                        {r.pdfUrl && (
                          <a
                            href={r.pdfUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`inline-flex items-center gap-2 text-blue-400 hover:text-blue-300 ${BTN} bg-blue-600/10 !py-2`}
                          >
                            <svg className="w-5 h-5 md:w-4 md:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            PDF
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
                <p className="text-gray-500 text-base md:text-sm text-center py-6">Sem atas publicadas ainda.</p>
              ) : (
                <div className="space-y-4">
                  {atas.map((ata) => (
                    <div key={ata.id} className="rounded-xl border border-gray-800 p-4 md:p-4 bg-gray-950/50">
                      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                        <div>
                          <h3 className="text-base md:text-sm font-semibold">{ata.titulo}</h3>
                          <span className="text-sm md:text-xs text-gray-500">
                            {new Date(ata.dataReuniao).toLocaleDateString("pt-PT")}
                          </span>
                        </div>
                        <span className="text-sm md:text-xs text-gray-500 self-start">{ata.status}</span>
                      </div>
                      {ata.resumoDeliberacoes && (
                        <p className="text-sm md:text-xs text-gray-400 mt-2 whitespace-pre-wrap">{ata.resumoDeliberacoes}</p>
                      )}

                      {ata.pdfUrl && (
                        <div className="mt-3">
                          <a
                            href={ata.pdfUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`inline-block text-blue-400 hover:text-blue-300 ${BTN} bg-transparent !px-0 !py-2 text-base md:text-sm`}
                          >
                            Abrir PDF definitivo
                          </a>
                        </div>
                      )}

                      {ata.status === "aguardando_votos" && ata.approvalDeadlineAt && (
                        <div className="mt-3">
                          <p className="text-sm md:text-xs text-amber-300">
                            Votação termina em{" "}
                            {Math.max(0, Math.ceil((new Date(ata.approvalDeadlineAt).getTime() - Date.now()) / 60000))} min
                          </p>

                          <div className="flex flex-col sm:flex-row flex-wrap gap-2 mt-2">
                            <button
                              className={`${BTN} md:py-1.5 md:px-3`}
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
                              className={`${BTN} md:py-1.5 md:px-3`}
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
                        <p className="mt-3 text-sm md:text-xs text-green-300">Aprovada e publicada.</p>
                      )}
                      {ata.status === "rejeitada" && (
                        <p className="mt-3 text-sm md:text-xs text-red-300">Rejeitada.</p>
                      )}

                      <pre className="mt-3 text-sm md:text-xs text-gray-200 whitespace-pre-wrap font-sans leading-relaxed">
                        {ata.ataTexto}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "pedidos" && (
            <div className="p-4 space-y-6">
              <div className="rounded-xl border border-gray-800 p-4 bg-gray-950/40 space-y-3">
                <h3 className="text-base md:text-sm font-semibold">Novo pedido</h3>
                <p className="text-sm md:text-xs text-gray-500">
                  Ex.: lâmpada fundida, elevador, barulho, dúvida sobre quotas.
                </p>
                <input
                  className="w-full rounded-lg bg-gray-900 border border-gray-700 px-4 py-3 md:px-3 md:py-2 text-base md:text-sm"
                  placeholder="Título"
                  value={novoTitulo}
                  onChange={(e) => setNovoTitulo(e.target.value)}
                />
                <textarea
                  className="w-full rounded-lg bg-gray-900 border border-gray-700 px-4 py-3 md:px-3 md:py-2 text-base md:text-sm min-h-[120px] md:min-h-[90px]"
                  placeholder="Descreva o pedido com o máximo de detalhe possível"
                  value={novaDescricao}
                  onChange={(e) => setNovaDescricao(e.target.value)}
                />
                <label className="block text-sm md:text-xs text-gray-500">
                  Anexos opcionais (imagens ou vídeos, máx. 5)
                  <input
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    className="mt-2 block w-full text-sm md:text-xs text-gray-400 py-2"
                    onChange={(e) => setNovosAnexos(e.target.files)}
                  />
                </label>
                <button
                  className={`w-full sm:w-auto ${BTN} bg-blue-600 text-white`}
                  disabled={ticketBusy || !novoTitulo.trim() || !novaDescricao.trim()}
                  onClick={createTicket}
                >
                  {ticketBusy ? "A enviar…" : "Enviar pedido"}
                </button>
                {ticketMsg && <p className="text-sm md:text-xs text-amber-300">{ticketMsg}</p>}
              </div>

              <div className="space-y-2">
                <h3 className="text-base md:text-sm font-semibold">Os seus pedidos</h3>
                {tickets.length === 0 ? (
                  <p className="text-gray-500 text-base md:text-sm text-center py-4">Ainda não tem pedidos.</p>
                ) : (
                  tickets.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => loadTicketDetail(t.id)}
                      className={`w-full text-left rounded-xl border p-4 md:p-3 min-h-[44px] ${selectedTicketId === t.id ? "border-blue-500 bg-gray-950" : "border-gray-800 bg-gray-950/40"}`}
                    >
                      <div className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-2">
                        <span className="text-base md:text-sm font-medium">{t.titulo}</span>
                        <span className="text-sm md:text-xs text-gray-500">{TICKET_STATUS[t.status] ?? t.status}</span>
                      </div>
                      <p className="text-sm md:text-xs text-gray-500 mt-1">
                        {new Date(t.updatedAt).toLocaleString("pt-PT")} · {t.categoria} · {t.urgencia}
                      </p>
                    </button>
                  ))
                )}
              </div>

              {ticketDetail && (
                <div className="rounded-xl border border-gray-800 p-4 bg-gray-950/50 space-y-3">
                  <h3 className="text-base md:text-sm font-semibold">{ticketDetail.titulo}</h3>
                  {ticketDetail.llmResumo && (
                    <p className="text-sm md:text-xs text-gray-400">{ticketDetail.llmResumo}</p>
                  )}
                  {(ticketDetail.attachments?.length ?? 0) > 0 && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {ticketDetail.attachments!.map((a) => (
                        <div key={a.id} className="rounded-lg border border-gray-800 p-2">
                          {mediaUrls[a.id] ? (
                            a.kind === "image" ? (
                              <img src={mediaUrls[a.id]} alt={a.originalName} className="w-full max-h-48 object-cover rounded" />
                            ) : (
                              <video src={mediaUrls[a.id]} controls className="w-full max-h-48 rounded" />
                            )
                          ) : (
                            <p className="text-xs text-gray-500">A carregar {a.originalName}…</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {(ticketDetail.messages ?? []).map((m) => (
                      <div key={m.id} className="text-base md:text-sm border-b border-gray-800 pb-2">
                        <p className="text-sm md:text-xs text-gray-500">
                          {m.authorRole === "system" ? "Sistema" : m.authorName ?? m.authorRole}
                          {" · "}
                          {new Date(m.createdAt).toLocaleString("pt-PT")}
                        </p>
                        <p className="text-gray-200 whitespace-pre-wrap">{m.body}</p>
                      </div>
                    ))}
                  </div>
                  {!["resolvido", "cancelado"].includes(ticketDetail.status) && (
                    <div className="space-y-2">
                      <textarea
                        className="w-full rounded-lg bg-gray-900 border border-gray-700 px-4 py-3 md:px-3 md:py-2 text-base md:text-sm min-h-[100px] md:min-h-[70px]"
                        placeholder="Escrever mensagem…"
                        value={ticketReply}
                        onChange={(e) => setTicketReply(e.target.value)}
                      />
                      <input
                        type="file"
                        accept="image/*,video/*"
                        multiple
                        className="block w-full text-sm md:text-xs text-gray-400 py-2"
                        onChange={(e) => setTicketReplyFiles(e.target.files)}
                      />
                      <button
                        className={`w-full sm:w-auto ${BTN} bg-blue-600 text-white`}
                        disabled={ticketBusy || (!ticketReply.trim() && !ticketReplyFiles?.length)}
                        onClick={sendTicketReply}
                      >
                        Enviar mensagem
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Note */}
        <p className="text-center text-gray-600 text-sm md:text-xs px-2">
          Para questões sobre pagamentos contacte a administração do condomínio — ou use a aba Pedidos.
        </p>
      </main>
    </div>
  );
}
