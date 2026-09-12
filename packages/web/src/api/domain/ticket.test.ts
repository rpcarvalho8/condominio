import { describe, expect, test } from "bun:test";
import { DomainError } from "./errors";
import {
  assertTicketPhotoFile,
  isTicketCategoria,
  isTicketUrgencia,
  normalizeAdminContactBody,
  normalizeTicketTitulo,
  TICKET_PHOTO_MAX_BYTES,
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
});
