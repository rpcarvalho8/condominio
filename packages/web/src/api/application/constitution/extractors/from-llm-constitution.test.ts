import { describe, expect, test } from "bun:test";
import { extractConstitutionFromLlm } from "./from-llm-constitution";

describe("extractConstitutionFromLlm", () => {
  test("aceita JSON em fence e converte 0,6 → 600", async () => {
    const extraction = await extractConstitutionFromLlm({
      text: "anexo: A 0,6  B 0,4",
      documentKind: "regulamento",
      chat: async () =>
        "```json\n" +
        JSON.stringify({
          lines: [
            { kind: "fracao", codigo: "A", permilagem: "0,6", sourceExcerpt: "A 0,6", confidence: 90 },
            { kind: "fracao", codigo: "B", permilagem: 0.4, sourceExcerpt: "B 0,4", confidence: 0.7 },
          ],
        }) +
        "\n```",
    });
    expect(extraction.lines.map((l) => l.payload.permilagem)).toEqual([600, 400]);
    expect(extraction.lines.every((l) => (l.confidence ?? 0) <= 0.75)).toBe(true);
  });

  test("JSON vazio → empty_extraction", async () => {
    await expect(
      extractConstitutionFromLlm({
        text: "nada",
        documentKind: "regulamento",
        chat: async () => '{"lines":[]}',
      }),
    ).rejects.toMatchObject({ code: "empty_extraction" });
  });

  test("não inventa linhas com confiança baixa", async () => {
    await expect(
      extractConstitutionFromLlm({
        text: "ruído",
        documentKind: "regulamento",
        chat: async () =>
          JSON.stringify({
            lines: [{ kind: "fracao", codigo: "Z", permilagem: 1000, confidence: 0.1 }],
          }),
      }),
    ).rejects.toMatchObject({ code: "empty_extraction" });
  });
});
