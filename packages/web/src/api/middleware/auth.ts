import { createMiddleware } from "hono/factory";
import { isLegacyAdminRole } from "../application/auth/legacy-user-role-adapter";
import { auth } from "../auth";

export const authMiddleware = createMiddleware(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("user", session?.user ?? null);
  c.set("session", session?.session ?? null);
  return next();
});

export const requireAuth = createMiddleware(async (c, next) => {
  if (!c.get("user")) return c.json({ message: "Não autenticado" }, 401);
  return next();
});

/** LEGACY Fonte: reads user.role via adapter. New kernel paths use Membership. */
export const requireAdmin = createMiddleware(async (c, next) => {
  const user = c.get("user") as { role?: string } | null;
  if (!user) return c.json({ message: "Não autenticado" }, 401);
  if (!isLegacyAdminRole(user)) return c.json({ message: "Acesso negado" }, 403);
  return next();
});
