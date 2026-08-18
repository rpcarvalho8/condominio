import { useEffect, useState } from "react";
import { PageHeader } from "../components/Layout";
import { Plus, Trash2, Edit2, X, Check } from "lucide-react";

type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  fracaoId: string | null;
  createdAt: string;
};

type Fracao = {
  id: string;
  numero: string;
  andar: number | null;
  proprietarioNome: string | null;
};

const token = () => localStorage.getItem("bm_token") ?? "";
const headers = () => ({ Authorization: `Bearer ${token()}`, "Content-Type": "application/json" });

export default function UtilizadoresPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [fracoes, setFracoes] = useState<Fracao[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "condómino", fracaoId: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(""), 5000);
    return () => clearTimeout(t);
  }, [success]);

  async function loadData() {
    try {
      const [usersRes, fracoesRes] = await Promise.all([
        fetch("/api/admin/users", { headers: headers() }),
        fetch("/api/fracoes", { headers: headers() }),
      ]);
      if (usersRes.ok) setUsers(await usersRes.json());
      if (fracoesRes.ok) {
        const data = await fracoesRes.json();
        // API returns { fracoes: [...] }
        setFracoes(Array.isArray(data) ? data : (data.fracoes ?? []));
      }
    } catch (e) {
      console.error("Erro ao carregar dados:", e);
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setForm({ name: "", email: "", password: "", role: "condómino", fracaoId: "" });
    setEditUser(null);
    setError("");
    setShowModal(true);
  }

  function openEdit(u: User) {
    setForm({ name: u.name, email: u.email, password: "", role: u.role, fracaoId: u.fracaoId ?? "" });
    setEditUser(u);
    setError("");
    setShowModal(true);
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      if (editUser) {
        const res = await fetch(`/api/admin/users/${editUser.id}`, {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ name: form.name, role: form.role, fracaoId: form.fracaoId || null }),
        });
        if (!res.ok) throw new Error("Erro ao atualizar");
        setSuccess(`Utilizador "${form.name}" atualizado com sucesso.`);
      } else {
        if (!form.password) { setError("Password obrigatória"); setSaving(false); return; }
        const res = await fetch("/api/admin/users", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ ...form, fracaoId: form.fracaoId || null }),
        });
        if (!res.ok) {
          const d = await res.json();
          throw new Error(d.message ?? "Erro ao criar");
        }
        const fracaoLabel = form.role === "condómino" && form.fracaoId
          ? fracoes.find(f => f.id === form.fracaoId)
          : null;
        setSuccess(
          fracaoLabel
            ? `Utilizador "${form.name}" criado com sucesso (Fração ${fracaoLabel.numero}).`
            : `Utilizador "${form.name}" criado com sucesso.`
        );
      }
      setShowModal(false);
      await loadData();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Eliminar utilizador?")) return;
    await fetch(`/api/admin/users/${id}`, { method: "DELETE", headers: headers() });
    await loadData();
  }

  const fracoesMap = Object.fromEntries(fracoes.map(f => [f.id, f]));

  return (
    <div>
      <PageHeader
        title="Utilizadores"
        subtitle="Gestão de acesso ao portal"
        breadcrumb={["Administração", "Utilizadores"]}
        actions={
          <button
            onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition"
            style={{ background: "var(--blue-primary)" }}
          >
            <Plus size={16} /> Novo Utilizador
          </button>
        }
      />

      <div className="p-6">
        {success && (
          <div
            className="mb-4 text-sm rounded-lg px-3 py-2 flex items-center gap-2"
            style={{ background: "var(--green-subtle)", border: "1px solid var(--green)", color: "var(--green)" }}
          >
            <Check size={14} />
            {success}
          </div>
        )}
        {loading ? (
          <div className="text-center py-12" style={{ color: "var(--text-muted)" }}>A carregar...</div>
        ) : (
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)", background: "var(--bg-surface)" }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Nome", "Email", "Perfil", "Fração", "Criado em", ""].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider"
                      style={{ color: "var(--text-muted)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} style={{ borderBottom: "1px solid var(--border)" }}
                    className="hover:opacity-80 transition">
                    <td className="px-4 py-3 font-medium" style={{ color: "var(--text-primary)" }}>{u.name}</td>
                    <td className="px-4 py-3" style={{ color: "var(--text-secondary)" }}>{u.email}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${u.role === "admin" ? "bg-blue-500/20 text-blue-300" : "bg-gray-700/50 text-gray-300"}`}>
                        {u.role === "admin" ? "Admin" : "Condómino"}
                      </span>
                    </td>
                    <td className="px-4 py-3" style={{ color: "var(--text-secondary)" }}>
                      {u.fracaoId && fracoesMap[u.fracaoId]
                        ? `Fração ${fracoesMap[u.fracaoId].numero}`
                        : <span style={{ color: "var(--text-muted)" }}>—</span>}
                    </td>
                    <td className="px-4 py-3" style={{ color: "var(--text-muted)" }}>
                      {new Date(u.createdAt).toLocaleDateString("pt-PT")}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 justify-end">
                        <button onClick={() => openEdit(u)} className="p-1.5 rounded hover:opacity-70 transition"
                          style={{ color: "var(--text-muted)" }}>
                          <Edit2 size={14} />
                        </button>
                        <button onClick={() => handleDelete(u.id)} className="p-1.5 rounded hover:opacity-70 transition text-red-400">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-12 text-center" style={{ color: "var(--text-muted)" }}>
                    Nenhum utilizador criado ainda
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md rounded-2xl border p-6 space-y-4"
            style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}>
            <div className="flex items-center justify-between">
              <h2 className="font-semibold" style={{ color: "var(--text-primary)" }}>
                {editUser ? "Editar Utilizador" : "Novo Utilizador"}
              </h2>
              <button onClick={() => setShowModal(false)} style={{ color: "var(--text-muted)" }}>
                <X size={18} />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: "var(--text-muted)" }}>Nome</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full rounded-lg px-3 py-2 text-sm border"
                  style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }} />
              </div>
              {!editUser && (
                <>
                  <div>
                    <label className="text-xs font-medium mb-1 block" style={{ color: "var(--text-muted)" }}>Email</label>
                    <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                      className="w-full rounded-lg px-3 py-2 text-sm border"
                      style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }} />
                  </div>
                  <div>
                    <label className="text-xs font-medium mb-1 block" style={{ color: "var(--text-muted)" }}>Password</label>
                    <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                      className="w-full rounded-lg px-3 py-2 text-sm border"
                      style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }} />
                  </div>
                </>
              )}
              <div>
                <label className="text-xs font-medium mb-1 block" style={{ color: "var(--text-muted)" }}>Perfil</label>
                <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                  className="w-full rounded-lg px-3 py-2 text-sm border"
                  style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }}>
                  <option value="condómino">Condómino</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              {form.role === "condómino" && (
                <div>
                  <label className="text-xs font-medium mb-1 block" style={{ color: "var(--text-muted)" }}>Fração</label>
                  <select value={form.fracaoId} onChange={e => setForm(f => ({ ...f, fracaoId: e.target.value }))}
                    className="w-full rounded-lg px-3 py-2 text-sm border"
                    style={{ background: "var(--bg-elevated)", borderColor: "var(--border)", color: "var(--text-primary)" }}>
                    <option value="">— Sem fração —</option>
                    {fracoes.map(f => (
                      <option key={f.id} value={f.id}>
                        Fração {f.numero}{f.proprietarioNome ? ` — ${f.proprietarioNome}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {error && (
              <div className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 rounded-lg text-sm border transition"
                style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}>
                Cancelar
              </button>
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
