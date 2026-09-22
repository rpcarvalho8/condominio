import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { getToken } from "../lib/auth";

type IngestDocument = {
  id: string;
  kind: string;
  filename: string;
  status: string;
  error?: string | null;
  contentHash?: string | null;
  pipelineJson?: string | null;
};

type PipelineSummary = {
  readyForConfirmation: number;
  needsHumanDecision: number;
  blocking?: Array<{ code: string; message: string }>;
};

type ExtractLine = {
  id: string;
  lineNo: number;
  kind: string;
  payloadJson: string;
  editedPayloadJson?: string | null;
  sourceExcerpt: string;
  confidence: number | null;
  status: string;
};

type FracaoRow = { id: string; codigo: string; permilagem: number };

const SEVILLA_RED = "#D0021B";

async function f1Fetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init?.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`/api/f1${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

function parsePipeline(doc: IngestDocument | null): PipelineSummary | null {
  if (!doc?.pipelineJson) return null;
  try {
    return JSON.parse(doc.pipelineJson) as PipelineSummary;
  } catch {
    return null;
  }
}

function lineWarnings(line: ExtractLine): string[] {
  const payload = parsePayload(line);
  const warnings = payload.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings
    .map((warning) => {
      if (warning && typeof warning === "object" && "message" in warning) {
        return String((warning as { message?: unknown }).message ?? "");
      }
      return "";
    })
    .filter(Boolean);
}

function parsePayload(line: ExtractLine): Record<string, unknown> {
  try {
    return JSON.parse(line.editedPayloadJson || line.payloadJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function statusVariant(status: string): "green" | "amber" | "red" | "muted" {
  if (status === "confirmed") return "green";
  if (status === "pending_review" || status === "partially_confirmed" || status === "extracting") {
    return "amber";
  }
  if (status === "failed" || status === "rejected" || status === "needs_human_review") return "red";
  return "muted";
}

export default function F1IngestaoPage() {
  const qc = useQueryClient();
  const [kind, setKind] = useState("regulamento");
  const [file, setFile] = useState<File | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [iban, setIban] = useState("");

  const documents = useQuery({
    queryKey: ["f1-documents"],
    queryFn: () => f1Fetch<{ documents: IngestDocument[] }>("/documents"),
  });
  const selected = (documents.data?.documents ?? []).find((d) => d.id === selectedId) ?? null;

  const linesQuery = useQuery({
    queryKey: ["f1-lines", selectedId],
    enabled: Boolean(selectedId),
    queryFn: () =>
      f1Fetch<{ document: IngestDocument; lines: ExtractLine[] }>(`/documents/${selectedId}/lines`),
  });
  const fracoes = useQuery({
    queryKey: ["f1-fracoes"],
    queryFn: () => f1Fetch<FracaoRow[]>("/fracoes"),
  });

  const lines = linesQuery.data?.lines ?? [];
  const reviewDocument = linesQuery.data?.document ?? selected;
  const pipeline = parsePipeline(reviewDocument);
  const pending = lines.filter((l) => l.status === "pending_review" || l.status === "needs_human_review");
  const fracaoLines = lines.filter((l) => l.kind === "fracao");
  const needsDecision = fracaoLines.filter((l) => l.status === "needs_human_review");
  const readyCount = pipeline
    ? pipeline.readyForConfirmation
    : fracaoLines.filter((l) => l.status === "pending_review").length;
  const decisionCount = pipeline ? pipeline.needsHumanDecision : needsDecision.length;
  const decisionLabel =
    decisionCount === 1 ? "1 decisão humana em aberto" : `${decisionCount} decisões humanas em aberto`;
  const editable = (status: string) => status === "pending_review" || status === "needs_human_review";

  const permilagemSum = useMemo(() => {
    return pending
      .filter((l) => l.kind === "fracao")
      .reduce((acc, line) => {
        const payload = { ...parsePayload(line), ...(edits[line.id] ?? {}) };
        const n = Number(payload.permilagem);
        return acc + (Number.isFinite(n) ? Math.round(n) : 0);
      }, 0);
  }, [pending, edits]);

  function field(line: ExtractLine, key: string): string {
    if (edits[line.id]?.[key] != null) return edits[line.id]![key]!;
    const payload = parsePayload(line);
    const v = payload[key];
    return v == null ? "" : String(v);
  }

  function setField(lineId: string, key: string, value: string) {
    setEdits((cur) => ({ ...cur, [lineId]: { ...(cur[lineId] ?? {}), [key]: value } }));
  }

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Escolha um ficheiro");
      const body = new FormData();
      body.set("kind", kind);
      body.set("file", file);
      const result = await f1Fetch<{ document: IngestDocument }>("/documents/upload", {
        method: "POST",
        body,
      });
      return result.document;
    },
    onSuccess: async (doc) => {
      setSelectedId(doc.id);
      setFile(null);
      await qc.invalidateQueries({ queryKey: ["f1-documents"] });
      try {
        await f1Fetch(`/documents/${doc.id}/extract-from-file`, { method: "POST", body: "{}" });
      } catch (err) {
        await qc.invalidateQueries({ queryKey: ["f1-documents"] });
        throw err;
      }
      await qc.invalidateQueries({ queryKey: ["f1-documents"] });
      await qc.invalidateQueries({ queryKey: ["f1-lines", doc.id] });
    },
  });

  const extractAgain = useMutation({
    mutationFn: () =>
      f1Fetch(`/documents/${selectedId}/extract-from-file`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["f1-documents"] });
      qc.invalidateQueries({ queryKey: ["f1-lines", selectedId] });
    },
  });

  const saveLine = useMutation({
    mutationFn: async (line: ExtractLine) => {
      const payload = { ...parsePayload(line), ...(edits[line.id] ?? {}) };
      if (line.kind === "fracao" && payload.permilagem != null) {
        payload.permilagem = Number(payload.permilagem);
      }
      return f1Fetch(`/documents/${selectedId}/lines/${line.id}`, {
        method: "POST",
        body: JSON.stringify({ payload }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["f1-lines", selectedId] });
      qc.invalidateQueries({ queryKey: ["f1-documents"] });
    },
  });

  const rejectFracaoLine = useMutation({
    mutationFn: async (line: ExtractLine) => {
      return f1Fetch(`/documents/${selectedId}/confirm-fracoes`, {
        method: "POST",
        body: JSON.stringify({ confirmations: [{ lineId: line.id, reject: true }] }),
      });
    },
    onSuccess: (_data, line) => {
      setEdits((cur) => {
        if (!(line.id in cur)) return cur;
        const next = { ...cur };
        delete next[line.id];
        return next;
      });
      qc.invalidateQueries({ queryKey: ["f1-lines", selectedId] });
      qc.invalidateQueries({ queryKey: ["f1-documents"] });
    },
  });

  const confirmFracoes = useMutation({
    mutationFn: async () => {
      const confirmations = pending
        .filter((l) => l.kind === "fracao" && l.status === "pending_review")
        .map((line) => {
          const payload = { ...parsePayload(line), ...(edits[line.id] ?? {}) };
          return {
            lineId: line.id,
            payload: {
              codigo: String(payload.codigo ?? ""),
              tipo: String(payload.tipo ?? "fracao"),
              permilagem: Number(payload.permilagem),
            },
          };
        });
      return f1Fetch(`/documents/${selectedId}/confirm-fracoes`, {
        method: "POST",
        body: JSON.stringify({ confirmations }),
      });
    },
    onSuccess: () => {
      setEdits({});
      qc.invalidateQueries({ queryKey: ["f1-lines", selectedId] });
      qc.invalidateQueries({ queryKey: ["f1-documents"] });
      qc.invalidateQueries({ queryKey: ["f1-fracoes"] });
    },
  });

  const confirmContactos = useMutation({
    mutationFn: async () => {
      const confirmations = pending
        .filter((l) => l.kind === "contacto" && l.status === "pending_review")
        .map((line) => {
          const payload = { ...parsePayload(line), ...(edits[line.id] ?? {}) };
          return {
            lineId: line.id,
            payload: {
              fracaoCodigo: String(payload.fracaoCodigo ?? ""),
              personName: String(payload.personName ?? ""),
              email: payload.email ? String(payload.email) : null,
              phone: payload.phone ? String(payload.phone) : null,
              nif: payload.nif ? String(payload.nif) : null,
            },
          };
        });
      return f1Fetch(`/documents/${selectedId}/confirm-contactos`, {
        method: "POST",
        body: JSON.stringify({ confirmations }),
      });
    },
    onSuccess: () => {
      setEdits({});
      qc.invalidateQueries({ queryKey: ["f1-lines", selectedId] });
      qc.invalidateQueries({ queryKey: ["f1-documents"] });
    },
  });

  const saveIban = useMutation({
    mutationFn: () =>
      f1Fetch(`/documents/${selectedId}/iban-proof`, {
        method: "POST",
        body: JSON.stringify({ iban }),
      }),
    onSuccess: () => {
      setIban("");
      qc.invalidateQueries({ queryKey: ["f1-documents"] });
    },
  });

  const actionError =
    (upload.error as Error | undefined)?.message ||
    (extractAgain.error as Error | undefined)?.message ||
    (rejectFracaoLine.error as Error | undefined)?.message ||
    (confirmFracoes.error as Error | undefined)?.message ||
    (confirmContactos.error as Error | undefined)?.message ||
    (saveIban.error as Error | undefined)?.message ||
    (saveLine.error as Error | undefined)?.message;

  return (
    <div>
      <PageHeader
        title="Ingestão"
        subtitle="PDF, Excel ou foto → revisão linha a linha com excerto de origem. Sem auto-confirmação e sem convites automáticos."
      />
      <div className="p-6 space-y-4 max-w-6xl">
        <Card>
          <CardHeader>
            <CardTitle>Carregar documento</CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-wrap gap-3 items-end">
              <label className="text-sm space-y-1">
                <span className="block text-xs" style={{ color: "var(--text-secondary)" }}>
                  Tipo
                </span>
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                  className="rounded-md px-3 py-2 text-sm border"
                  style={{ background: "var(--bg-elevated)", borderColor: "var(--border-strong)" }}
                >
                  <option value="regulamento">Regulamento / frações</option>
                  <option value="contactos">Contactos</option>
                  <option value="iban_proof">Comprovativo IBAN</option>
                  <option value="orcamento" disabled>
                    Orçamento (só contratos · sem extracto)
                  </option>
                </select>
              </label>
              <label className="text-sm space-y-1 flex-1 min-w-[16rem]">
                <span className="block text-xs" style={{ color: "var(--text-secondary)" }}>
                  Ficheiro (PDF, Excel, CSV, texto, JPEG/PNG/WebP/GIF · máx. 10MB)
                </span>
                <input
                  type="file"
                  accept=".pdf,.csv,.xlsx,.xls,.txt,.jpg,.jpeg,.png,.webp,.gif,application/pdf,image/*"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-sm"
                />
              </label>
              <Button
                onClick={() => upload.mutate()}
                disabled={!file || upload.isPending}
                loading={upload.isPending}
                style={{ background: SEVILLA_RED, color: "white" }}
              >
                Carregar e extrair
              </Button>
            </div>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              A extração OCR/LLM é consultiva. Confirme cada linha; convites ficam na porta F3.
            </p>
          </CardContent>
        </Card>

        {actionError && (
          <div
            className="rounded-lg border px-4 py-3 text-sm"
            style={{ borderColor: SEVILLA_RED, color: SEVILLA_RED, background: "var(--red-subtle)" }}
          >
            {actionError}
          </div>
        )}

        <div className="grid md:grid-cols-[minmax(16rem,22rem)_1fr] gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Documentos</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {(documents.data?.documents ?? []).length === 0 && (
                <p className="p-4 text-sm" style={{ color: "var(--text-secondary)" }}>
                  Ainda não há uploads neste condomínio.
                </p>
              )}
              <ul>
                {(documents.data?.documents ?? []).map((doc) => (
                  <li key={doc.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedId(doc.id);
                        setEdits({});
                      }}
                      className="w-full text-left px-4 py-3 border-t"
                      style={{
                        borderColor: "var(--border)",
                        background: selectedId === doc.id ? "var(--bg-elevated)" : "transparent",
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium truncate">{doc.filename}</span>
                        <Badge variant={statusVariant(doc.status)}>{doc.status}</Badge>
                      </div>
                      <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                        {doc.kind}
                      </p>
                      {doc.error && (
                        <p className="text-xs mt-1" style={{ color: SEVILLA_RED }}>
                          {doc.error}
                        </p>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                {selected ? `Revisão · ${selected.filename}` : "Linhas extraídas"}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              {!selected && (
                <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                  Seleccione um documento para ver o excerto de origem e confirmar linha a linha.
                </p>
              )}
              {selected && lines.length === 0 && selected.status !== "failed" && (
                <div className="space-y-2">
                  <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                    Sem linhas extraídas.
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => extractAgain.mutate()}
                    disabled={extractAgain.isPending}
                    loading={extractAgain.isPending}
                  >
                    Extrair do ficheiro
                  </Button>
                </div>
              )}

              {lines.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left" style={{ color: "var(--text-secondary)" }}>
                        <th className="py-2 pr-2">#</th>
                        <th className="py-2 pr-2">Excerto de origem</th>
                        <th className="py-2 pr-2">Campos</th>
                        <th className="py-2 pr-2">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line) => (
                        <tr key={line.id} className="border-t align-top" style={{ borderColor: "var(--border)" }}>
                          <td className="py-3 pr-2 font-mono text-xs">{line.lineNo}</td>
                          <td className="py-3 pr-2 max-w-xs">
                            <p className="text-xs font-mono whitespace-pre-wrap" style={{ color: "var(--text-secondary)" }}>
                              {line.sourceExcerpt}
                            </p>
                            {line.confidence != null && (
                              <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                                confiança do sistema {line.confidence.toFixed(2)}
                              </p>
                            )}
                            {lineWarnings(line).map((warning) => (
                              <p key={warning} className="text-xs mt-1" style={{ color: SEVILLA_RED }}>
                                {warning}
                              </p>
                            ))}
                          </td>
                          <td className="py-3 pr-2 space-y-1">
                            {line.kind === "fracao" && (
                              <>
                                <input
                                  className="w-full rounded-md px-2 py-1 text-sm border"
                                  style={{ background: "var(--bg-elevated)", borderColor: "var(--border-strong)" }}
                                  value={field(line, "codigo")}
                                  disabled={!editable(line.status)}
                                  onChange={(e) => setField(line.id, "codigo", e.target.value)}
                                  placeholder="código"
                                />
                                <input
                                  className="w-24 rounded-md px-2 py-1 text-sm border"
                                  style={{ background: "var(--bg-elevated)", borderColor: "var(--border-strong)" }}
                                  value={field(line, "permilagem")}
                                  disabled={!editable(line.status)}
                                  onChange={(e) => setField(line.id, "permilagem", e.target.value)}
                                  placeholder="‰"
                                />
                              </>
                            )}
                            {line.kind === "contacto" && (
                              <>
                                <input
                                  className="w-full rounded-md px-2 py-1 text-sm border"
                                  style={{ background: "var(--bg-elevated)", borderColor: "var(--border-strong)" }}
                                  value={field(line, "fracaoCodigo")}
                                  disabled={line.status !== "pending_review"}
                                  onChange={(e) => setField(line.id, "fracaoCodigo", e.target.value)}
                                  placeholder="fração"
                                />
                                <input
                                  className="w-full rounded-md px-2 py-1 text-sm border"
                                  style={{ background: "var(--bg-elevated)", borderColor: "var(--border-strong)" }}
                                  value={field(line, "personName")}
                                  disabled={line.status !== "pending_review"}
                                  onChange={(e) => setField(line.id, "personName", e.target.value)}
                                  placeholder="nome"
                                />
                                <input
                                  className="w-full rounded-md px-2 py-1 text-sm border"
                                  style={{ background: "var(--bg-elevated)", borderColor: "var(--border-strong)" }}
                                  value={field(line, "email")}
                                  disabled={line.status !== "pending_review"}
                                  onChange={(e) => setField(line.id, "email", e.target.value)}
                                  placeholder="email"
                                />
                              </>
                            )}
                            {editable(line.status) && (
                              <div className="flex flex-wrap gap-2 pt-1">
                                <Button size="sm" variant="ghost" onClick={() => saveLine.mutate(line)}>
                                  Guardar edição
                                </Button>
                                {line.kind === "fracao" && line.status === "needs_human_review" && (
                                  <Button
                                    size="sm"
                                    variant="danger"
                                    disabled={rejectFracaoLine.isPending}
                                    loading={
                                      rejectFracaoLine.isPending &&
                                      rejectFracaoLine.variables?.id === line.id
                                    }
                                    onClick={() => rejectFracaoLine.mutate(line)}
                                  >
                                    Rejeitar
                                  </Button>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="py-3">
                            <Badge variant={statusVariant(line.status)}>{line.status}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {selected?.kind === "regulamento" && fracaoLines.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm">
                    {readyCount} linhas prontas com evidência, {decisionLabel}. Nada fica confirmado sem esta revisão.
                  </p>
                  {(pipeline?.blocking ?? []).map((item) => (
                    <p key={item.code} className="text-xs" style={{ color: SEVILLA_RED }}>
                      {item.message}
                    </p>
                  ))}
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-sm" style={{ color: permilagemSum === 1000 && needsDecision.length === 0 ? "var(--green)" : SEVILLA_RED }}>
                      Σ permilagens = {permilagemSum}‰ (exige 1000‰)
                    </p>
                    <Button
                      onClick={() => confirmFracoes.mutate()}
                      disabled={
                        permilagemSum !== 1000 ||
                        needsDecision.length > 0 ||
                        reviewDocument?.status === "needs_human_review" ||
                        rejectFracaoLine.isPending ||
                        confirmFracoes.isPending
                      }
                      loading={confirmFracoes.isPending}
                      style={{ background: SEVILLA_RED, color: "white" }}
                    >
                      Confirmar frações
                    </Button>
                  </div>
                </div>
              )}

              {selected?.kind === "contactos" && pending.some((l) => l.kind === "contacto") && (
                <div className="space-y-2">
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                    Confirmar contactos não envia convites (ADR-017).
                  </p>
                  <Button
                    onClick={() => confirmContactos.mutate()}
                    disabled={confirmContactos.isPending}
                    loading={confirmContactos.isPending}
                    style={{ background: SEVILLA_RED, color: "white" }}
                  >
                    Confirmar contactos
                  </Button>
                </div>
              )}

              {selected?.kind === "iban_proof" && (
                <div className="flex flex-wrap gap-2 items-end">
                  <input
                    className="rounded-md px-3 py-2 text-sm border min-w-[16rem]"
                    style={{ background: "var(--bg-elevated)", borderColor: "var(--border-strong)" }}
                    placeholder="IBAN do condomínio"
                    value={iban}
                    onChange={(e) => setIban(e.target.value)}
                  />
                  <Button
                    onClick={() => saveIban.mutate()}
                    disabled={!iban || saveIban.isPending}
                    loading={saveIban.isPending}
                  >
                    Registar comprovativo
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Frações confirmadas</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {(fracoes.data ?? []).length === 0 ? (
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Ainda não há frações confirmadas. Obligations nascem do orçamento aprovado.
              </p>
            ) : (
              <ul className="text-sm space-y-1">
                {(fracoes.data ?? []).map((f) => (
                  <li key={f.id} className="flex justify-between font-mono">
                    <span>{f.codigo}</span>
                    <span>{f.permilagem}‰</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
