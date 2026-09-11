import { describe, expect, test } from "bun:test";
import { DomainError } from "../../domain/errors";
import {
  assertF1UploadContentLength,
  assertF1UploadFile,
  F1_MAX_UPLOAD_BYTES,
  isAllowedF1UploadType,
} from "./f1-upload-guard";

describe("F1 upload size + type guard", () => {
  test("rejects Content-Length above the hard max before body read", () => {
    expect(() => assertF1UploadContentLength(String(F1_MAX_UPLOAD_BYTES + 1))).toThrow(
      DomainError,
    );
    try {
      assertF1UploadContentLength(String(F1_MAX_UPLOAD_BYTES + 50));
    } catch (err) {
      expect(err).toMatchObject({ code: "upload_too_large", httpStatus: 400 });
    }
    expect(() => assertF1UploadContentLength(String(F1_MAX_UPLOAD_BYTES))).not.toThrow();
    expect(() => assertF1UploadContentLength(undefined)).not.toThrow();
  });

  test("allowlist accepts csv/xlsx/xls/txt by extension or MIME", () => {
    expect(isAllowedF1UploadType("fracoes.csv", "application/octet-stream")).toBe(true);
    expect(isAllowedF1UploadType("mapa.XLSX", "")).toBe(true);
    expect(isAllowedF1UploadType("legacy.xls")).toBe(true);
    expect(isAllowedF1UploadType("notas.txt", "text/plain")).toBe(true);
    expect(isAllowedF1UploadType("sem-extensao", "text/csv")).toBe(true);
    expect(isAllowedF1UploadType("sem-extensao", "application/vnd.ms-excel")).toBe(true);
  });

  test("allowlist rejects pdf/foto/binários", () => {
    expect(isAllowedF1UploadType("regulamento.pdf", "application/pdf")).toBe(false);
    expect(isAllowedF1UploadType("foto.png", "image/png")).toBe(false);
    expect(isAllowedF1UploadType("payload.exe", "application/octet-stream")).toBe(false);
    expect(isAllowedF1UploadType("notes.bin")).toBe(false);
  });

  test("assertF1UploadFile enforces size and type with HTTP 400", () => {
    expect(() =>
      assertF1UploadFile({ filename: "ok.csv", mimeType: "text/csv", size: 12 }),
    ).not.toThrow();

    try {
      assertF1UploadFile({
        filename: "huge.csv",
        mimeType: "text/csv",
        size: F1_MAX_UPLOAD_BYTES + 1,
      });
      throw new Error("expected size rejection");
    } catch (err) {
      expect(err).toMatchObject({ code: "upload_too_large", httpStatus: 400 });
    }

    try {
      assertF1UploadFile({ filename: "x.pdf", mimeType: "application/pdf", size: 100 });
      throw new Error("expected type rejection");
    } catch (err) {
      expect(err).toMatchObject({ code: "unsupported_type", httpStatus: 400 });
    }

    try {
      assertF1UploadFile({ filename: "empty.csv", mimeType: "text/csv", size: 0 });
      throw new Error("expected empty rejection");
    } catch (err) {
      expect(err).toMatchObject({ code: "empty_file", httpStatus: 400 });
    }
  });
});
