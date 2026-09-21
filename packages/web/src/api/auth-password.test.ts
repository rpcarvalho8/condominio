import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { randomBytes, scrypt } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt);

describe("admin password hashing", () => {
  test("admin123 verifica com hash better-auth (create-admin)", async () => {
    const hash = await hashPassword("admin123");
    expect(hash.includes(":")).toBe(true);
    expect(await verifyPassword({ hash, password: "admin123" })).toBe(true);
    expect(await verifyPassword({ hash, password: "wrong" })).toBe(false);
  });

  test("hash legado setup-local (hex.salt) não autentica no better-auth", async () => {
    const salt = randomBytes(16).toString("hex");
    const buf = (await scryptAsync("admin123", salt, 64)) as Buffer;
    const legacy = `${buf.toString("hex")}.${salt}`;
    await expect(verifyPassword({ hash: legacy, password: "admin123" })).rejects.toThrow(
      /Invalid password hash/,
    );
  });
});
