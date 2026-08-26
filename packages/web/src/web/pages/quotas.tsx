import { useState, useEffect, Component, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useIsAdmin, getToken } from "../lib/auth";
import { PageHeader } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Select, Input } from "../components/ui/Input";
import { formatEuro, formatDate, getMesNome, METODOS_PAGAMENTO } from "../lib/utils";
import { apiFetch as sharedApiFetch } from "../lib/api-client";
import {
  CheckCircle2, XCircle, RefreshCw, Zap, CreditCard,
  ChevronLeft, ChevronRight, Plus, Tag, Layers, AlertCircle,
  Euro, TrendingDown, ArrowLeft, Building2, Wrench, Shield,
} from "lucide-react";

const MESES = Array.from({ length: 12 }, (_, i) => ({
  value: String(i + 1),
  label: getMesNome(i + 1),
}));

const ANOS = [2024, 2025, 2026, 2027].map((a) => ({ value: String(a), label: String(a) }));

const TABS = [
  { value: "condominio",    label: "Condomínio" },
  { value: "obras",         label: "Obras" },
  { value: "extra",         label: "Extras" },
  { value: "fundo_reserva", label: "Fundo Reserva" },
];

class QuotasErrorBoundary extends Component<{children: ReactNode}, {error: any}> {
  constructor(props: any) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e: any) { return { error: e }; }
  render() {
    if (this.state.error) return (
      <div className="p-8 rounded-lg m-6" style={{ background: "var(--red-subtle)", color: "var(--red)" }}>
        <strong>Erro ao carregar quotas:</strong> {String(this.state.error?.message || this.state.error)}
      </div>
    );
    return this.props.children;
  }
}

function QuotasPageInner() {
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const agora = new Date();
  const [mes, setMes] = useState(agora.getMonth() + 1);
  const [ano, setAno] = useState(agora.getFullYear());
  const [tipo, setTipo] = useState("condominio");
  const [pagarModal, setPagarModal] = useState<any>(null);
  const [metodo, setMetodo] = useState("transferência");
  const [selecionadas, setSelecionadas] = useState<Set<string>>(new Set());
  const [novaExtraModal, setNovaExtraModal] = useState(false);
  const [extraTipoFiltro, setExtraTipoFiltro] = useState<string | null>(null);
  const [reassignModal, setReassignModal] = useState<any>(null);

  // Dashboard data (has hardcoded fallback for Obras/FR/Extras)
  const { data: dashData, isLoading: dashLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => (await fetch("/api/dashboard", { credentials: "include" })).json(),
  });

  // Quotas mensais (used only for Condomínio tab)
  const { data, isLoading } = useQuery({
    queryKey: ["quotas", mes, ano, tipo],
    queryFn: async () =>
      (await api.quotas.$get({ query: { mes: String(mes), ano: String(ano), tipo } })).json(),
    enabled: tipo === "condominio" || tipo === "extra",
  });

  // Quota Tipos — só extra (DB)
  const { data: quotaTiposData } = useQuery({
    queryKey: ["quota-tipos"],
    queryFn: async () => (await api["quota-tipos"].$get()).json(),
  });
  const quotaTipos: any[] = (quotaTiposData as any) ?? [];
  const extraTipos = quotaTipos.filter((t: any) => t.tipo === "extra");

  const { data: fracoesData } = useQuery({
    queryKey: ["fracoes"],
    queryFn: async () => (await fetch("/api/fracoes", { credentials: "include" })).json(),
  });
  const fracoesActivas = ((fracoesData as any)?.fracoes ?? [])
    .filter((f: { ativo?: boolean }) => f.ativo !== false)
    .sort((a: { numero: string }, b: { numero: string }) =>
      a.numero.localeCompare(b.numero, "pt", { numeric: true }),
    );

  const pagarMut = useMutation({
    mutationFn: async ({ id, metodoPagamento }: any) =>
      sharedApiFetch(`/api/quotas/${id}/pagar`, {
        method: "PATCH",
        token: getToken(),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metodoPagamento }),
        idempotent: true,
        retries: 2,
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["quotas"] }),
        qc.invalidateQueries({ queryKey: ["dashboard"] }),
        qc.invalidateQueries({ queryKey: ["morosos-count"] }),
      ]);
      setPagarModal(null);
    },
  });

  const desmarcarMut = useMutation({
    mutationFn: async (id: string) =>
      (await api.quotas[":id"].desmarcar.$patch({ param: { id }, json: {} })).json(),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["quotas"] }),
        qc.invalidateQueries({ queryKey: ["dashboard"] }),
        qc.invalidateQueries({ queryKey: ["morosos-count"] }),
      ]);
    },
  });

  const gerarMut = useMutation({
    mutationFn: async () =>
      (await api.quotas["gerar-mensal"].$post({ json: { mes, ano } })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["quotas"] }),
  });

  const reassignMut = useMutation({
    mutationFn: async ({ id, quotaTipoId }: { id: string; quotaTipoId: string | null }) => {
      const res = await fetch(`/api/quotas/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ quotaTipoId }),
      });
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotas"] });
      setReassignModal(null);
    },
  });

  const quotas = (data as any)?.quotas ?? [];

  // Para extras DB: filtrar por quotaTipoId se selecionado
  const quotasFiltradas = tipo === "extra" && extraTipoFiltro
    ? quotas.filter((q: any) => q.quota.quotaTipoId === extraTipoFiltro)
    : quotas;

  const pagas = quotasFiltradas.filter((q: any) => q.quota.pago);
  const nPagas = quotasFiltradas.filter((q: any) => !q.quota.pago);
  const totalReceita = pagas.reduce((s: number, q: any) => s + q.quota.valor, 0);
  const totalPendente = nPagas.reduce((s: number, q: any) => s + q.quota.valor, 0);

  // Agrupar extras DB por quotaTipoId
  const extrasByTipo = extraTipos.map((t: any) => {
    const items = quotas.filter((q: any) => q.quota.quotaTipoId === t.id);
    const pagos = items.filter((q: any) => q.quota.pago);
    const total = items.reduce((s: number, q: any) => s + q.quota.valor, 0);
    const totalPago = pagos.reduce((s: number, q: any) => s + q.quota.valor, 0);
    return { tipo: t, items, pagos: pagos.length, total, totalPago };
  });

  const extrasSemTipo = quotas.filter((q: any) => tipo === "extra" && !q.quota.quotaTipoId);

  function toggleSelect(id: string) {
    setSelecionadas((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function irParaMes(delta: number) {
    const d = new Date(ano, mes - 1 + delta, 1);
    setMes(d.getMonth() + 1);
    setAno(d.getFullYear());
    setSelecionadas(new Set());
  }

  // Dashboard sections
  const d = dashData as any;

  return (
    <>
      <PageHeader
        title="Quotas"
        subtitle={tipo === "condominio" ? `${getMesNome(mes)} ${ano}` : TABS.find(t => t.value === tipo)?.label}
        breadcrumb={["Gestão Condomínio", "Quotas"]}
        actions={isAdmin ? (
          <div className="flex items-center gap-2">
            {tipo === "extra" && (
              <Button size="sm" onClick={() => setNovaExtraModal(true)} variant="secondary">
                <Plus size={13} />
                Nova Cota Extra
              </Button>
            )}
            {tipo === "condominio" && (
              <Button size="sm" onClick={() => gerarMut.mutate()} loading={gerarMut.isPending} variant="secondary">
                <Zap size={13} />
                Gerar quotas do mês
              </Button>
            )}
          </div>
        ) : undefined}
      />

      <div className="p-6 space-y-4">
        {/* Tabs por tipo */}
        <div className="flex items-center gap-1 p-1 rounded-lg w-fit" style={{ background: "var(--bg-elevated)" }}>
          {TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => { setTipo(t.value); setSelecionadas(new Set()); setExtraTipoFiltro(null); }}
              className="px-4 py-1.5 rounded-md text-sm font-medium transition-all"
              style={
                tipo === t.value
                  ? { background: "var(--bg-surface)", color: "var(--text-primary)", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }
                  : { color: "var(--text-muted)" }
              }
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── CONDOMÍNIO: tabela mensal ── */}
        {tipo === "condominio" && (
          <>
            {/* Navegação de mês */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => irParaMes(-1)}
                  className="p-1.5 rounded-md border hover:opacity-80 transition-opacity"
                  style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
                >
                  <ChevronLeft size={14} />
                </button>
                <div className="flex items-center gap-2">
                  <Select
                    options={MESES}
                    value={String(mes)}
                    onChange={(e) => setMes(parseInt(e.target.value))}
                    className="text-sm py-1.5"
                  />
                  <Select
                    options={ANOS}
                    value={String(ano)}
                    onChange={(e) => setAno(parseInt(e.target.value))}
                    className="text-sm py-1.5"
                  />
                </div>
                <button
                  onClick={() => irParaMes(1)}
                  className="p-1.5 rounded-md border hover:opacity-80 transition-opacity"
                  style={{ borderColor: "var(--border-strong)", color: "var(--text-secondary)" }}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
              <div className="flex items-center gap-3 text-sm" style={{ color: "var(--text-muted)" }}>
                <span className="font-mono" style={{ color: "var(--green)" }}>{formatEuro(totalReceita)} cobrado</span>
                <span>·</span>
                <span className="font-mono" style={{ color: "var(--red)" }}>{formatEuro(totalPendente)} pendente</span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <SumCard label="Pagas" value={pagas.length} total={quotas.length} color="var(--green)" />
              <SumCard label="Por pagar" value={nPagas.length} total={quotas.length} color="var(--red)" />
              <SumCard label="Taxa cobrança" value={`${quotas.length > 0 ? Math.round((pagas.length / quotas.length) * 100) : 0}%`} color="var(--blue-bright)" noBar />
            </div>

            {isLoading ? (
              <div className="text-sm" style={{ color: "var(--text-muted)" }}>A carregar...</div>
            ) : quotas.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-16 gap-3">
                  <CreditCard size={40} style={{ color: "var(--text-muted)" }} />
                  <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                    Sem quotas condomínio para {getMesNome(mes)} {ano}
                  </p>
                  {isAdmin && (
                    <Button size="sm" onClick={() => gerarMut.mutate()} loading={gerarMut.isPending}>
                      <Zap size={13} />
                      Gerar quotas do mês
                    </Button>
                  )}
                </CardContent>
              </Card>
            ) : (
              <QuotasTable
                quotas={quotas}
                tipo="condominio"
                extrasByTipo={[]}
                extraTipoFiltro={null}
                selecionadas={selecionadas}
                onPagar={(q) => { setPagarModal(q); setMetodo("transferência"); }}
                onDesmarcar={(id) => desmarcarMut.mutate(id)}
                onReassign={(q) => setReassignModal(q)}
                fracoesNaoCategorizadas={new Set(
                  ((d?.pagamentosNaoRegistados ?? []) as Array<{ fracao: string }>).map((p) => p.fracao)
                )}
              />
            )}
          </>
        )}

        {/* ── OBRAS: morosos do Excel ── */}
        {tipo === "obras" && (
          <SecaoMorosos
            titulo="Derrama de Obras"
            icone={<Wrench size={16} />}
            saldoConta={d?.obras?.saldoConta ?? 0}
            totalAtraso={d?.obras?.totalAtraso ?? 0}
            totalTotal={(d?.obras?.saldoConta ?? 0) + (d?.obras?.totalAtraso ?? 0)}
            morosos={d?.obras?.morosos ?? []}
            loading={dashLoading}
            descricao="Derrama extraordinária para obras no edifício"
            onPagar={(quotaId, metodo) => pagarMut.mutate({ id: quotaId, metodoPagamento: metodo })}
            onDesmarcar={(quotaId) => desmarcarMut.mutate(quotaId)}
            pagarLoading={pagarMut.isPending}
          />
        )}

        {/* ── EXTRAS: elevadores + portão (hardcoded) + DB tipos ── */}
        {tipo === "extra" && (
          <SecaoExtras
            dashData={d}
            extraTipos={extraTipos}
            extrasByTipo={extrasByTipo}
            extrasSemTipo={extrasSemTipo}
            quotas={quotas}
            quotasFiltradas={quotasFiltradas}
            pagas={pagas}
            nPagas={nPagas}
            extraTipoFiltro={extraTipoFiltro}
            setExtraTipoFiltro={setExtraTipoFiltro}
            onNovaExtra={() => setNovaExtraModal(true)}
            selecionadas={selecionadas}
            onPagar={(q) => { setPagarModal(q); setMetodo("transferência"); }}
            onDesmarcar={(id) => desmarcarMut.mutate(id)}
            onReassign={(q) => setReassignModal(q)}
            loading={dashLoading}
          />
        )}

        {/* ── FUNDO RESERVA: morosos ── */}
        {tipo === "fundo_reserva" && (
          <SecaoMorosos
            titulo="Fundo de Reserva"
            icone={<Shield size={16} />}
            saldoConta={d?.fundoReserva?.saldoConta ?? 0}
            totalAtraso={d?.fundoReserva?.totalEmAtraso ?? 0}
            totalTotal={(d?.fundoReserva?.saldoConta ?? 0) + (d?.fundoReserva?.totalEmAtraso ?? 0)}
            morosos={d?.fundoReserva?.morosos ?? []}
            loading={dashLoading}
            descricao="Fundo de reserva obrigatório (10% das quotas de condomínio)"
            onPagar={(quotaId, metodo) => pagarMut.mutate({ id: quotaId, metodoPagamento: metodo })}
            onDesmarcar={(quotaId) => desmarcarMut.mutate(quotaId)}
            pagarLoading={pagarMut.isPending}
          />
        )}
      </div>

      {/* Modal marcar pago */}
      {isAdmin && (
        <Modal open={!!pagarModal} onClose={() => setPagarModal(null)} title="Registar pagamento" size="sm">
          {pagarModal && (
            <div className="space-y-4">
              <div className="rounded-lg p-3" style={{ background: "var(--bg-elevated)" }}>
                <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  Fração {pagarModal.fracao?.numero} — {pagarModal.fracao?.proprietarioNome}
                </p>
                <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                  {getMesNome(pagarModal.quota.mes)} {pagarModal.quota.ano} · {formatEuro(pagarModal.quota.valor)}
                </p>
              </div>
              <Select
                label="Método de pagamento"
                options={METODOS_PAGAMENTO}
                value={metodo}
                onChange={(e) => setMetodo(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setPagarModal(null)}>Cancelar</Button>
                <Button
                  onClick={() => pagarMut.mutate({ id: pagarModal.quota.id, metodoPagamento: metodo })}
                  loading={pagarMut.isPending}
                >
                  <CheckCircle2 size={14} />
                  Confirmar pagamento
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* Modal Reassign Categoria */}
      <Modal open={!!reassignModal} onClose={() => setReassignModal(null)} title="Alterar categoria" size="sm">
        {reassignModal && (
          <div className="space-y-4">
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Fração <strong style={{ color: "var(--text-primary)" }}>{reassignModal.fracao?.numero}</strong> — {getMesNome(reassignModal.quota.mes)} {reassignModal.quota.ano}
            </p>
            <div className="space-y-2">
              {extraTipos.map((t: any) => (
                <button
                  key={t.id}
                  className="w-full text-left px-3 py-2.5 rounded-lg border transition-all hover:opacity-90"
                  style={{
                    background: reassignModal.quota.quotaTipoId === t.id ? "var(--blue-subtle)" : "var(--bg-elevated)",
                    borderColor: reassignModal.quota.quotaTipoId === t.id ? "var(--blue-bright)" : "var(--border)",
                    color: "var(--text-primary)",
                  }}
                  onClick={() => reassignMut.mutate({ id: reassignModal.quota.id, quotaTipoId: t.id })}
                >
                  <span className="text-sm font-medium">{t.nome}</span>
                  {t.descricao && <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{t.descricao}</p>}
                </button>
              ))}
              <button
                className="w-full text-left px-3 py-2 rounded-lg border transition-all hover:opacity-90"
                style={{ background: "var(--bg-surface)", borderColor: "var(--border)", color: "var(--text-muted)" }}
                onClick={() => reassignMut.mutate({ id: reassignModal.quota.id, quotaTipoId: null })}
              >
                <span className="text-sm">Sem categoria</span>
              </button>
            </div>
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => setReassignModal(null)}>Fechar</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Modal Nova Cota Extra */}
      {isAdmin && (
        <NovaExtraModal
          open={novaExtraModal}
          onClose={() => setNovaExtraModal(false)}
          fracoes={fracoesActivas}
          onCreated={async () => {
            await Promise.all([
              qc.invalidateQueries({ queryKey: ["quotas"] }),
              qc.invalidateQueries({ queryKey: ["dashboard"] }),
              qc.invalidateQueries({ queryKey: ["quota-tipos"] }),
            ]);
            setNovaExtraModal(false);
          }}
        />
      )}
    </>
  );
}

export default function QuotasPage() {
  return <QuotasErrorBoundary><QuotasPageInner /></QuotasErrorBoundary>;
}

// ─── Secção Morosos (Obras / Fundo Reserva) ──────────────────────────────────
function SecaoMorosos({
  titulo, icone, saldoConta, totalAtraso, totalTotal, morosos, loading, descricao,
  onPagar, onDesmarcar, pagarLoading,
}: {
  titulo: string;
  icone: React.ReactNode;
  saldoConta: number;
  totalAtraso: number;
  totalTotal: number;
  morosos: any[];
  loading: boolean;
  descricao?: string;
  onPagar: (quotaId: string, metodo: string) => void;
  onDesmarcar: (quotaId: string) => void;
  pagarLoading?: boolean;
}) {
  const isAdmin = useIsAdmin();
  const [pagarModal, setPagarModal] = useState<{
    fracao: any;
    total: number;
    quotaId: string;
  } | null>(null);
  const [metodo, setMetodo] = useState("transferência");

  if (loading) return <div className="text-sm" style={{ color: "var(--text-muted)" }}>A carregar...</div>;

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard
          label="Saldo conta"
          value={formatEuro(saldoConta)}
          color="var(--amber)"
          icon={<Euro size={15} />}
        />
        <KpiCard
          label="Por cobrar"
          value={formatEuro(totalAtraso)}
          sub={`${morosos.length} frações em atraso`}
          color="var(--red)"
          icon={<AlertCircle size={15} />}
        />
        <KpiCard
          label="Total emitido"
          value={formatEuro(totalTotal)}
          color="var(--blue-bright)"
          icon={<TrendingDown size={15} />}
        />
      </div>

      {descricao && (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>{descricao}</p>
      )}

      {/* Lista morosos */}
      {morosos.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 gap-2">
            <CheckCircle2 size={32} style={{ color: "var(--green)" }} />
            <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Sem morosos!</p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Todas as frações estão em dia.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              {icone}
              {titulo} — Frações em Atraso
              <Badge variant="red" className="ml-1">{morosos.length}</Badge>
            </CardTitle>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Fração", "Proprietário", "Valor em dívida", "Acções"].map((h) => (
                    <th
                      key={h}
                      className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {morosos.map((m: any) => {
                  const quotas: any[] = m.quotas ?? [];
                  const quotaNaoPaga = quotas.find((q: any) => !q.pago);
                  const quotaPaga = quotas.find((q: any) => q.pago);
                  const quotaIdPagar = quotaNaoPaga?.id ?? null;
                  const quotaIdDesmarcar = quotaPaga?.id ?? null;
                  return (
                    <tr
                      key={m.fracao.id}
                      className="border-b hover:opacity-90 transition-opacity"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <td className="px-4 py-3">
                        <span
                          className="inline-flex items-center justify-center w-8 h-7 rounded text-xs font-bold"
                          style={{ background: "var(--blue-subtle)", color: "var(--blue-bright)" }}
                        >
                          {m.fracao.numero}
                        </span>
                      </td>
                      <td className="px-4 py-3" style={{ color: "var(--text-primary)" }}>
                        {m.fracao.proprietarioNome || "—"}
                      </td>
                      <td className="px-4 py-3 font-mono font-semibold" style={{ color: "var(--red)" }}>
                        {formatEuro(m.total)}
                      </td>
                      <td className="px-4 py-3">
                        {isAdmin && (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {quotaIdPagar && (
                              <button
                                className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
                                style={{ background: "var(--green-subtle)", color: "var(--green)" }}
                                onClick={() => {
                                  setMetodo("transferência");
                                  setPagarModal({ fracao: m.fracao, total: m.total, quotaId: quotaIdPagar });
                                }}
                              >
                                <CheckCircle2 size={12} />
                                Pagar
                              </button>
                            )}
                            {quotaIdDesmarcar && (
                              <button
                                className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
                                style={{ background: "var(--bg-elevated)", color: "var(--text-muted)" }}
                                onClick={() => onDesmarcar(quotaIdDesmarcar)}
                              >
                                <XCircle size={12} />
                                Desmarcar
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {isAdmin && (
        <Modal
          open={!!pagarModal}
          onClose={() => setPagarModal(null)}
          title="Registar pagamento"
          size="sm"
        >
          {pagarModal && (
            <div className="space-y-4">
              <div className="rounded-lg p-3" style={{ background: "var(--bg-elevated)" }}>
                <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  Fração {pagarModal.fracao?.numero} — {pagarModal.fracao?.proprietarioNome}
                </p>
                <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                  Valor em dívida · {formatEuro(pagarModal.total)}
                </p>
              </div>
              <Select
                label="Método de pagamento"
                options={METODOS_PAGAMENTO.filter((m) =>
                  ["transferência", "mbway", "numerário", "cheque"].includes(m.value)
                )}
                value={metodo}
                onChange={(e) => setMetodo(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setPagarModal(null)}>Cancelar</Button>
                <Button
                  onClick={() => {
                    onPagar(pagarModal.quotaId, metodo);
                    setPagarModal(null);
                  }}
                  loading={pagarLoading}
                >
                  <CheckCircle2 size={14} />
                  Confirmar Pagamento
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

// ─── Secção Extras ────────────────────────────────────────────────────────────
function SecaoExtras({
  dashData, extraTipos, extrasByTipo, extrasSemTipo, quotas, quotasFiltradas,
  pagas, nPagas, extraTipoFiltro, setExtraTipoFiltro, onNovaExtra,
  selecionadas, onPagar, onDesmarcar, onReassign, loading
}: any) {
  const isAdmin = useIsAdmin();
  const d = dashData;

  // Hardcoded extras do Excel
  const elevadores = d?.quotaExtra;
  const portao = d?.portaoGaragem;

  // Cards estáticos (elevadores + portão)
  const staticCards = [
    {
      id: "elevadores",
      nome: "Elevadores",
      descricao: "Quota extraordinária elevadores",
      saldo: elevadores?.saldoConta ?? 0,
      aReceber: elevadores?.aReceber ?? 0,
      morosos: elevadores?.morosos ?? [],
      color: "var(--blue-bright)",
    },
    {
      id: "portao",
      nome: "Portão Garagem",
      descricao: `Orçamento OR M/123 · ${formatEuro(portao?.totalOrcamento ?? 707.25)}`,
      saldo: portao?.pago ?? 0,
      aReceber: portao?.aReceber ?? 0,
      morosos: portao?.morosos ?? [],
      color: "var(--amber)",
    },
  ];

  const [staticFiltro, setStaticFiltro] = useState<string | null>(null);
  const selectedStatic = staticFiltro ? staticCards.find(c => c.id === staticFiltro) : null;

  // IDs de quota_tipos que já têm card hardcoded — não mostrar duplicados no DB
  const STATIC_TIPO_KEYWORDS = ["elevador", "elev", "portão", "portao", "motor"];
  const extrasByTipoFiltrado = extrasByTipo.filter((e: any) => {
    const nome = (e.tipo.nome || "").toLowerCase();
    const kw = (e.tipo.keywords || "").toLowerCase();
    return !STATIC_TIPO_KEYWORDS.some(k => nome.includes(k) || kw.includes(k));
  });

  if (loading) return <div className="text-sm" style={{ color: "var(--text-muted)" }}>A carregar...</div>;

  // Detalhe de um card estático
  if (selectedStatic) {
    return (
      <div className="space-y-4">
        <button
          className="flex items-center gap-1.5 text-sm hover:opacity-80 transition-opacity"
          style={{ color: "var(--text-muted)" }}
          onClick={() => setStaticFiltro(null)}
        >
          <ArrowLeft size={14} />
          Voltar às cotas extra
        </button>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <KpiCard
            label="Pago"
            value={formatEuro(selectedStatic.saldo)}
            color="var(--green)"
            icon={<CheckCircle2 size={15} />}
          />
          <KpiCard
            label="Por cobrar"
            value={formatEuro(selectedStatic.aReceber)}
            sub={`${selectedStatic.morosos.length} frações`}
            color="var(--red)"
            icon={<AlertCircle size={15} />}
          />
          <KpiCard
            label="Total emitido"
            value={formatEuro(selectedStatic.saldo + selectedStatic.aReceber)}
            color="var(--blue-bright)"
            icon={<Euro size={15} />}
          />
        </div>

        {selectedStatic.morosos.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 gap-2">
              <CheckCircle2 size={32} style={{ color: "var(--green)" }} />
              <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Sem morosos!</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                {selectedStatic.nome} — Frações em Dívida
                <Badge variant="red" className="ml-1">{selectedStatic.morosos.length}</Badge>
              </CardTitle>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Fração", "Proprietário", "Valor em dívida"].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {selectedStatic.morosos.map((m: any) => (
                    <tr key={m.fracao.id} className="border-b hover:opacity-90" style={{ borderColor: "var(--border)" }}>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center justify-center w-8 h-7 rounded text-xs font-bold" style={{ background: "var(--blue-subtle)", color: "var(--blue-bright)" }}>
                          {m.fracao.numero}
                        </span>
                      </td>
                      <td className="px-4 py-3" style={{ color: "var(--text-primary)" }}>{m.fracao.proprietarioNome || "—"}</td>
                      <td className="px-4 py-3 font-mono font-semibold" style={{ color: "var(--red)" }}>{formatEuro(m.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    );
  }

  // Vista principal: cartões
  return (
    <div className="space-y-4">
      {/* Cards estáticos (elevadores + portão) */}
      <div>
        <p className="text-xs font-medium mb-2 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          Cotas extra existentes
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {staticCards.map((card) => (
            <button
              key={card.id}
              onClick={() => setStaticFiltro(card.id)}
              className="text-left rounded-xl p-4 border transition-all hover:opacity-90"
              style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-md" style={{ background: "var(--bg-elevated)" }}>
                    <Tag size={14} style={{ color: card.color }} />
                  </div>
                  <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{card.nome}</span>
                </div>
                <Badge variant={card.aReceber > 0 ? "red" : "green"}>
                  {card.morosos.length} em dívida
                </Badge>
              </div>
              {card.descricao && (
                <p className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>{card.descricao}</p>
              )}
              <div className="flex items-center gap-3 text-xs font-mono">
                <span style={{ color: "var(--green)" }}>{formatEuro(card.saldo)} pago</span>
                <span style={{ color: "var(--text-muted)" }}>·</span>
                <span style={{ color: "var(--red)" }}>{formatEuro(card.aReceber)} em dívida</span>
              </div>
            </button>
          ))}

          {/* Cards do DB (novos tipos extra — sem duplicados dos hardcoded) */}
          {extrasByTipoFiltrado.map(({ tipo: t, items, pagos, total, totalPago }: any) => (
            <button
              key={t.id}
              onClick={() => setExtraTipoFiltro(extraTipoFiltro === t.id ? null : t.id)}
              className="text-left rounded-xl p-4 border transition-all hover:opacity-90"
              style={{
                background: extraTipoFiltro === t.id ? "var(--blue-subtle)" : "var(--bg-surface)",
                borderColor: extraTipoFiltro === t.id ? "var(--blue-bright)" : "var(--border)",
              }}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-md" style={{ background: "var(--bg-elevated)" }}>
                    <Tag size={14} style={{ color: "var(--blue-bright)" }} />
                  </div>
                  <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{t.nome}</span>
                </div>
                <Badge variant={pagos === items.length && items.length > 0 ? "green" : "amber"}>
                  {pagos}/{items.length}
                </Badge>
              </div>
              {t.descricao && (
                <p className="text-xs mb-2 line-clamp-1" style={{ color: "var(--text-muted)" }}>{t.descricao}</p>
              )}
              <div className="flex items-center gap-2 text-xs font-mono">
                <span style={{ color: "var(--green)" }}>{formatEuro(totalPago)}</span>
                <span style={{ color: "var(--text-muted)" }}>/ {formatEuro(total)}</span>
              </div>
              {items.length > 0 && (
                <div className="mt-2 h-1 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
                  <div className="h-full rounded-full" style={{ width: `${Math.round((totalPago / total) * 100)}%`, background: "var(--green)" }} />
                </div>
              )}
            </button>
          ))}

          {/* Sem categoria */}
          {extrasSemTipo.length > 0 && (
            <button
              onClick={() => setExtraTipoFiltro(extraTipoFiltro === "__none" ? null : "__none")}
              className="text-left rounded-xl p-4 border transition-all hover:opacity-90"
              style={{
                background: extraTipoFiltro === "__none" ? "var(--amber-subtle)" : "var(--bg-surface)",
                borderColor: extraTipoFiltro === "__none" ? "var(--amber)" : "var(--border)",
              }}
            >
              <div className="flex items-center gap-2 mb-2">
                <AlertCircle size={14} style={{ color: "var(--amber)" }} />
                <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Sem categoria</span>
              </div>
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>{extrasSemTipo.length} quota(s) sem tipo</p>
            </button>
          )}
        </div>
      </div>

      {/* Botão criar nova */}
      {extrasByTipoFiltrado.length === 0 && extrasSemTipo.length === 0 && (
        <div className="rounded-xl border-2 border-dashed flex flex-col items-center justify-center py-8 gap-2" style={{ borderColor: "var(--border)" }}>
          <Plus size={20} style={{ color: "var(--text-muted)" }} />
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>Adicionar nova cota extra ao sistema</p>
          {isAdmin && (
            <Button size="sm" variant="secondary" onClick={onNovaExtra}>
              <Plus size={13} />
              Nova Cota Extra
            </Button>
          )}
        </div>
      )}

      {/* Tabela DB extras (quando filtro ativo) */}
      {extraTipoFiltro && (
        <div className="space-y-3">
          <button
            className="flex items-center gap-1.5 text-sm hover:opacity-80 transition-opacity"
            style={{ color: "var(--text-muted)" }}
            onClick={() => setExtraTipoFiltro(null)}
          >
            <ArrowLeft size={14} />
            Voltar
          </button>

          {extraTipoFiltro && (
            <div className="grid grid-cols-3 gap-3">
              <SumCard label="Pagas" value={pagas.length} total={quotasFiltradas.length} color="var(--green)" />
              <SumCard label="Por pagar" value={nPagas.length} total={quotasFiltradas.length} color="var(--red)" />
              <SumCard label="Taxa cobrança" value={`${quotasFiltradas.length > 0 ? Math.round((pagas.length / quotasFiltradas.length) * 100) : 0}%`} color="var(--blue-bright)" noBar />
            </div>
          )}

          {quotasFiltradas.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 gap-2">
                <CreditCard size={32} style={{ color: "var(--text-muted)" }} />
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>Sem quotas desta categoria</p>
              </CardContent>
            </Card>
          ) : (
            <QuotasTable
              quotas={quotasFiltradas}
              tipo="extra"
              extrasByTipo={extrasByTipo}
              extraTipoFiltro={extraTipoFiltro}
              selecionadas={selecionadas}
              onPagar={onPagar}
              onDesmarcar={onDesmarcar}
              onReassign={onReassign}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tabela de quotas (reutilizável) ─────────────────────────────────────────
function QuotasTable({ quotas, tipo, extrasByTipo, extraTipoFiltro, selecionadas, onPagar, onDesmarcar, onReassign, fracoesNaoCategorizadas }: any) {
  const isAdmin = useIsAdmin();
  const naoCat: Set<string> = fracoesNaoCategorizadas ?? new Set();

  const estadoQuota = (q: any): { variant: "green" | "amber" | "red"; label: string } => {
    const fracaoNum = q.fracao?.numero as string | undefined;
    const porCategorizar = !!(fracaoNum && naoCat.has(fracaoNum));
    // Verde: pago e categorizado | Amber: recebido mas não categorizado | Vermelho: em atraso
    if (porCategorizar) return { variant: "amber", label: "Por categorizar" };
    if (q.quota.pago) return { variant: "green", label: "Pago" };
    return { variant: "red", label: "Por pagar" };
  };

  return (
    <Card>
      {extraTipoFiltro && extraTipoFiltro !== "__none" && (
        <div className="px-4 py-2 border-b flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
          <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {extrasByTipo.find((e: any) => e.tipo.id === extraTipoFiltro)?.tipo.nome}
          </span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {["Fração", "Proprietário", "Valor", "Estado", "Data pagamento", "Método", "Obs.", "Ações"].map((h) => (
                <th
                  key={h}
                  className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider"
                  style={{ color: "var(--text-muted)" }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {quotas.map((q: any) => {
              const estado = estadoQuota(q);
              return (
              <tr
                key={q.quota.id}
                className="border-b hover:opacity-90 transition-opacity"
                style={{
                  borderColor: "var(--border)",
                  background: selecionadas.has(q.quota.id) ? "var(--bg-elevated)" : "transparent",
                }}
              >
                <td className="px-4 py-3">
                  <span
                    className="inline-flex items-center justify-center w-8 h-7 rounded text-xs font-bold"
                    style={{ background: "var(--blue-subtle)", color: "var(--blue-bright)" }}
                  >
                    {q.fracao?.numero}
                  </span>
                </td>
                <td className="px-4 py-3" style={{ color: "var(--text-primary)" }}>
                  {q.fracao?.proprietarioNome || "—"}
                </td>
                <td className="px-4 py-3 font-mono font-medium" style={{ color: "var(--text-primary)" }}>
                  {formatEuro(q.quota.valor)}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={estado.variant}>
                    {estado.label}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: "var(--text-muted)" }}>
                  {q.quota.dataPagamento ? formatDate(q.quota.dataPagamento) : "—"}
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: "var(--text-muted)" }}>
                  {q.quota.metodoPagamento || "—"}
                </td>
                <td className="px-4 py-3 text-xs max-w-[180px] truncate" style={{ color: "var(--text-muted)" }}>
                  {q.quota.observacoes || "—"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {isAdmin && (
                      !q.quota.pago ? (
                        <button
                          className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
                          style={{ background: "var(--green-subtle)", color: "var(--green)" }}
                          onClick={() => onPagar(q)}
                        >
                          <CheckCircle2 size={12} />
                          Marcar pago
                        </button>
                      ) : (
                        <button
                          className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
                          style={{ background: "var(--bg-elevated)", color: "var(--text-muted)" }}
                          onClick={() => onDesmarcar(q.quota.id)}
                        >
                          <XCircle size={12} />
                          Desmarcar
                        </button>
                      )
                    )}
                    {tipo === "extra" && (
                      <button
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
                        style={{ background: "var(--bg-elevated)", color: "var(--text-muted)" }}
                        onClick={() => onReassign(q)}
                      >
                        <Tag size={11} />
                        Categoria
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Modal Nova Cota Extra (2 passos: tipo + frações) ───────────────────────
type FracaoExtraRow = {
  id: string;
  numero: string;
  proprietarioNome?: string | null;
};

function NovaExtraModal({
  open,
  onClose,
  onCreated,
  fracoes,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
  fracoes: FracaoExtraRow[];
}) {
  const agora = new Date();
  const mesActual = agora.getMonth() + 1;
  const anoActual = agora.getFullYear();

  const [step, setStep] = useState<1 | 2>(1);
  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [valorBase, setValorBase] = useState("");
  const [keywords, setKeywords] = useState("");
  const [fracoesSel, setFracoesSel] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");

  const valorNum = parseFloat(valorBase);
  const valorValido = Number.isFinite(valorNum) && valorNum > 0;
  const passo1Ok = nome.trim().length > 0 && valorValido;

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setNome("");
    setDescricao("");
    setValorBase("");
    setKeywords("");
    setFracoesSel(new Set());
    setErro("");
    setAviso("");
    setLoading(false);
  }, [open]);

  function toggleFracao(id: string) {
    setFracoesSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function seleccionarTodas() {
    setFracoesSel(new Set(fracoes.map((f) => f.id)));
  }

  async function criar() {
    if (!passo1Ok) {
      setErro("Preencha o nome e um valor por fração válido");
      setStep(1);
      return;
    }
    if (fracoesSel.size === 0) {
      setErro("Seleccione pelo menos uma fração");
      return;
    }

    setLoading(true);
    setErro("");
    setAviso("");

    let quotaTipoId: string | null = null;

    try {
      const tipoRes = await api["quota-tipos"].$post({
        json: {
          nome: nome.trim(),
          tipo: "extra",
          descricao: descricao.trim() || null,
          valorBase: valorNum,
          keywords: keywords.trim() || null,
          ativo: true,
        },
      });
      if (!tipoRes.ok) {
        const t = await tipoRes.json().catch(() => ({}));
        throw new Error((t as { message?: string; error?: string }).message || (t as { error?: string }).error || await tipoRes.text());
      }
      const tipo = await tipoRes.json() as { id: string };
      quotaTipoId = tipo.id;

      const quotasRes = await api.quotas["gerar-extra"].$post({
        json: {
          quotaTipoId,
          fracaoIds: Array.from(fracoesSel),
          valor: valorNum,
          nome: nome.trim(),
          mes: mesActual,
          ano: anoActual,
        },
      });

      if (!quotasRes.ok) {
        const t = await quotasRes.json().catch(() => ({}));
        throw new Error(
          (t as { error?: string; message?: string }).error || (t as { message?: string }).message || await quotasRes.text(),
        );
      }

      const data = await quotasRes.json() as { saltadas?: string[]; criadas?: number };
      if (data.saltadas?.length) {
        setAviso(`Tipo criado. ${data.criadas ?? 0} quota(s) novas; já existiam: ${data.saltadas.join(", ")}`);
      }
      await onCreated();
    } catch (e: any) {
      if (quotaTipoId) {
        setErro(
          `O tipo de cota foi criado (id ${quotaTipoId.slice(0, 8)}…), mas falhou ao gerar as quotas por fração: ${e.message}`,
        );
      } else {
        setErro(e.message || "Erro ao criar cota extra");
      }
    } finally {
      setLoading(false);
    }
  }

  const totalEuros = fracoesSel.size * (valorValido ? valorNum : 0);

  return (
    <Modal open={open} onClose={onClose} title="Nova Cota Extra" size="md">
      <div className="space-y-4">
        {/* Stepper */}
        <div className="flex items-center gap-2 text-xs">
          <span
            className="px-2 py-1 rounded font-medium"
            style={{
              background: step === 1 ? "var(--blue-subtle)" : "var(--bg-elevated)",
              color: step === 1 ? "var(--blue-bright)" : "var(--text-muted)",
            }}
          >
            1 Definir
          </span>
          <ChevronRight size={14} style={{ color: "var(--text-muted)" }} />
          <span
            className="px-2 py-1 rounded font-medium"
            style={{
              background: step === 2 ? "var(--blue-subtle)" : "var(--bg-elevated)",
              color: step === 2 ? "var(--blue-bright)" : "var(--text-muted)",
            }}
          >
            2 Frações
          </span>
        </div>

        {step === 1 && (
          <>
            <div
              className="rounded-lg p-3 text-xs"
              style={{ background: "var(--blue-subtle)", color: "var(--blue-bright)", border: "1px solid var(--blue-subtle)" }}
            >
              Define o tipo de cota extra e o valor unitário. No passo seguinte escolhes quais frações ficam obrigadas a pagar.
            </div>

            <Input
              label="Nome da cota extra *"
              placeholder="ex: Campainhas 2026"
              value={nome}
              onChange={(e: any) => setNome(e.target.value)}
            />

            <Input
              label="Descrição (opcional)"
              placeholder="ex: Arranjo das campainhas — Junho 2026"
              value={descricao}
              onChange={(e: any) => setDescricao(e.target.value)}
            />

            <Input
              label="Valor por fração (€) *"
              placeholder="ex: 47.50"
              type="number"
              min="0"
              step="0.01"
              value={valorBase}
              onChange={(e: any) => setValorBase(e.target.value)}
            />

            <Input
              label="Keywords para matching bancário (opcional)"
              placeholder="ex: CAMPAINHA, CAMPAINHAS"
              value={keywords}
              onChange={(e: any) => setKeywords(e.target.value)}
            />
            <p className="text-xs -mt-2" style={{ color: "var(--text-muted)" }}>
              Separar por vírgula. Usadas para detetar transferências relacionadas.
            </p>
          </>
        )}

        {step === 2 && (
          <>
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                Frações activas
              </label>
              <div className="flex gap-3">
                <button
                  type="button"
                  className="text-xs underline"
                  style={{ color: "var(--blue-bright)" }}
                  onClick={seleccionarTodas}
                >
                  Seleccionar todas
                </button>
                <button
                  type="button"
                  className="text-xs underline"
                  style={{ color: "var(--text-muted)" }}
                  onClick={() => setFracoesSel(new Set())}
                >
                  Limpar selecção
                </button>
              </div>
            </div>

            <div
              className="max-h-56 overflow-y-auto rounded-lg divide-y"
              style={{ border: "1px solid var(--border)", background: "var(--bg-elevated)" }}
            >
              {fracoes.length === 0 ? (
                <p className="text-xs p-4" style={{ color: "var(--text-muted)" }}>
                  A carregar frações…
                </p>
              ) : (
                fracoes.map((f) => {
                  const checked = fracoesSel.has(f.id);
                  return (
                    <label
                      key={f.id}
                      className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:opacity-90"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleFracao(f.id)}
                        className="rounded"
                      />
                      <span
                        className="inline-flex items-center justify-center min-w-[2rem] h-7 px-1 rounded text-xs font-bold shrink-0"
                        style={{ background: "var(--blue-subtle)", color: "var(--blue-bright)" }}
                      >
                        {f.numero}
                      </span>
                      <span className="text-sm truncate" style={{ color: "var(--text-primary)" }}>
                        {f.proprietarioNome || "—"}
                      </span>
                    </label>
                  );
                })
              )}
            </div>

            <div
              className="rounded-lg px-3 py-2 text-sm"
              style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}
            >
              <span style={{ color: "var(--text-muted)" }}>
                {fracoesSel.size === 1
                  ? "1 fração seleccionada"
                  : `${fracoesSel.size} frações seleccionadas`}
                {" · "}
              </span>
              <span className="font-mono font-semibold" style={{ color: "var(--text-primary)" }}>
                Total: {formatEuro(totalEuros)}
              </span>
              {valorValido && fracoesSel.size > 0 && (
                <span className="text-xs ml-1" style={{ color: "var(--text-muted)" }}>
                  ({fracoesSel.size} × {formatEuro(valorNum)})
                </span>
              )}
            </div>
          </>
        )}

        {aviso && (
          <p className="text-xs rounded-lg p-2" style={{ background: "var(--amber-subtle, var(--bg-elevated))", color: "var(--amber, var(--text-secondary))" }}>
            {aviso}
          </p>
        )}
        {erro && (
          <p className="text-xs" style={{ color: "var(--red)" }}>{erro}</p>
        )}

        <div className="flex justify-between gap-2 pt-1">
          <div>
            {step === 2 && (
              <Button variant="secondary" onClick={() => setStep(1)} disabled={loading}>
                <ChevronLeft size={14} />
                Anterior
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={loading}>
              Cancelar
            </Button>
            {step === 1 ? (
              <Button
                onClick={() => {
                  if (!passo1Ok) {
                    setErro("Nome e valor por fração são obrigatórios");
                    return;
                  }
                  setErro("");
                  setStep(2);
                }}
                disabled={!passo1Ok}
              >
                Seguinte
                <ChevronRight size={14} />
              </Button>
            ) : (
              <Button
                onClick={criar}
                loading={loading}
                disabled={loading || fracoesSel.size === 0 || !valorValido}
              >
                <Plus size={14} />
                Criar cota extra
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color, icon }: any) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</p>
          {icon && <span style={{ color }}>{icon}</span>}
        </div>
        <p className="text-xl font-semibold font-mono" style={{ color }}>{value}</p>
        {sub && <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{sub}</p>}
      </CardContent>
    </Card>
  );
}

function SumCard({ label, value, total, color, noBar }: any) {
  const pct = total && !noBar ? Math.round((value / total) * 100) : 0;
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>{label}</p>
        <p className="text-2xl font-semibold font-mono" style={{ color }}>
          {value}
        </p>
        {!noBar && (
          <div className="mt-2 h-1 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
