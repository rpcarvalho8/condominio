import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Input";
import { formatEuro, getMesNome } from "../lib/utils";
import { getToken } from "../lib/auth";
import { apiFetch as sharedApiFetch, humanizeNetworkError } from "../lib/api-client";
import {
  FileText, Mail, Download, RefreshCw, Zap,
  ChevronLeft, ChevronRight, CheckCircle2, Clock,
} from "lucide-react";

const ANOS = [2024, 2025, 2026, 2027].map((a) => ({ value: String(a), label: String(a) }));
const MESES = Array.from({ length: 12 }, (_, i) => ({
  value: String(i + 1),
  label: getMesNome(i + 1),
}));

async function apiFetch(path: string, options?: RequestInit) {
  const token = getToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

export default function RecibosPage() {
  const qc = useQueryClient();
  const agora = new Date();
  const [mes, setMes] = useState(agora.getMonth() + 1);
  const [ano, setAno] = useState(agora.getFullYear());
  const [gerarResult, setGerarResult] = useState<{ gerados: number; ignorados: number; erros: string[] } | null>(null);
  const [gerarError, setGerarError] = useState("");

  // List recibos (all, filtered client-side by mes+ano)
  const { data: todosRecibos = [], isLoading } = useQuery<any[]>({
    queryKey: ["recibos"],
    queryFn: () => apiFetch("/api/recibos"),
  });

  // Filter by selected mes/ano (using stored fields)
  const recibos = todosRecibos.filter((r: any) => r.mes === mes && r.ano === ano);

  // Stats
  const totalValor = recibos.reduce((s: number, r: any) => s + (r.valor ?? 0), 0);
  const enviados = recibos.filter((r: any) => r.enviadoEmail).length;

  const gerarMut = useMutation({
    mutationFn: () =>
      sharedApiFetch<{ gerados: number; ignorados: number; erros: string[] }>("/api/recibos/gerar", {
        method: "POST",
        token: getToken(),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mes, ano }),
        idempotent: true,
        retries: 2,
        timeoutMs: 120_000,
      }),
    onSuccess: (result) => {
      setGerarError("");
      setGerarResult(result);
      qc.invalidateQueries({ queryKey: ["recibos"] });
    },
    onError: (e) => setGerarError(humanizeNetworkError(e)),
  });

  const emailMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/recibos/${id}/email`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recibos"] }),
  });

  function irParaMes(delta: number) {
    const d = new Date(ano, mes - 1 + delta, 1);
    setMes(d.getMonth() + 1);
    setAno(d.getFullYear());
    setGerarResult(null);
  }

  function downloadPdf(pdfUrl: string, numeroRecibo: string) {
    const a = document.createElement("a");
    a.href = pdfUrl;
    a.target = "_blank";
    a.download = `recibo_${numeroRecibo}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <>
      <PageHeader
        title="Recibos"
        subtitle="Emissão e envio de recibos PDF mensais"
        breadcrumb={["Gestão Condomínio", "Recibos"]}
      />

      <div className="p-6 space-y-5">
        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Month navigator */}
          <div className="flex items-center gap-1" style={{ background: "var(--bg-elevated)", borderRadius: 8, border: "1px solid var(--border-subtle)", padding: "4px 8px" }}>
            <button
              onClick={() => irParaMes(-1)}
              className="p-1 rounded hover:opacity-70"
              style={{ color: "var(--text-secondary)" }}
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-semibold px-1" style={{ color: "var(--text-primary)", minWidth: 130, textAlign: "center" }}>
              {getMesNome(mes)} {ano}
            </span>
            <button
              onClick={() => irParaMes(1)}
              className="p-1 rounded hover:opacity-70"
              style={{ color: "var(--text-secondary)" }}
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <Select
            value={String(mes)}
            onChange={(e) => { setMes(Number(e.target.value)); setGerarResult(null); }}
            options={MESES}
            className="w-36"
          />
          <Select
            value={String(ano)}
            onChange={(e) => { setAno(Number(e.target.value)); setGerarResult(null); }}
            options={ANOS}
            className="w-28"
          />

          <Button
            variant="primary"
            loading={gerarMut.isPending}
            onClick={() => gerarMut.mutate()}
          >
            <Zap size={15} />
            Gerar Recibos
          </Button>
        </div>

        {/* Result feedback */}
        {gerarResult && (
          <div
            className="rounded-lg px-4 py-3 text-sm"
            style={{
              background: gerarResult.erros.length > 0 ? "var(--orange-bg, #fff7ed)" : "var(--green-bg, #f0fdf4)",
              border: `1px solid ${gerarResult.erros.length > 0 ? "var(--orange, #f97316)" : "var(--green, #22c55e)"}`,
              color: "var(--text-primary)",
            }}
          >
            <span className="font-semibold">
              {gerarResult.gerados > 0
                ? `✓ ${gerarResult.gerados} recibo(s) gerado(s)`
                : gerarResult.ignorados > 0
                ? `Já existem ${gerarResult.ignorados} recibo(s) para este mês`
                : "Sem quotas pagas neste mês"}
            </span>
            {gerarResult.ignorados > 0 && gerarResult.gerados > 0 && (
              <span className="ml-2 opacity-60">({gerarResult.ignorados} já existiam)</span>
            )}
            {gerarResult.erros.length > 0 && (
              <ul className="mt-1 opacity-80 list-disc list-inside">
                {gerarResult.erros.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </div>
        )}

        {gerarError && (
          <div className="rounded-lg border px-4 py-3 text-sm" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
            {gerarError}
          </div>
        )}

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Recibos", value: String(recibos.length), icon: FileText },
            { label: "Total", value: formatEuro(totalValor), icon: FileText },
            { label: "Emails enviados", value: `${enviados} / ${recibos.length}`, icon: Mail },
          ].map(({ label, value, icon: Icon }) => (
            <Card key={label}>
              <CardContent className="py-4 px-5 flex items-center gap-3">
                <Icon size={20} style={{ color: "var(--blue-primary)" }} />
                <div>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</p>
                  <p className="text-lg font-bold" style={{ color: "var(--text-primary)" }}>{value}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Table */}
        <Card>
          <CardHeader>
            <CardTitle>
              Recibos — {getMesNome(mes)} {ano}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-16">
                <RefreshCw size={20} className="animate-spin" style={{ color: "var(--text-muted)" }} />
              </div>
            ) : recibos.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2">
                <FileText size={32} style={{ color: "var(--text-muted)" }} />
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                  Sem recibos para {getMesNome(mes)} {ano}
                </p>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Clique em "Gerar Recibos" para criar os PDFs deste mês
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                      {["N.º Recibo", "Fração", "Proprietário", "Email", "Valor", "Estado", "Ações"].map((h) => (
                        <th
                          key={h}
                          className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {recibos.map((r: any, idx: number) => (
                      <tr
                        key={r.id}
                        style={{
                          borderBottom: idx < recibos.length - 1 ? "1px solid var(--border-subtle)" : undefined,
                          background: idx % 2 === 0 ? "transparent" : "var(--bg-elevated-2, transparent)",
                        }}
                        className="hover:opacity-90 transition-opacity"
                      >
                        <td className="px-4 py-3 font-mono font-semibold" style={{ color: "var(--text-primary)" }}>
                          {r.numeroRecibo}
                        </td>
                        <td className="px-4 py-3 font-semibold" style={{ color: "var(--text-primary)" }}>
                          {r.fracaoNumero ?? "—"}
                        </td>
                        <td className="px-4 py-3" style={{ color: "var(--text-secondary)" }}>
                          {r.proprietarioNome ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-xs" style={{ color: "var(--text-muted)" }}>
                          {r.proprietarioEmail ?? <span className="italic">sem email</span>}
                        </td>
                        <td className="px-4 py-3 font-semibold" style={{ color: "var(--text-primary)" }}>
                          {formatEuro(r.valor)}
                        </td>
                        <td className="px-4 py-3">
                          {r.enviadoEmail ? (
                            <Badge variant="success" className="flex items-center gap-1 w-fit">
                              <CheckCircle2 size={11} /> Enviado
                            </Badge>
                          ) : (
                            <Badge variant="warning" className="flex items-center gap-1 w-fit">
                              <Clock size={11} /> Pendente
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {r.pdfUrl && (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => downloadPdf(r.pdfUrl, r.numeroRecibo)}
                                title="Descarregar PDF"
                              >
                                <Download size={13} />
                                PDF
                              </Button>
                            )}
                            {r.proprietarioEmail && (
                              <Button
                                variant="ghost"
                                size="sm"
                                loading={emailMut.isPending}
                                onClick={() => emailMut.mutate(r.id)}
                                title={r.enviadoEmail ? "Reenviar email" : "Enviar email"}
                              >
                                <Mail size={13} />
                                {r.enviadoEmail ? "Reenviar" : "Enviar"}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
