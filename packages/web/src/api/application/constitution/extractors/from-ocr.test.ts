import { describe, expect, test } from "bun:test";
import { DomainError } from "../../../domain/errors";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertExtractionStrongEnough,
  createOcrProviderFromEnv,
  createStubOcrProvider,
  extractEmbeddedTextFromBytes,
  extractIngestTextFromBytes,
  extractPdfTextLayer,
  extractStructuredFromVisual,
} from "./from-ocr";
import { extractContactosFromPlainText } from "./from-text";
import { extractStructuredFromBytes } from "./structured-extractor";

function fakePdf(text: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\nBT (${text}) Tj ET\nendobj\n${text}\n%%EOF\n`,
    "utf8",
  );
}

function fakeJpeg(text: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
    Buffer.from(`\n${text}\n`, "utf8"),
    Buffer.from([0xff, 0xd9]),
  ]);
}

describe("F1 OCR stub (deterministic, no API key)", () => {
  test("provider from env without endpoint is the stub", () => {
    const prev = process.env.F1_OCR_ENDPOINT;
    delete process.env.F1_OCR_ENDPOINT;
    try {
      expect(createOcrProviderFromEnv().name).toBe("stub");
    } finally {
      if (prev === undefined) delete process.env.F1_OCR_ENDPOINT;
      else process.env.F1_OCR_ENDPOINT = prev;
    }
  });

  test("embedded text is recovered from a fake PDF and JPEG", () => {
    const sample = "Fração A — 600‰";
    expect(extractEmbeddedTextFromBytes(fakePdf(sample))).toContain("600‰");
    expect(extractEmbeddedTextFromBytes(fakeJpeg(sample))).toContain("600‰");
  });

  test("PDF real com FlateDecode: scrape embutido falha; unpdf recupera camada de texto", async () => {
    const bytes = readFileSync(
      join(import.meta.dir, "fixtures/anexo-regulamento-fonte.pdf"),
    );
    expect(/permilagem/i.test(extractEmbeddedTextFromBytes(bytes))).toBe(false);
    const layer = await extractPdfTextLayer(bytes);
    expect(/permilagem/i.test(layer)).toBe(true);
    expect(layer).toContain("‰");
    const ingest = await extractIngestTextFromBytes(bytes, "anexo.pdf");
    expect(ingest).toContain("Total Prédio");
  });

  test("PDF with permilagens → StructuredExtraction pending-style lines with excerpt", async () => {
    const extraction = await extractStructuredFromVisual({
      bytes: fakePdf("Fração A — 600‰\nFração B — 400‰"),
      filename: "regulamento.pdf",
      documentKind: "regulamento",
      ocr: createStubOcrProvider(),
    });
    expect(extraction.lines).toHaveLength(2);
    expect(extraction.lines.every((l) => l.sourceExcerpt.length > 0)).toBe(true);
    expect(extraction.lines.every((l) => (l.confidence ?? 0) >= 0.4)).toBe(true);
  });

  test("foto JPEG com padrões ‰ → mesmas linhas", async () => {
    const extraction = await extractStructuredFromBytes({
      bytes: fakeJpeg("Fração A — 550‰\nFração B — 450‰"),
      filename: "mapa.jpg",
      documentKind: "regulamento",
      mimeType: "image/jpeg",
    });
    expect(extraction.lines.map((l) => (l.payload as { codigo: string }).codigo).sort()).toEqual([
      "A",
      "B",
    ]);
  });

  test("OCR fraco → HUMAN REVIEW, nunca linhas auto-confirmadas", async () => {
    await expect(
      extractStructuredFromVisual({
        bytes: fakePdf("lorem ipsum scan noise without numbers"),
        filename: "borrado.pdf",
        documentKind: "regulamento",
        ocr: createStubOcrProvider(),
      }),
    ).rejects.toMatchObject({ code: "human_review" });
  });

  test("confiança abaixo do limiar → HUMAN REVIEW", () => {
    expect(() =>
      assertExtractionStrongEnough({
        lines: [
          {
            kind: "fracao",
            payload: { codigo: "A", permilagem: 1000 },
            sourceExcerpt: "A — 1000‰",
            confidence: 0.2,
          },
        ],
      }),
    ).toThrow(DomainError);
  });

  test("contactos em texto OCR", () => {
    const extraction = extractContactosFromPlainText("A — Maria Costa — maria@condo.test");
    expect(extraction.lines).toHaveLength(1);
    expect(extraction.lines[0]!.payload).toMatchObject({
      fracaoCodigo: "A",
      personName: "Maria Costa",
      email: "maria@condo.test",
    });
  });
});
