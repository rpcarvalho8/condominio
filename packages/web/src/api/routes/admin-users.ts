import { Hono } from "hono";
import { db } from "../database";
import { user as userTable, fracoes } from "../database/schema";
import { eq, sql } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth";
import { auth } from "../auth";

export const adminUsers = new Hono()
  .use(requireAdmin)
  // List all users (condóminos + admins)
  .get("/", async (c) => {
    const users = await db.select({
      id: userTable.id,
      name: userTable.name,
      email: userTable.email,
      role: userTable.role,
      fracaoId: userTable.fracaoId,
      createdAt: userTable.createdAt,
    }).from(userTable).orderBy(userTable.name);
    return c.json(users);
  })
  // Create condómino user (admin only)
  .post("/", async (c) => {
    try {
      const body = await c.req.json();

      if (!body.email || !body.password || !body.name) {
        return c.json({ message: "name, email e password são obrigatórios" }, 400);
      }

      const email = String(body.email).trim().toLowerCase();

      const [existing] = await db
        .select({ id: userTable.id })
        .from(userTable)
        .where(sql`lower(${userTable.email}) = ${email}`)
        .limit(1);

      if (existing) {
        return c.json({ message: "Já existe um utilizador com este email" }, 409);
      }

      const result = await auth.api.signUpEmail({
        body: {
          email,
          password: body.password,
          name: body.name,
        },
        headers: c.req.raw.headers,
      });

      if (!result?.user) return c.json({ message: "Erro ao criar utilizador" }, 400);

      await db.update(userTable)
        .set({ role: body.role ?? "condómino", fracaoId: body.fracaoId ?? null })
        .where(eq(userTable.id, result.user.id));

      return c.json({ ok: true, userId: result.user.id }, 201);
    } catch (err) {
      console.error("POST /admin/users error:", err);
      const raw = err instanceof Error ? err.message : "Erro interno ao criar utilizador";
      if (/already|unique|duplicate|exists/i.test(raw)) {
        return c.json({ message: "Já existe um utilizador com este email" }, 409);
      }
      return c.json({ message: raw }, 500);
    }
  })
  // Update user (role, fracaoId)
  .put("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const [updated] = await db.update(userTable)
      .set({
        name: body.name,
        role: body.role,
        fracaoId: body.fracaoId ?? null,
      })
      .where(eq(userTable.id, id))
      .returning();
    return c.json(updated);
  })
  // Delete user
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    await db.delete(userTable).where(eq(userTable.id, id));
    return c.json({ ok: true });
  });
