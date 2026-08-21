import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Building2,
  CreditCard,
  Receipt,
  TrendingDown,
  Users,
  AlertCircle,
  Settings,
  ChevronRight,
  LogOut,
  UserCog,
  Tag,
  DatabaseZap,
  Home,
  FileText,
  Landmark,
  Mic,
} from "lucide-react";
import { cn } from "../lib/utils";
import { authClient, clearToken, getToken, useIsAdmin } from "../lib/auth";
import { useQuery } from "@tanstack/react-query";
import { RecordingBar } from "./RecordingBar";
import { RecordingProvider } from "../lib/RecordingContext";

const NAV_ITEMS = [
  { href: "/", label: "Visão Geral", icon: LayoutDashboard },
  { href: "/fracoes", label: "Frações", icon: Building2 },
  { href: "/quotas", label: "Quotas", icon: CreditCard },
  { href: "/morosos", label: "Morosos", icon: AlertCircle, badge: true },
  { href: "/despesas", label: "Despesas", icon: TrendingDown },
  { href: "/fornecedores", label: "Fornecedores", icon: Users },
  { href: "/recibos", label: "Recibos", icon: Receipt },
  { href: "/relatorios", label: "Relatórios", icon: FileText },
  { href: "/movimentos-bancarios", label: "Movimentos Bancários", icon: Landmark },
];

const ADMIN_ITEMS = [
  { href: "/atas", label: "Atas", icon: FileText },
  { href: "/reunioes", label: "Reuniões", icon: Mic },
  { href: "/utilizadores", label: "Utilizadores", icon: UserCog },
  { href: "/quota-tipos", label: "Tipos de Quota", icon: Tag },
  { href: "/importar", label: "Importar Dados", icon: DatabaseZap },
  { href: "/definicoes", label: "Definições", icon: Settings },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const { data: session } = authClient.useSession();
  const isAdmin = useIsAdmin();

  const { data: morososData } = useQuery<{ count: number }>({
    queryKey: ["morosos-count"],
    queryFn: () =>
      fetch("/api/dashboard/morosos-count", {
        credentials: "include",
        headers: (() => {
          const token = getToken();
          return token ? { Authorization: `Bearer ${token}` } : {};
        })(),
      }).then((r) => r.json()),
    staleTime: 0, // badge deve reflectir pagamentos imediatamente após invalidate
  });
  const morososCount = morososData?.count ?? null;

  async function handleLogout() {
    await authClient.signOut();
    clearToken();
    navigate("/login");
  }

  return (
    <RecordingProvider>
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-base)" }}>
      {/* Sidebar */}
      <aside
        className="flex flex-col w-64 shrink-0 border-r"
        style={{ background: "var(--bg-surface)", borderColor: "var(--border)" }}
      >
        {/* Logo / Condomínio */}
        <div
          className="px-5 py-5 border-b"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex items-center gap-3 mb-3">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "linear-gradient(135deg, var(--blue-primary), #7c3aed)" }}
            >
              <Home size={17} color="white" />
            </div>
            <div>
              <div className="text-sm font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
                Gestão Condomínio
              </div>
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                Urb. da Fonte
              </div>
            </div>
          </div>
          {/* Badge morosos rápido */}
          {morososCount != null && morososCount > 0 && (
            <Link href="/morosos">
              <div
                className="flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer hover:opacity-80 transition-opacity"
                style={{ background: "var(--red-subtle)" }}
              >
                <div className="flex items-center gap-2">
                  <AlertCircle size={12} style={{ color: "var(--red)" }} />
                  <span className="text-xs" style={{ color: "var(--red)" }}>Frações em atraso</span>
                </div>
                <span className="text-xs font-mono font-bold" style={{ color: "var(--red)" }}>
                  {morososCount}
                </span>
              </div>
            </Link>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 py-4 px-3 space-y-0.5 overflow-y-auto">
          <div className="px-2 pb-2">
            <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>
              Principal
            </span>
          </div>
          {NAV_ITEMS.map(({ href, label, icon: Icon, badge }) => {
            const active = href === "/" ? location === "/" : location.startsWith(href);
            return (
              <Link key={href} href={href}>
                <div
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm cursor-pointer transition-all duration-150 group relative",
                    active ? "font-semibold" : "hover:opacity-80"
                  )}
                  style={{
                    background: active ? "var(--bg-elevated)" : "transparent",
                    color: active ? "var(--text-primary)" : "var(--text-secondary)",
                    borderLeft: active ? "2px solid var(--blue-primary)" : "2px solid transparent",
                  }}
                >
                  <Icon size={16} />
                  <span className="flex-1">{label}</span>
                  {badge && morososCount != null && morososCount > 0 && (
                    <span
                      className="text-xs px-1.5 py-0.5 rounded-full font-mono font-semibold"
                      style={{ background: "var(--red-subtle)", color: "var(--red)" }}
                    >
                      {morososCount}
                    </span>
                  )}
                </div>
              </Link>
            );
          })}

          <div className="px-2 pt-5 pb-2">
            <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>
              Administração
            </span>
          </div>
          {ADMIN_ITEMS.filter(({ href }) => href !== "/utilizadores" || isAdmin).map(({ href, label, icon: Icon }) => {
            const active = location.startsWith(href);
            return (
              <Link key={href} href={href}>
                <div
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm cursor-pointer transition-all duration-150 relative",
                    active ? "font-semibold" : "hover:opacity-80"
                  )}
                  style={{
                    background: active ? "var(--bg-elevated)" : "transparent",
                    color: active ? "var(--text-primary)" : "var(--text-secondary)",
                    borderLeft: active ? "2px solid var(--blue-primary)" : "2px solid transparent",
                  }}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div
          className="px-4 py-3 border-t"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <div className="text-xs font-medium truncate" style={{ color: "var(--text-secondary)" }}>
                {session?.user?.name ?? "Admin"}
              </div>
              <div className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
                {session?.user?.email ?? ""}
              </div>
            </div>
            <button
              onClick={handleLogout}
              title="Terminar sessão"
              className="p-1.5 rounded-lg hover:opacity-70 transition ml-2 shrink-0"
              style={{ color: "var(--text-muted)", background: "var(--bg-elevated)" }}
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto pb-24">
        {children}
      </main>
      <RecordingBar />
    </div>
    </RecordingProvider>
  );
}

// Page header component
export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  breadcrumb?: string[];
}) {
  return (
    <div
      className="sticky top-0 z-10 px-6 py-4 border-b flex items-center justify-between"
      style={{
        background: "var(--bg-base)",
        borderColor: "var(--border)",
        backdropFilter: "blur(8px)",
      }}
    >
      <div>
        {breadcrumb && (
          <div className="flex items-center gap-1.5 mb-1">
            {breadcrumb.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <ChevronRight size={12} style={{ color: "var(--text-muted)" }} />}
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>{crumb}</span>
              </span>
            ))}
          </div>
        )}
        <h1 className="text-lg font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm mt-0.5" style={{ color: "var(--text-secondary)" }}>{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
