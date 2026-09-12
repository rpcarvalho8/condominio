import { describe, expect, test } from "bun:test";
import {
  assertF3AuthenticatedRateLimit,
  F3_PUBLIC_RATE_MAX,
  resetF3PublicRateLimit,
} from "../application/invitation/public-rate-limit";
import { redactAdminContactOutboxPayload } from "../application/portal/f3-contact-admin";
import {
  assertTicketUploadContentLength,
  assertTicketUploadFileCount,
  TICKET_UPLOAD_MAX_CONTENT_LENGTH,
} from "../application/portal/f3-ticket-upload-guard";
import { DomainError } from "./errors";
import {
  assertTicketPhotoFile,
  isTicketCategoria,
  isTicketUrgencia,
  normalizeAdminContactBody,
  normalizeTicketTitulo,
  TICKET_PHOTO_MAX_BYTES,
  TICKET_PHOTO_MAX_FILES,
} from "./ticket";

describe("F3 ticket domain (piloto)", () => {
  test("categorias e urgências Fonte transplantadas, sem LLM", () => {
    expect(isTicketCategoria("manutencao")).toBe(true);
    expect(isTicketCategoria("crm")).toBe(false);
    expect(isTicketUrgencia("urgente")).toBe(true);
    expect(isTicketUrgencia("critica")).toBe(false);
  });

  test("foto: só imagem; rejeita vazio, PDF e oversized", () => {
    expect(() =>
      assertTicketPhotoFile({ filename: "fuga.jpg", mimeType: "image/jpeg", size: 1200 }),
    ).not.toThrow();
    expect(() =>
      assertTicketPhotoFile({ filename: "nota.pdf", mimeType: "application/pdf", size: 1200 }),
    ).toThrow(DomainError);
    expect(() =>
      assertTicketPhotoFile({ filename: "fuga.jpg", mimeType: "image/jpeg", size: 0 }),
    ).toThrow(DomainError);
    expect(() =>
      assertTicketPhotoFile({
        filename: "fuga.jpg",
        mimeType: "image/jpeg",
        size: TICKET_PHOTO_MAX_BYTES + 1,
      }),
    ).toThrow(DomainError);
  });

  test("título e mensagem de contacto não vazios", () => {
    expect(normalizeTicketTitulo("  Elevador  ")).toBe("Elevador");
    expect(() => normalizeTicketTitulo("   ")).toThrow(DomainError);
    expect(() => normalizeAdminContactBody("")).toThrow(DomainError);
  });

  test("Content-Length acima do tecto (max files × max bytes) → 413 sem ler body", () => {
    expect(() => assertTicketUploadContentLength(String(TICKET_UPLOAD_MAX_CONTENT_LENGTH + 1))).toThrow(
      DomainError,
    );
    try {
      assertTicketUploadContentLength(String(TICKET_UPLOAD_MAX_CONTENT_LENGTH + 50));
    } catch (err) {
      expect(err).toMatchObject({ code: "upload_too_large", httpStatus: 413 });
    }
    expect(() => assertTicketUploadContentLength(String(TICKET_UPLOAD_MAX_CONTENT_LENGTH))).not.toThrow();
    expect(() => assertTicketUploadContentLength(undefined)).not.toThrow();
    expect(() => assertTicketUploadFileCount(TICKET_PHOTO_MAX_FILES)).not.toThrow();
    expect(() => assertTicketUploadFileCount(TICKET_PHOTO_MAX_FILES + 1)).toThrow(DomainError);
  });

  test("rate limit autenticado: IP + user/membership + action → 429", () => {
    resetF3PublicRateLimit();
    const base = {
      ip: "203.0.113.40",
      userId: "user-rl",
      personId: "person-rl",
      membershipId: "mem-rl",
      action: "portal-tickets",
    };
    for (let i = 0; i < F3_PUBLIC_RATE_MAX; i++) {
      expect(() => assertF3AuthenticatedRateLimit(base)).not.toThrow();
    }
    try {
      assertF3AuthenticatedRateLimit(base);
      throw new Error("expected rate limit");
    } catch (err) {
      expect(err).toMatchObject({ code: "public_rate_limited", httpStatus: 429 });
    }
    expect(() =>
      assertF3AuthenticatedRateLimit({ ...base, userId: "other-user", personId: "other-person" }),
    ).not.toThrow();
    expect(() => assertF3AuthenticatedRateLimit({ ...base, action: "portal-contact-admin" })).not.toThrow();
  });

  test("outbox contact-admin redige body após complete (espelho invitation)", () => {
    const redacted = redactAdminContactOutboxPayload({
      contactId: "c1",
      fracaoId: "f1",
      subject: "Dúvida",
      body: "O extrato não bate com o que paguei.",
    });
    expect(redacted.body).toBe("[REDACTED]");
    expect(redacted.subject).toBe("Dúvida");
    expect(redacted.contactId).toBe("c1");
  });
});
