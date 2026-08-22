import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Textarea } from "../components/ui/Input";
import { getToken } from "../lib/auth";

type TicketListItem = {
  id: string;
  fracaoId: string;
  fracaoNumero: string | null;
  titulo: string;
  descricao: string;
  categoria: string;
  urgencia: string;
  status: string;
  llmResumo: string | null;
  llmSugestaoResposta: string | null;
  llmFeedbackRating?: string | null;
  createdAt: string;
  updatedAt: string;
};

type TicketDetail = TicketListItem & {
  llmCategoria: string | null;
  llmUrgencia: string | null;
  llmNotasInternas?: string | null;
  messages: Array<{
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
    mimeType: string;
  }>;
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
  aberto: "Aberto",
  em_curso: "Em curso",
  aguarda_condomino: "Aguarda condómino",
  resolvido: "Resolvido",
  cancelado: "Cancelado",
};

const CATEGORIA_LABEL: Record<string, string> = {
  manutencao: "Manutenção",
  ruido: "Ruído",
  financeiro: "Financeiro",
  juridico: "Jurídico",
  administrativo: "Administrativo",
  outro: "Outro",
};

export default function PedidosPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [feedbackComment, setFeedbackComment] = useState("");

  const { data: tickets = [], isLoading } = useQuery<TicketListItem[]>({
    queryKey: ["tickets", statusFilter],
    queryFn: () => apiFetch(`/api/tickets${statusFilter ? `?status=${statusFilter}` : ""}`),
  });

  const { data: detail } = useQuery<TicketDetail>({
    queryKey: ["ticket", selectedId],
    queryFn: () => apiFetch(`/api/tickets/${selectedId}`),
    enabled: Boolean(selectedId),
  });

  useEffect(() => {
    let cancelled = false;
    async function loadMedia() {
      const token = getToken();
      const atts = detail?.attachments ?? [];
      for (const a of atts) {
        try {
          const fr = await fetch(a.url, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (!fr.ok) continue;
          const blob = await fr.blob();
          const objectUrl = URL.createObjectURL(blob);
          if (!cancelled) setMediaUrls((prev) => (prev[a.id] ? prev : { ...prev, [a.id]: objectUrl }));
        } catch {
          /* ignore */
        }
      }
    }
    setMediaUrls({});
    void loadMedia();
    return () => { cancelled = true; };
  }, [detail?.id, detail?.attachments]);

  const openCount = useMemo(
    () => tickets.filter((t) => !["resolvido", "cancelado"].includes(t.status)).length,
    [tickets],
  );

  const patchMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/tickets/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setSuccess("Pedido atualizado.");
      setError("");
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      void qc.invalidateQueries({ queryKey: ["ticket", selectedId] });
    },
    onError: (e: any) => setError(e.message),
  });

  const replyMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/tickets/${selectedId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: reply }),
      }),
    onSuccess: () => {
      setReply("");
      setSuccess("Mensagem enviada.");
      void qc.invalidateQueries({ queryKey: ["ticket", selectedId] });
      void qc.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (e: any) => setError(e.message),
  });

  const triageMutation = useMutation({
    mutationFn: () => apiFetch(`/api/tickets/${selectedId}/triage`, { method: "POST" }),
    onSuccess: () => {
      setSuccess("Triagem LLM atualizada.");
      void qc.invalidateQueries({ queryKey: ["ticket", selectedId] });
      void qc.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (e: any) => setError(e.message),
  });

  const feedbackMutation = useMutation({
    mutationFn: (payload: { rating: "positive" | "negative"; comment?: string }) =>
      apiFetch(`/api/tickets/${selectedId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating: payload.rating,
          target: "geral",
          comment: payload.comment || undefined,
          // Se rejeitar e houver texto na caixa de resposta, grava como modelo correcto
          correctedResposta: payload.rating === "negative" && reply.trim() ? reply.trim() : undefined,
        }),
      }),
    onSuccess: (_data, vars) => {
      setSuccess(
        vars.rating === "positive"
          ? "Feedback registado: exemplo positivo guardado para esta área."
          : "Feedback registado: correcção guardada para a LLM evitar o mesmo erro.",
      );
      setFeedbackComment("");
      setError("");
      void qc.invalidateQueries({ queryKey: ["ticket", selectedId] });
      void qc.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (e: any) => setError(e.message),
  });

  function useSuggestion() {
    if (detail?.llmSugestaoResposta) setReply(detail.llmSugestaoResposta);
  }

  return (
    <>
      <PageHeader
        title="Pedidos"
        subtitle="Fila de pedidos dos condóminos com triagem automática"
        breadcrumb={["Gestão Condomínio", "Administração", "Pedidos"]}
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

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare size={16} />
                Fila ({openCount} abertos)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {["", "aberto", "em_curso", "aguarda_condomino", "resolvido"].map((s) => (
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
              ) : tickets.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>Sem pedidos.</p>
              ) : (
                <div className="space-y-2 max-h-[70vh] overflow-y-auto">
                  {tickets.map((t) => (
                    <button
                      type="button"
                      key={t.id}
                      onClick={() => { setSelectedId(t.id); setSuccess(""); setError(""); }}
                      className="w-full text-left rounded-lg border px-3 py-2 text-sm"
                      style={{
                        borderColor: selectedId === t.id ? "var(--blue-primary)" : "var(--border)",
                        background: "var(--bg-elevated)",
                      }}
                    >
                      <div className="font-semibold" style={{ color: "var(--text-primary)" }}>{t.titulo}</div>
                      <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                        Fração {t.fracaoNumero ?? "?"} · {CATEGORIA_LABEL[t.categoria] ?? t.categoria} · {STATUS_LABEL[t.status] ?? t.status}
                        {t.urgencia === "urgente" || t.urgencia === "alta" ? ` · ${t.urgencia}` : ""}
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
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>Selecione um pedido.</p>
              ) : (
                <>
                  <div>
                    <h3 className="font-semibold" style={{ color: "var(--text-primary)" }}>{detail.titulo}</h3>
                    <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                      Fração {detail.fracaoNumero} · {new Date(detail.createdAt).toLocaleString("pt-PT")}
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
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
                        {Object.entries(CATEGORIA_LABEL).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs space-y-1">
                      <span style={{ color: "var(--text-muted)" }}>Urgência</span>
                      <select
                        className="w-full rounded-md border px-2 py-2 text-sm"
                        style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }}
                        value={detail.urgencia}
                        onChange={(e) => patchMutation.mutate({ urgencia: e.target.value })}
                      >
                        {["baixa", "normal", "alta", "urgente"].map((k) => (
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
                    <div className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--border)", background: "var(--bg-elevated)" }}>
                      <p className="text-xs font-semibold mb-1" style={{ color: "var(--text-muted)" }}>Notas internas (só admin)</p>
                      <p style={{ color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>{detail.llmNotasInternas}</p>
                    </div>
                  )}

                  {(detail.attachments?.length ?? 0) > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Anexos</p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {detail.attachments!.map((a) => (
                          <div
                            key={a.id}
                            className="rounded-lg border p-2 text-xs"
                            style={{ borderColor: "var(--border)", color: "var(--text-primary)" }}
                          >
                            {mediaUrls[a.id] ? (
                              a.kind === "image" ? (
                                <img src={mediaUrls[a.id]} alt={a.originalName} className="w-full max-h-40 object-cover rounded mb-1" />
                              ) : (
                                <video src={mediaUrls[a.id]} controls className="w-full max-h-40 rounded mb-1" />
                              )
                            ) : (
                              <p className="mb-1" style={{ color: "var(--text-muted)" }}>A carregar…</p>
                            )}
                            {a.originalName}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="space-y-2 max-h-64 overflow-y-auto rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
                    {detail.messages?.map((m) => (
                      <div key={m.id} className="text-sm">
                        <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>
                          {m.authorRole === "system" ? "Sistema" : m.authorName ?? m.authorRole}
                          {" · "}
                          {new Date(m.createdAt).toLocaleString("pt-PT")}
                        </span>
                        <p style={{ color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>{m.body}</p>
                      </div>
                    ))}
                  </div>

                  <Textarea label="Resposta ao condómino" value={reply} onChange={(e) => setReply(e.target.value)} rows={8} />
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => replyMutation.mutate()} loading={replyMutation.isPending} disabled={!reply.trim()}>
                      Enviar
                    </Button>
                    <Button variant="secondary" onClick={useSuggestion} disabled={!detail.llmSugestaoResposta}>
                      Usar sugestão LLM
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => triageMutation.mutate()}
                      loading={triageMutation.isPending}
                      title="Volta a analisar o pedido + histórico e gera novo resumo, notas e sugestão de resposta"
                    >
                      Atualizar triagem LLM
                    </Button>
                  </div>

                  {detail.llmSugestaoResposta && (
                    <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: "var(--border)" }}>
                      <p className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>
                        Feedback à LLM
                        {detail.llmFeedbackRating === "positive" && " · última: útil ✓"}
                        {detail.llmFeedbackRating === "negative" && " · última: a melhorar ✗"}
                      </p>
                      <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                        Marca se a triagem/sugestão estava boa. Se estiver má, corrige categoria/urgência acima e/ou escreve a resposta correcta na caixa — depois marca «A melhorar».
                      </p>
                      <input
                        className="w-full rounded-md border px-2 py-1.5 text-sm"
                        style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }}
                        placeholder="Comentário opcional (ex.: urgência demasiado alta)"
                        value={feedbackComment}
                        onChange={(e) => setFeedbackComment(e.target.value)}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={feedbackMutation.isPending}
                          onClick={() => feedbackMutation.mutate({ rating: "positive", comment: feedbackComment })}
                        >
                          Sugestão útil
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          loading={feedbackMutation.isPending}
                          onClick={() => feedbackMutation.mutate({ rating: "negative", comment: feedbackComment })}
                        >
                          A melhorar
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
