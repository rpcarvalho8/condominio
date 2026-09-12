import { describe, expect, test } from "bun:test";
import {
  generateOpaqueToken,
  generateVerificationCode,
  hashOpaqueSecret,
  INVITATION_CHANNELS,
  maskContact,
  OPAQUE_TOKEN_BYTES,
} from "./invitation";

describe("Invitation token / contacto", () => {
  test("token opaco tem entropia e não embute ids previsíveis", () => {
    const invitationId = crypto.randomUUID();
    const tenantId = "tenant-A";
    const token = generateOpaqueToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(token).not.toContain(invitationId);
    expect(token).not.toContain(tenantId);
    expect(token).not.toMatch(/^[0-9]+$/);
    const decoded = Buffer.from(token, "base64url");
    expect(decoded.length).toBe(OPAQUE_TOKEN_BYTES);
    const other = generateOpaqueToken();
    expect(other).not.toBe(token);
    expect(hashOpaqueSecret(token)).not.toBe(token);
    expect(hashOpaqueSecret(token)).toBe(hashOpaqueSecret(token));
  });

  test("máscara de contacto não revela o endereço completo", () => {
    expect(maskContact(INVITATION_CHANNELS.email, "maria@condo.pt")).toBe("m***@condo.pt");
    expect(maskContact(INVITATION_CHANNELS.sms, "912345678")).toBe("*****5678");
  });

  test("código de verificação tem 6 dígitos", () => {
    const code = generateVerificationCode();
    expect(code).toMatch(/^\d{6}$/);
  });
});
