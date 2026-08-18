import { useEffect, useState } from "react";
import { PageHeader } from "../components/Layout";
import { Plus, Trash2, Edit2, X, Check } from "lucide-react";
import { useIsAdmin } from "../lib/auth";

type QuotaTipo = {
  id: string;
  nome: string;
  tipo: string;
  descricao: string | null;
  keywords: string | null;
  valorBase: number | null;
  ativo: boolean;
  dataInicio: string | null;
  dataFim: string | null;
};

const token = () => localStorage.getItem("bm_token") ?? "";
const headers = () => ({ Authorization: `Bearer ${token()}`, "Content-Type": "application/json" });

const TIPO_LABELS: Record<string, string> = {
  condominio: "Condomínio",
  obras: "Obras",
  extra: "Extra",
  fundo_reserva: "Fundo Reserva",
};

const TIPO_COLORS: Record<string, string> = {
  condominio: "bg-blue-500/20 text-blue-300",
  obras: "bg-orange-500/20 text-orange-300",
  extra: "bg-purple-500/20 text-purple-300",
  fundo_reserva: "bg-green-500/20 text-green-300",
};

const emptyForm = { nome: "", tipo: "condominio", descricao: "", keywords: "", valorBase: "", ativo: true, dataInicio: "", dataFim: "" };

export default function QuotaTiposPage() {
  const isAdmin = useIsAdmin();
  const [tipos, setTipos] = useState<QuotaTipo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editTipo, setEditTipo] = useState<QuotaTipo | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    const res = await fetch("/api/quota-tipos", { headers: headers() });
    if (res.ok) setTipos(await res.json());
    setLoading(false);
  }

  function openCreate() {
    setForm(emptyForm);
    setEditTipo(null);
    setErro("");
    setShowModal(true);
  }

  function openEdit(t: QuotaTipo) {
    setForm({
      nome: t.nome,
      tipo: t.tipo,
      descricao: t.descricao ?? "",
      keywords: t.keywords ?? "",
      valorBase: t.valorBase?.toString() ?? "",
      ativo: t.ativo,
      dataInicio: t.dataInicio ? new Date(t.dataInicio).toISOString().split("T")[0] : "",
      dataFim: t.dataFim ? new Date(t.dataFim).toISOString().split("T")[0] : "",
    });
    setEditTipo(t);
    setErro("");
    setShowModal(true);
  }

  async function handleSave() {
    setSaving(true);
    setErro("");
    const payload = {
      nome: form.nome,
      tipo: form.tipo,
      descricao: form.descricao || null,
      keywords: form.keywords?.trim() || null,
      valorBase: form.valorBase ? parseFloat(form.valorBase) : null,
      ativo: form.ativo,
      dataInicio: form.dataInicio || null,
      dataFim: form.dataFim || null,
    };
    const url = editTipo ? `/api/quota-tipos/${editTipo.id}` : "/api/quota-tipos";
    const method = editTipo ? "PUT" : "POST";
    const res = await fetch(url, { method, headers: headers(), body: JSON.stringify(payload) });
    if (!res.ok) {
      let msg = "";
      try {
        const body = await res.json();
        msg = body.message || body.error || JSON.stringify(body);
      } catch {
        msg = await res.text();
      }
      setErro(`Erro ${res.status}: ${msg || res.statusText}`);
      setSaving(false);
      return;
    }
    setShowModal(false);
    setSaving(false);
    await loadData();
  }

  async function handleDelete(id: string) {
    if (!confirm("Eliminar tipo de quota?")) return;
    await fetch(`/api/quota-tipos/${id}`, { method: "DELETE", headers: headers() });
    await loadData();
  }

  return (
    <div>
      <PageHeader
        title="Tipos de Quota"
        subtitle="Gestão das categorias de quota"
        breadcrumb={["Administração", "Tipos de Quota"]}
        actions={isAdmin ? (
          <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition"
            style={{ background: "var(--blue-primary)" }}>
            <Plus size={16} /> Novo Tipo
          </button>
        ) : undefined}
      />

      <div className="p-6">
        <div className="mb-4 p-4 rounded-xl border text-sm" style={{ background: "var(--bg-surface)", borderColor: "var(--border)", color: "var(--text-secondary)" }}>
          <strong className="font-medium" style={{ color: "var(--text-primary)" }}>Nota:</strong>{" "}
          O <em>Fundo de Reserva</em> (10% da quota de condomínio) é calculado automaticamente conforme a lei portuguesa. 
          Não precisa de ser criado manualmente.
        </div>

        {loading ? (
          <div className="text-center py-12" style={{ color: "var(--text-muted)" }}>A carregar...</div>
        ) : (
          <div className="grid gap-4">
            {tipos.length === 0 ? (
              <div className="text-center py-12 rounded-xl border" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
                Nenhum tipo de quota criado
              </div>
            ) : (
              tipos.map(t => (
                <div key={t.id} className="rounded-xl border p-4 flex items-center justify-between"
                  style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}>
                  <div className="flex items-center gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm" style={{ color: "var(--text-primary)" }}>{t.nome}</span>
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${TIPO_COLORS[t.tipo] ?? "bg-gray-500/20 text-gray-300"}`}>
                          {TIPO_LABELS[t.tipo] ?? t.tipo}
                        </span>
                        {!t.ativo && (
                          <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-500/20 text-red-300">Inativo</span>
                        )}
                      </div>
                      {t.descricao && (
                        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{t.descricao}</p>
                      )}
                      <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                        {t.valorBase != null && <span>Valor base: {t.valorBase.toLocaleString("pt-PT", { style: "currency", currency: "EUR" })}</span>}
                        {t.dataInicio && <span>De: {new Date(t.dataInicio).toLocaleDateString("pt-PT")}</span>}
                        {t.dataFim && <span>Até: {new Date(t.dataFim).toLocaleDateString("pt-PT")}</span>}
                      </div>
                    </div>
                  </div>
                  {isAdmin && (
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEdit(t)} className="p-1.5 rounded hover:opacity-70 transition" style={{ color: "var(--text-muted)" }}>
                        <Edit2 size={14} />
                      </button>
                      <button onClick={() => handleDelete(t.id)} className="p-1.5 rounded hover:opacity-70 transition text-red-400">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md rounded-2xl border p-6 space-y-4"
            style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}>
            <div className="flex items-center justify-between">
              <h2 className="font-semibold" style={{ color: "var(--text-primary)" }}>
                {editTipo ? "Editar Tipo" : "Novo Tipo de Quota"}
              </h2>
              <button onClick={() => setShowModal(false)} style={{ color: "var(--text-muted)" }}><X size={18} /></button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: "var(--text-muted)" }}>Nome</label>
                <input value={form.nome} onChange={e => setForm(f => ({ ...f, nome: e.target.value }))}
                  placeholder="Ex: Quota Mensal Condomínio"
                  className="w-full rounded-lg px-3 py-2 text-sm border"
                  style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }} />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: "var(--text-muted)" }}>Tipo</label>
                <select value={form.tipo} onChange={e => setForm(f => ({ ...f, tipo: e.target.value }))}
                  className="w-full rounded-lg px-3 py-2 text-sm border"
                  style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }}>
                  {Object.entries(TIPO_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: "var(--text-muted)" }}>Descrição (opcional)</label>
                <input value={form.descricao} onChange={e => setForm(f => ({ ...f, descricao: e.target.value }))}
                  className="w-full rounded-lg px-3 py-2 text-sm border"
                  style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }} />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: "var(--text-muted)" }}>Valor Base (€, opcional)</label>
                <input type="number" step="0.01" value={form.valorBase} onChange={e => setForm(f => ({ ...f, valorBase: e.target.value }))}
                  className="w-full rounded-lg px-3 py-2 text-sm border"
                  style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }} />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: "var(--text-muted)" }}>Keywords para matching bancário</label>
                <input
                  value={form.keywords}
                  onChange={e => setForm(f => ({ ...f, keywords: e.target.value }))}
                  placeholder="ex: CAMPAINHAS, CAMPAINHA 2026"
                  className="w-full rounded-lg px-3 py-2 text-sm border"
                  style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }}
                />
                <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Separar por vírgula</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium mb-1 block" style={{ color: "var(--text-muted)" }}>Data início</label>
                  <input type="date" value={form.dataInicio} onChange={e => setForm(f => ({ ...f, dataInicio: e.target.value }))}
                    className="w-full rounded-lg px-3 py-2 text-sm border"
                    style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }} />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block" style={{ color: "var(--text-muted)" }}>Data fim</label>
                  <input type="date" value={form.dataFim} onChange={e => setForm(f => ({ ...f, dataFim: e.target.value }))}
                    className="w-full rounded-lg px-3 py-2 text-sm border"
                    style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }} />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: "var(--text-secondary)" }}>
                <input type="checkbox" checked={form.ativo} onChange={e => setForm(f => ({ ...f, ativo: e.target.checked }))} />
                Ativo
              </label>
            </div>

            {erro && (
              <p className="text-xs rounded-lg px-3 py-2" style={{ background: "var(--red-subtle)", color: "var(--red)" }}>
                {erro}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 rounded-lg text-sm border transition"
                style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}>Cancelar</button>
              <button onClick={handleSave} disabled={saving}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition disabled:opacity-50 flex items-center gap-2"
                style={{ background: "var(--blue-primary)" }}>
                <Check size={14} /> {saving ? "A guardar..." : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
