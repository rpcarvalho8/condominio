import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PageHeader } from "../components/Layout";
import { Card, CardContent } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { formatEuro, getMesNome } from "../lib/utils";
import { apiFetch as sharedApiFetch } from "../lib/api-client";
import { getToken } from "../lib/auth";
import { AlertCircle, Phone, Mail, Clock, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

export default function MorososPage() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    contaCorrente: true,
    fundoReserva: false,
    quotaExtra: false,
    portao: false,
    incendio: false,
  });

  const { data: dashData, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => (await api.dashboard.$get()).json(),
  });

  const d = dashData as any;
  const morosos = d?.contaCorrente?.morosos ?? [];
  const totalEmDivida = d?.contaCorrente?.totalEmAtraso ?? 0;
  const fundoReservaMorosos = d?.fundoReserva?.morosos ?? [];
  const quotaExtraMorosos = d?.quotaExtra?.morosos ?? [];
  const portaoMorosos = d?.portaoGaragem?.morosos ?? [];
  const incendioMorosos = d?.incendio?.morosos ?? [];

  const pagarMut = useMutation({
    mutationFn: async (id: string) =>
      sharedApiFetch(`/api/quotas/${id}/pagar`, {
        method: "PATCH",
        token: getToken(),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metodoPagamento: "transferência" }),
        idempotent: true,
        retries: 2,
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["quotas"] }),
        qc.invalidateQueries({ queryKey: ["dashboard"] }),
        qc.invalidateQueries({ queryKey: ["morosos-count"] }),
      ]);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: "var(--text-muted)" }}>
        <div className="flex items-center gap-2">
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm">A carregar...</span>
        </div>
      </div>
    );
  }

  const toggle = (key: string) => setExpanded(p => ({ ...p, [key]: !p[key] }));

  // Total geral de dívida (conta corrente + fundo reserva + extras + portão + incêndio)
  const totalFundo = fundoReservaMorosos.reduce((s: number, m: any) => s + (m.total ?? 0), 0);
  const totalExtra = quotaExtraMorosos.reduce((s: number, m: any) => s + (m.total ?? 0), 0);
  const totalPortao = portaoMorosos.reduce((s: number, m: any) => s + (m.total ?? 0), 0);
  const totalIncendio = incendioMorosos.reduce((s: number, m: any) => s + (m.total ?? 0), 0);
  const totalGeral = totalEmDivida + totalFundo + totalExtra + totalPortao + totalIncendio;

  return (
    <>
      <PageHeader
        title="Morosos"
        subtitle={`Dívida total: ${formatEuro(totalGeral)}`}
        breadcrumb={["Gestão Condomínio", "Morosos"]}
      />

      <div className="p-6 space-y-4">
        {/* Resumo geral */}
        <div className="grid grid-cols-5 gap-3">
          {[
            { label: "Quotas condomínio", value: totalEmDivida, color: totalEmDivida > 0 ? "var(--red)" : "var(--green)" },
            { label: "Fundo de Reserva", value: totalFundo, color: totalFundo > 0 ? "var(--amber)" : "var(--green)" },
            { label: "Quota Extra (elevadores)", value: totalExtra, color: totalExtra > 0 ? "var(--amber)" : "var(--green)" },
            { label: "Portão Garagem", value: totalPortao, color: totalPortao > 0 ? "var(--amber)" : "var(--green)" },
            { label: "Incêndio", value: totalIncendio, color: totalIncendio > 0 ? "var(--amber)" : "var(--green)" },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-xl border p-3" style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}>
              <p className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>{label}</p>
              <p className="text-lg font-mono font-bold" style={{ color }}>{formatEuro(value)}</p>
            </div>
          ))}
        </div>

        {/* ── CONTA CORRENTE ── */}
        <MorososSection
          title="Conta Corrente — Quotas Condomínio"
          count={morosos.length}
          total={totalEmDivida}
          expanded={expanded.contaCorrente}
          onToggle={() => toggle("contaCorrente")}
          color="red"
        >
          {morosos.length === 0 ? (
            <EmptyState label="Todas as quotas de condomínio pagas" />
          ) : (
            morosos.map(({ fracao, quotas, total }: any) => (
              <MorososCard
                key={fracao?.id}
                fracao={fracao}
                total={total}
                quotas={quotas}
                onPagar={(id) => pagarMut.mutate(id)}
                showQuotas
              />
            ))
          )}
        </MorososSection>

        {/* ── FUNDO DE RESERVA ── */}
        <MorososSection
          title="Fundo de Reserva"
          count={fundoReservaMorosos.length}
          total={totalFundo}
          expanded={expanded.fundoReserva}
          onToggle={() => toggle("fundoReserva")}
          color="amber"
        >
          {fundoReservaMorosos.length === 0 ? (
            <EmptyState label="Fundo de reserva sem dívidas" />
          ) : (
            fundoReservaMorosos.map((m: any) => (
              <MorososCard
                key={m.fracao?.id}
                fracao={m.fracao}
                total={m.total}
                nota={m.nota}
                showQuotas={false}
              />
            ))
          )}
        </MorososSection>

        {/* ── QUOTA EXTRA (ELEVADORES) ── */}
        <MorososSection
          title="Quota Extra — Elevadores"
          count={quotaExtraMorosos.length}
          total={totalExtra}
          expanded={expanded.quotaExtra}
          onToggle={() => toggle("quotaExtra")}
          color="amber"
        >
          {quotaExtraMorosos.length === 0 ? (
            <EmptyState label="Quota extra de elevadores sem dívidas" />
          ) : (
            quotaExtraMorosos.map((m: any) => (
              <MorososCard key={m.fracao?.id} fracao={m.fracao} total={m.total} showQuotas={false} />
            ))
          )}
        </MorososSection>

        {/* ── PORTÃO GARAGEM ── */}
        <MorososSection
          title="Portão Garagem"
          count={portaoMorosos.length}
          total={totalPortao}
          expanded={expanded.portao}
          onToggle={() => toggle("portao")}
          color="amber"
        >
          {portaoMorosos.length === 0 ? (
            <EmptyState label="Portão garagem sem dívidas" />
          ) : (
            portaoMorosos.map((m: any) => (
              <MorososCard key={m.fracao?.id} fracao={m.fracao} total={m.total} showQuotas={false} />
            ))
          )}
        </MorososSection>

        {/* ── INCÊNDIO ── */}
        <MorososSection
          title="Incêndio (Obra)"
          count={incendioMorosos.length}
          total={totalIncendio}
          expanded={expanded.incendio}
          onToggle={() => toggle("incendio")}
          color="amber"
        >
          {incendioMorosos.length === 0 ? (
            <EmptyState label="Obra de incêndio sem dívidas" />
          ) : (
            incendioMorosos.map((m: any) => (
              <MorososCard key={m.fracao?.id} fracao={m.fracao} total={m.total} showQuotas={false} />
            ))
          )}
        </MorososSection>
      </div>
    </>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MorososSection({
  title, count, total, expanded, onToggle, color, children,
}: {
  title: string; count: number; total: number; expanded: boolean;
  onToggle: () => void; color: "red" | "amber"; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
      <button
        className="w-full flex items-center justify-between p-4 text-left hover:opacity-80 transition-opacity"
        style={{ background: "var(--bg-surface)" }}
        onClick={onToggle}
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{title}</span>
          {count > 0 && (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: color === "red" ? "var(--red-subtle)" : "var(--amber-subtle)", color: color === "red" ? "var(--red)" : "var(--amber)" }}
            >
              {count} {count === 1 ? "fração" : "frações"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-mono font-bold" style={{ color: total > 0 ? (color === "red" ? "var(--red)" : "var(--amber)") : "var(--green)" }}>
            {formatEuro(total)}
          </span>
          {expanded ? <ChevronUp size={16} style={{ color: "var(--text-muted)" }} /> : <ChevronDown size={16} style={{ color: "var(--text-muted)" }} />}
        </div>
      </button>
      {expanded && (
        <div className="p-4 pt-0 space-y-2" style={{ background: "var(--bg-surface)" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-4 px-2" style={{ color: "var(--text-muted)" }}>
      <CheckCircle2 size={16} style={{ color: "var(--green)" }} />
      <span className="text-sm">{label}</span>
    </div>
  );
}

function MorososCard({
  fracao, total, quotas, nota, showQuotas, onPagar,
}: {
  fracao: any; total: number; quotas?: any[]; nota?: string;
  showQuotas: boolean; onPagar?: (id: string) => void;
}) {
  const meses = quotas?.length ?? 0;
  const urgencia = meses >= 3 ? "red" : meses >= 2 ? "amber" : "muted";

  return (
    <div
      className="rounded-xl border p-4 mt-2"
      style={{ background: "var(--bg-elevated)", borderColor: "var(--border)" }}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold shrink-0"
            style={{
              background: urgencia === "red" ? "var(--red-subtle)" : "var(--amber-subtle)",
              color: urgencia === "red" ? "var(--red)" : "var(--amber)",
            }}
          >
            {fracao?.numero}
          </div>
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              {fracao?.proprietarioNome || "—"}
            </p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Fração {fracao?.numero} · {fracao?.andar === 0 ? "R/C" : `${fracao?.andar}º andar`}
            </p>
            {nota && (
              <p className="text-xs mt-0.5 italic" style={{ color: "var(--text-muted)" }}>{nota}</p>
            )}
          </div>
        </div>
        <p className="text-base font-mono font-bold" style={{ color: "var(--red)" }}>
          {formatEuro(total)}
        </p>
      </div>

      {showQuotas && quotas && quotas.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {quotas.map((q: any) => (
            <div
              key={q.id}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs"
              style={{ background: "var(--bg-surface)", color: "var(--text-secondary)" }}
            >
              <span>{getMesNome(q.mes)} {q.ano}</span>
              <span className="font-mono font-medium" style={{ color: "var(--amber)" }}>
                {formatEuro(q.valor)}
              </span>
              {onPagar && (
                <button
                  className="text-xs px-1.5 py-0.5 rounded hover:opacity-80"
                  style={{ background: "var(--green-subtle)", color: "var(--green)" }}
                  onClick={() => onPagar(q.id)}
                >
                  ✓ Pago
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Contactos — só se tiver email/telefone */}
      {(fracao?.proprietarioEmail || fracao?.proprietarioTelefone) && (
        <div className="mt-3 pt-3 border-t flex items-center gap-2" style={{ borderColor: "var(--border)" }}>
          <span className="text-xs mr-1" style={{ color: "var(--text-muted)" }}>Contactar:</span>
          {fracao?.proprietarioTelefone && (
            <a
              href={`tel:${fracao.proprietarioTelefone}`}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
              style={{ background: "var(--bg-surface)", color: "var(--text-secondary)" }}
            >
              <Phone size={11} />
              {fracao.proprietarioTelefone}
            </a>
          )}
          {fracao?.proprietarioEmail && (
            <a
              href={`mailto:${fracao.proprietarioEmail}?subject=Quota em atraso — Fração ${fracao.numero}&body=Exmo. Sr./Sra. ${fracao.proprietarioNome},%0D%0A%0D%0AInformamos que tem pagamentos por regularizar.%0D%0A%0D%0AAgradecemos brevidade no pagamento.%0D%0A%0D%0ACom os melhores cumprimentos,%0D%0AAdministração do Condomínio`}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
              style={{ background: "var(--blue-subtle)", color: "var(--blue-bright)" }}
            >
              <Mail size={11} />
              Email
            </a>
          )}
        </div>
      )}
    </div>
  );
}
