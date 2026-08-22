import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Textarea } from "../components/ui/Input";
import { getToken } from "../lib/auth";

type EmailListItem = {
  id: string;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  categoria: string;
  urgencia: string;
  status: string;
  llmResumo: string | null;
  fracaoId: string | null;
  fracaoNumero: string | null;
  ticketId: string | null;
  receivedAt: string;
};

type EmailDetail = EmailListItem & {
  bodyText: string | null;
  llmSugestaoResposta: string | null;
  llmNotasInternas: string | null;
  replyBody: string | null;
  toEmail: string;
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

const STATUS_LABEL: Record<string, string> = {
  novo: "Novo",
  em_analise: "Em análise",
  respondido: "Respondido",
  convertido_pedido: "Pedido",
  ignorado: "Ignorado",
  spam: "Spam",
};

export default function EmailsPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [statusFilter, setStatusFilter] = useState("novo");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const { data: stats } = useQuery({
    queryKey: ["email-inbox-stats"],
    queryFn: () => apiFetch("/api/email-inbox/stats"),
  });

  const { data: emails = [], isLoading } = useQuery<EmailListItem[]>({
    queryKey: ["email-inbox", statusFilter],
    queryFn: () => apiFetch(`/api/email-inbox${statusFilter ? `?status=${statusFilter}` : ""}`),
  });

  const { data: detail } = useQuery<EmailDetail>({
    queryKey: ["email-inbox-item", selectedId],
    queryFn: () => apiFetch(`/api/email-inbox/${selectedId}`),
    enabled: Boolean(selectedId),
  });

  useEffect(() => {
    if (detail) {
      setReply(detail.replyBody || detail.llmSugestaoResposta || "");
    }
  }, [detail?.id]);

  const novos = useMemo(() => Number(stats?.novos ?? 0), [stats]);

  const syncMutation = useMutation({
    mutationFn: () => apiFetch("/api/email-inbox/sync", { method: "POST" }),
    onSuccess: (res) => {
      setSuccess(`Sync Gmail: ${res.fetched} lidos, ${res.created} novos.${res.errors?.length ? ` Erros: ${res.errors.join("; ")}` : ""}`);
      void qc.invalidateQueries({ queryKey: ["email-inbox"] });
      void qc.invalidateQueries({ queryKey: ["email-inbox-stats"] });
    },
    onError: (e: any) => setError(e.message),
  });

  const patchMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/email-inbox/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setSuccess("Email atualizado.");
      void qc.invalidateQueries({ queryKey: ["email-inbox"] });
      void qc.invalidateQueries({ queryKey: ["email-inbox-item", selectedId] });
      void qc.invalidateQueries({ queryKey: ["email-inbox-stats"] });
    },
    onError: (e: any) => setError(e.message),
  });

  const triageMutation = useMutation({
    mutationFn: () => apiFetch(`/api/email-inbox/${selectedId}/triage`, { method: "POST" }),
    onSuccess: () => {
      setSuccess("Triagem LLM atualizada.");
      void qc.invalidateQueries({ queryKey: ["email-inbox-item", selectedId] });
      void qc.invalidateQueries({ queryKey: ["email-inbox"] });
    },
    onError: (e: any) => setError(e.message),
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
      void qc.invalidateQueries({ queryKey: ["email-inbox"] });
      void qc.invalidateQueries({ queryKey: ["email-inbox-item", selectedId] });
      void qc.invalidateQueries({ queryKey: ["email-inbox-stats"] });
    },
    onError: (e: any) => setError(e.message),
  });

  const ticketMutation = useMutation({
    mutationFn: () => apiFetch(`/api/email-inbox/${selectedId}/criar-pedido`, { method: "POST" }),
    onSuccess: (res) => {
      setSuccess(`Pedido criado (${res.ticket?.id?.slice(0, 8)}…).`);
      void qc.invalidateQueries({ queryKey: ["email-inbox"] });
      void qc.invalidateQueries({ queryKey: ["email-inbox-item", selectedId] });
      void qc.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (e: any) => setError(e.message),
  });

  return (
    <>
      <PageHeader
        title="Emails"
        subtitle={`Caixa ${stats?.inboxAddress ?? "urbanizacaofonte@gmail.com"} — triagem LLM, resposta humana`}
        breadcrumb={["Gestão Condomínio", "Administração", "Emails"]}
      />
      <div className="p-6 space-y-6">
        {error && (
          <div className="rounded-lg border px-4 py-3 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)", background: "var(--red-subtle)" }}>
            {error}
          </div>
        )}
        {success && (
          <div className="rounded-lg border px-4 py-3 text-sm" style={{ borderColor: "var(--green)", color: "var(--green)", background: "var(--green-subtle)" }}>
            {success}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => syncMutation.mutate()} loading={syncMutation.isPending} disabled={!stats?.gmailConfigured}>
            Sincronizar Gmail
          </Button>
          {!stats?.gmailConfigured && (
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              Configure GMAIL_APP_PASSWORD no .env (palavra-passe de aplicação Google) para sincronizar.
            </span>
          )}
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>{novos} novos</span>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail size={16} /> Inbox
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {["", "novo", "em_analise", "respondido", "convertido_pedido", "spam", "ignorado"].map((s) => (
                  <Button
                    key={s || "all"}
                    size="sm"
                    variant={statusFilter === s ? "primary" : "secondary"}
                    onClick={() => setStatusFilter(s)}
                  >
                    {s ? STATUS_LABEL[s] : "Todos"}
                  </Button>
                ))}
              </div>
              {isLoading ? (
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>A carregar…</p>
              ) : emails.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>Sem emails neste filtro.</p>
              ) : (
                <div className="space-y-2 max-h-[70vh] overflow-y-auto">
                  {emails.map((e) => (
                    <button
                      type="button"
                      key={e.id}
                      onClick={() => { setSelectedId(e.id); setError(""); setSuccess(""); }}
                      className="w-full text-left rounded-lg border px-3 py-2 text-sm"
                      style={{
                        borderColor: selectedId === e.id ? "var(--blue-primary)" : "var(--border)",
                        background: "var(--bg-elevated)",
                      }}
                    >
                      <div className="font-semibold" style={{ color: "var(--text-primary)" }}>{e.subject}</div>
                      <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                        {e.fromName ? `${e.fromName} · ` : ""}{e.fromEmail}
                        {e.fracaoNumero ? ` · Fr. ${e.fracaoNumero}` : ""}
                        {" · "}{STATUS_LABEL[e.status] ?? e.status}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Detalhe</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {!detail ? (
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>Selecione um email.</p>
              ) : (
                <>
                  <div>
                    <h3 className="font-semibold" style={{ color: "var(--text-primary)" }}>{detail.subject}</h3>
                    <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                      De {detail.fromEmail} · {new Date(detail.receivedAt).toLocaleString("pt-PT")}
                      {detail.fracaoNumero ? ` · Fração ${detail.fracaoNumero}` : " · Fração não associada"}
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-xs space-y-1">
                      <span style={{ color: "var(--text-muted)" }}>Estado</span>
                      <select
                        className="w-full rounded-md border px-2 py-2 text-sm"
                        style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }}
                        value={detail.status}
                        onChange={(e) => patchMutation.mutate({ status: e.target.value })}
                      >
                        {Object.entries(STATUS_LABEL).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs space-y-1">
                      <span style={{ color: "var(--text-muted)" }}>Categoria</span>
                      <select
                        className="w-full rounded-md border px-2 py-2 text-sm"
                        style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }}
                        value={detail.categoria}
                        onChange={(e) => patchMutation.mutate({ categoria: e.target.value })}
                      >
                        {["manutencao", "ruido", "financeiro", "juridico", "administrativo", "fornecedor", "spam", "outro"].map((k) => (
                          <option key={k} value={k}>{k}</option>
                        ))}
                      </select>
                    </label>
                  </div>

                  {detail.llmResumo && (
                    <div className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--border)", background: "var(--bg-secondary)" }}>
                      <p className="text-xs font-semibold mb-1" style={{ color: "var(--text-muted)" }}>Resumo LLM</p>
                      <p style={{ color: "var(--text-primary)" }}>{detail.llmResumo}</p>
                    </div>
                  )}
                  {detail.llmNotasInternas && (
                    <div className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--border)" }}>
                      <p className="text-xs font-semibold mb-1" style={{ color: "var(--text-muted)" }}>Notas internas</p>
                      <p style={{ color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>{detail.llmNotasInternas}</p>
                    </div>
                  )}

                  <div className="rounded-lg border p-3 text-sm max-h-48 overflow-y-auto" style={{ borderColor: "var(--border)", whiteSpace: "pre-wrap", color: "var(--text-primary)" }}>
                    {detail.bodyText || "(sem texto)"}
                  </div>

                  <Textarea label="Rascunho de resposta" value={reply} onChange={(e) => setReply(e.target.value)} rows={8} />
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => replyMutation.mutate()} loading={replyMutation.isPending} disabled={!reply.trim()}>
                      Enviar resposta
                    </Button>
                    <Button variant="secondary" onClick={() => setReply(detail.llmSugestaoResposta || "")} disabled={!detail.llmSugestaoResposta}>
                      Usar sugestão LLM
                    </Button>
                    <Button variant="secondary" onClick={() => triageMutation.mutate()} loading={triageMutation.isPending}>
                      Atualizar triagem
                    </Button>
                    <Button variant="secondary" onClick={() => ticketMutation.mutate()} loading={ticketMutation.isPending} disabled={Boolean(detail.ticketId)}>
                      {detail.ticketId ? "Já é pedido" : "Criar pedido"}
                    </Button>
                    <Button variant="ghost" onClick={() => patchMutation.mutate({ status: "ignorado" })}>
                      Ignorar
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
