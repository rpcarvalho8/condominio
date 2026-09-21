import { describe, expect, test } from "bun:test";
import { canonicalizeIngestText } from "./canonicalize-ingest";
import { extractStructuredFromBytes } from "./structured-extractor";

const MESSY_REGULAMENTO = [
  "Regulamento interno do condomínio — anexo de permilagens",
  "",
  "A fracção A tem 600 milésimas e a fracção B 400 permilagens.",
].join("\n");

describe("canonicalizeIngestText", () => {
  test("prosa irregular → modelo interno sem LLM", async () => {
    const extraction = await canonicalizeIngestText({
      text: MESSY_REGULAMENTO,
      documentKind: "regulamento",
      filename: "Regulamento_fracao.txt",
      llmChat: null,
    });
    const byCode = Object.fromEntries(
      extraction.lines.map((l) => [l.payload.codigo, l.payload.permilagem]),
    );
    expect(byCode.A).toBe(600);
    expect(byCode.B).toBe(400);
    expect(extraction.lines.every((l) => l.kind === "fracao")).toBe(true);
  });

  test("TSV sem cabeçalho clássico", async () => {
    const extraction = await canonicalizeIngestText({
      text: "fracao\tpermilagem\nRC-A\t250\nRC-B\t750\n",
      documentKind: "regulamento",
      llmChat: null,
    });
    expect(extraction.lines).toHaveLength(2);
    expect(extraction.lines[0]!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test("LLM injectado só entra quando regex/tabela falham", async () => {
    let called = 0;
    const extraction = await canonicalizeIngestText({
      text: "Os condóminos do bloco norte figuram no anexo, unidade Norte-1 vale seiscentos milésimos e Norte-2 o restante.",
      documentKind: "regulamento",
      llmChat: async () => {
        called += 1;
        return JSON.stringify({
          lines: [
            {
              kind: "fracao",
              codigo: "Norte-1",
              permilagem: 600,
              sourceExcerpt: "unidade Norte-1 vale seiscentos milésimos",
              confidence: 0.66,
            },
            {
              kind: "fracao",
              codigo: "Norte-2",
              permilagem: 400,
              sourceExcerpt: "Norte-2 o restante",
              confidence: 0.6,
            },
          ],
        });
      },
    });
    expect(called).toBe(1);
    expect(extraction.lines.map((l) => l.payload.codigo).sort()).toEqual(["Norte-1", "Norte-2"]);
    expect(extraction.lines.every((l) => (l.confidence ?? 0) <= 0.75)).toBe(true);
  });

  test("lixo sem LLM → human_review, nunca linhas confirmadas", async () => {
    await expect(
      canonicalizeIngestText({
        text: "lorem ipsum scan noise without numbers",
        documentKind: "regulamento",
        llmChat: null,
      }),
    ).rejects.toMatchObject({ code: "human_review" });
  });

  test("contactos em .txt sem layout rígido", async () => {
    const extraction = await canonicalizeIngestText({
      text: "A: Maria Costa maria@condo.test\nB — Rui Lopes, 912345678",
      documentKind: "contactos",
      llmChat: null,
    });
    expect(extraction.lines.every((l) => l.kind === "contacto")).toBe(true);
    expect(extraction.lines.length).toBeGreaterThanOrEqual(1);
  });
});

describe("extractStructuredFromBytes .txt", () => {
  test("Regulamento_fracao.txt em prosa já não falha vazio", async () => {
    const extraction = await extractStructuredFromBytes({
      bytes: Buffer.from(MESSY_REGULAMENTO, "utf8"),
      filename: "Regulamento_fracao.txt",
      documentKind: "regulamento",
      llmChat: null,
    });
    expect(extraction.lines).toHaveLength(2);
  });
});
