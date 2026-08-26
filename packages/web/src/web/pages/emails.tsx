import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, RefreshCw } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Button } from "../components/ui/Button";
import { Textarea } from "../components/ui/Input";
import { getToken } from "../lib/auth";

type EmailListItem = {
  id: string;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  status: string;
  llmResumo: string | null;
  gmailLabel: string | null;
  fracaoNumero: string | null;
  ticketId: string | null;
  receivedAt: string;
};

type EmailDetail = EmailListItem & {
  bodyText: string | null;
  llmSugestaoResposta: string | null;
  replyBody: string | null;
};

async function apiFetch(path: string, init?: RequestInit) {
  const token = getToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? response.statusText);
  return data;
}

function formatWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function EmailsPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("a_tratar");
  const [reply, setReply] = useState("");
  const [showReply, setShowReply] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const { data: stats } = useQuery({
    queryKey: ["email-inbox-stats"],
    queryFn: () => apiFetch("/api/email-inbox/stats"),
  });

  const listQs = useMemo(() => {
    const p = new URLSearchParams();
    if (statusFilter) p.set("status", statusFilter);
    if (labelFilter) p.set("label", labelFilter);
    const q = p.toString();
    return q ? `?${q}` : "";
  }, [statusFilter, labelFilter]);

  const { data: emails = [], isLoading } = useQuery<EmailListItem[]>({
    queryKey: ["email-inbox", statusFilter, labelFilter],
    queryFn: () => apiFetch(`/api/email-inbox${listQs}`),
  });

  const { data: detail } = useQuery<EmailDetail>({
    queryKey: ["email-inbox-item", selectedId],
    queryFn: () => apiFetch(`/api/email-inbox/${selectedId}`),
    enabled: Boolean(selectedId),
  });

  useEffect(() => {
    if (detail) {
      setReply(detail.replyBody || detail.llmSugestaoResposta || "");
      setShowReply(false);
    }
  }, [detail?.id]);

  const labels: { label: string; count: number }[] = stats?.labels ?? [];
  const novos = Number(stats?.novos ?? 0);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["email-inbox"] });
    void qc.invalidateQueries({ queryKey: ["email-inbox-stats"] });
    if (selectedId) void qc.invalidateQueries({ queryKey: ["email-inbox-item", selectedId] });
  };

  const syncMutation = useMutation({
    mutationFn: () => apiFetch("/api/email-inbox/sync", { method: "POST" }),
    onSuccess: (res) => {
      setError("");
      setSuccess(
        res.fetched
          ? `Sincronizado: ${res.fetched} lidos, ${res.created} novos.`
          : (res.errors?.[0] ?? "Nada de novo no Gmail."),
      );
      invalidate();
    },
    onError: (e: any) => { setSuccess(""); setError(e.message); },
  });

  const replyMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/email-inbox/${selectedId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: reply }),
      }),
    onSuccess: () => {
      setSuccess("Resposta enviada.");
      setShowReply(false);
      invalidate();
    },
    onError: (e: any) => setError(e.message),
  });

  const ticketMutation = useMutation({
    mutationFn: () => apiFetch(`/api/email-inbox/${selectedId}/criar-pedido`, { method: "POST" }),
    onSuccess: () => {
      setSuccess("Pedido criado a partir deste email.");
      invalidate();
      void qc.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (e: any) => setError(e.message),
  });

  const ignoreMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/email-inbox/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ignorado" }),
      }),
    onSuccess: () => {
      setSuccess("Email ignorado.");
      setSelectedId("");
      invalidate();
    },
    onError: (e: any) => setError(e.message),
  });

  return (
    <>
      <PageHeader
        title="Emails"
        subtitle={stats?.inboxAddress ?? "urbanizacaofonte@gmail.com"}
        breadcrumb={["Gestão Condomínio", "Administração", "Emails"]}
      />

      <div className="p-4 md:p-6 space-y-4">
        {(error || success) && (
          <div
            className="rounded-lg border px-4 py-3 text-sm"
            style={{
              borderColor: error ? "var(--red)" : "var(--green)",
              color: error ? "var(--red)" : "var(--green)",
              background: error ? "var(--red-subtle)" : "var(--green-subtle)",
            }}
          >
            {error || success}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => { setError(""); setSuccess(""); syncMutation.mutate(); }}
            loading={syncMutation.isPending}
            disabled={!stats?.gmailConfigured}
          >
            <RefreshCw size={14} className="mr-1.5" />
            Sincronizar Gmail
          </Button>
          <span className="text-sm" style={{ color: "var(--text-muted)" }}>
            {novos > 0 ? `${novos} por tratar` : "Em dia"}
          </span>
        </div>

        <div className="grid gap-4 lg:grid-cols-[200px_1fr_1.2fr]">
          {/* Marcadores */}
          <aside
            className="rounded-xl border p-3 space-y-1 h-fit"
            style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
          >
            <p className="text-xs font-semibold px-2 mb-2" style={{ color: "var(--text-muted)" }}>
              Marcadores
            </p>
            <button
              type="button"
              className="w-full text-left rounded-lg px-2 py-1.5 text-sm"
              style={{
                background: !labelFilter ? "var(--bg-secondary)" : "transparent",
                color: "var(--text-primary)",
              }}
              onClick={() => setLabelFilter("")}
            >
              Todos
            </button>
            {labels.map((l) => (
              <button
                type="button"
                key={l.label}
                className="w-full text-left rounded-lg px-2 py-1.5 text-sm flex justify-between gap-2"
                style={{
                  background: labelFilter === l.label ? "var(--bg-secondary)" : "transparent",
                  color: "var(--text-primary)",
                }}
                onClick={() => setLabelFilter(l.label)}
              >
                <span className="truncate">{l.label}</span>
                <span style={{ color: "var(--text-muted)" }}>{l.count}</span>
              </button>
            ))}
            {labels.length === 0 && (
              <p className="text-xs px-2" style={{ color: "var(--text-muted)" }}>
                Sincronize para ver marcadores.
              </p>
            )}
          </aside>

          {/* Lista */}
          <section
            className="rounded-xl border overflow-hidden"
            style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
          >
            <div className="flex gap-2 p-3 border-b" style={{ borderColor: "var(--border)" }}>
              {[
                { id: "a_tratar", label: "Por tratar" },
                { id: "", label: "Todos" },
                { id: "arquivo", label: "Arquivo" },
              ].map((t) => (
                <button
                  key={t.id || "all"}
                  type="button"
                  className="rounded-full px-3 py-1 text-xs font-medium"
                  style={{
                    background: statusFilter === t.id ? "var(--blue-primary)" : "var(--bg-secondary)",
                    color: statusFilter === t.id ? "#fff" : "var(--text-secondary)",
                  }}
                  onClick={() => setStatusFilter(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="max-h-[70vh] overflow-y-auto divide-y" style={{ borderColor: "var(--border)" }}>
              {isLoading ? (
                <p className="p-4 text-sm" style={{ color: "var(--text-muted)" }}>A carregar…</p>
              ) : emails.length === 0 ? (
                <p className="p-4 text-sm" style={{ color: "var(--text-muted)" }}>
                  Sem emails neste filtro. Clique em Sincronizar Gmail.
                </p>
              ) : (
                emails.map((e) => (
                  <button
                    type="button"
                    key={e.id}
                    onClick={() => { setSelectedId(e.id); setError(""); setSuccess(""); }}
                    className="w-full text-left px-4 py-3 transition-colors"
                    style={{
                      background: selectedId === e.id ? "var(--bg-secondary)" : "transparent",
                      borderLeft: selectedId === e.id ? "3px solid var(--blue-primary)" : "3px solid transparent",
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium text-sm line-clamp-1" style={{ color: "var(--text-primary)" }}>
                        {e.subject || "(sem assunto)"}
                      </p>
                      <span className="text-[11px] shrink-0" style={{ color: "var(--text-muted)" }}>
                        {formatWhen(e.receivedAt)}
                      </span>
                    </div>
                    <p className="text-xs mt-0.5 truncate" style={{ color: "var(--text-muted)" }}>
                      {e.fromName || e.fromEmail}
                      {e.gmailLabel ? ` · ${e.gmailLabel}` : ""}
                    </p>
                    {e.llmResumo && !/Content-Transfer-Encoding/i.test(e.llmResumo) && (
                      <p className="text-xs mt-1 line-clamp-2" style={{ color: "var(--text-secondary)" }}>
                        {e.llmResumo}
                      </p>
                    )}
                  </button>
                ))
              )}
            </div>
          </section>

          {/* Detalhe */}
          <section
            className="rounded-xl border p-4 space-y-4 min-h-[320px]"
            style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}
          >
            {!detail ? (
              <div className="h-full flex flex-col items-center justify-center gap-2 py-16" style={{ color: "var(--text-muted)" }}>
                <Mail size={28} />
                <p className="text-sm">Escolha um email à esquerda</p>
              </div>
            ) : (
              <>
                <div>
                  <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
                    {detail.subject}
                  </h2>
                  <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
                    De {detail.fromName ? `${detail.fromName} <${detail.fromEmail}>` : detail.fromEmail}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                    {formatWhen(detail.receivedAt)}
                    {detail.gmailLabel ? ` · ${detail.gmailLabel}` : ""}
                    {detail.fracaoNumero ? ` · Fração ${detail.fracaoNumero}` : ""}
                  </p>
                </div>

                <div
                  className="rounded-lg border p-3 text-sm max-h-[40vh] overflow-y-auto whitespace-pre-wrap leading-relaxed"
                  style={{ borderColor: "var(--border)", color: "var(--text-primary)", background: "var(--bg-secondary)" }}
                >
                  {detail.bodyText || "(sem texto)"}
                </div>

                {!showReply ? (
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => setShowReply(true)}>Responder</Button>
                    <Button
                      variant="secondary"
                      onClick={() => ticketMutation.mutate()}
                      loading={ticketMutation.isPending}
                      disabled={Boolean(detail.ticketId)}
                    >
                      {detail.ticketId ? "Já é pedido" : "Criar pedido"}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => ignoreMutation.mutate()}
                      loading={ignoreMutation.isPending}
                    >
                      Ignorar
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Textarea
                      label="Resposta"
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      rows={6}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        onClick={() => replyMutation.mutate()}
                        loading={replyMutation.isPending}
                        disabled={!reply.trim()}
                      >
                        Enviar
                      </Button>
                      <Button variant="ghost" onClick={() => setShowReply(false)}>
                        Cancelar
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
