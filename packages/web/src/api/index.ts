import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { authMiddleware } from "./middleware/auth";
import { fracoes } from "./routes/fracoes";
import { quotas } from "./routes/quotas";
import { despesas } from "./routes/despesas";
import { fornecedores } from "./routes/fornecedores";
import { dashboard } from "./routes/dashboard";
import { seed } from "./routes/seed";
import { quotaTiposRoutes } from "./routes/quota-tipos";
import { portal } from "./routes/portal";
import { adminUsers } from "./routes/admin-users";
import { setup } from "./routes/setup";
import { importRoutes } from "./routes/import";
import { bankRoutes, runBankSync } from "./routes/bank";
import { bankMovementsRoutes } from "./routes/bank-movements";
import { recibosRoutes, scheduleRecibosCron } from "./routes/recibos";
import { configuracoesRoutes } from "./routes/configuracoes";
import { relatorioRoutes, scheduleRelatoriosCron } from "./routes/relatorio";
import { avisosRoutes, scheduleAvisosCron } from "./routes/avisos";
import { identityRoutes } from "./routes/identity";

// ─── Sync imediato no arranque do servidor ────────────────────────────────────
(async () => {
  try {
    console.log("[bank-startup] A sincronizar banco no arranque...");
    await runBankSync();
    console.log("[bank-startup] Sync concluído.");
  } catch (e) {
    console.error("[bank-startup] Erro no sync inicial:", e);
  }
})();

// ─── 2x daily bank sync (8:00 and 20:00) ─────────────────────────────────────
(function scheduleBankSync() {
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  function nextRun() {
    const now = new Date();
    const hours = [8, 20];
    const todayRuns = hours.map(h => {
      const d = new Date(now); d.setHours(h, 0, 0, 0); return d;
    });
    const next = todayRuns.find(d => d > now)
      ?? new Date(todayRuns[0].getTime() + 24 * 60 * 60 * 1000);
    return next.getTime() - now.getTime();
  }
  function scheduleNext() {
    const ms = nextRun();
    console.log(`[bank-cron] Próximo sync em ${Math.round(ms / 60000)} min`);
    setTimeout(async () => {
      try { await runBankSync(); } catch (e) { console.error("[bank-cron] Erro:", e); }
      scheduleNext();
    }, ms);
  }
  scheduleNext();
})();

// ─── Recibos cron (fim de mês) ────────────────────────────────────────────────
scheduleRecibosCron();

// ─── Relatório cron (último dia do mês às 23:00) ─────────────────────────────
scheduleRelatoriosCron();

// ─── Avisos cron (1º dia do mês às 08:00) ────────────────────────────────────
scheduleAvisosCron();

const app = new Hono()
  // CORS — must be before everything
  .use(cors({
    origin: (origin) => origin ?? "*",
    credentials: true,
    exposeHeaders: ["set-auth-token"],
  }))
  // Better Auth — mounted BEFORE basePath
  .on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
  // Session middleware on all API routes
  .use("/api/*", authMiddleware)
  .basePath("api")
  .get("/health", (c) => c.json({ status: "ok", app: "Gestão Condomínio" }, 200))
  .route("/fracoes", fracoes)
  .route("/quotas", quotas)
  .route("/despesas", despesas)
  .route("/fornecedores", fornecedores)
  .route("/dashboard", dashboard)
  .route("/seed", seed)
  .route("/quota-tipos", quotaTiposRoutes)
  .route("/portal", portal)
  .route("/admin/users", adminUsers)
  .route("/setup", setup)
  .route("/import", importRoutes)
  .route("/bank", bankRoutes)
  .route("/bank-movements", bankMovementsRoutes)
  // Alias para o redirect URI registado na Enable Banking
  .route("/sync/bank", bankRoutes)
  .route("/recibos", recibosRoutes)
  .route("/configuracoes", configuracoesRoutes)
  .route("/relatorio", relatorioRoutes)
  .route("/avisos", avisosRoutes)
  .route("/identity", identityRoutes);

export type AppType = typeof app;
export default app;
