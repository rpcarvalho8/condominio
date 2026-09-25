/**
 * Robustez mínima unit_share: a heurística genérica NÃO trata
 * «qualquer código + decimal» como permilagem.
 * Sem parser Fonte; sem OCR; sem LLM.
 */
import { describe, expect, test } from "bun:test";
import { runIngestPipeline } from "./pipeline";

async function runText(filename: string, text: string) {
  return runIngestPipeline({
    bytes: Buffer.from(text, "utf8"),
    filename,
    documentId: "robustness",
  });
}

describe("F1 unit_share — robustez (falsos positivos)", () => {
  test("1. linha válida com contexto de permilagem → candidato", async () => {
    const result = await runText(
      "valido.txt",
      ["Permilagem ‰", "J 38,80", "K 961,20", ""].join("\n"),
    );
    const j = result.units.find((unit) => unit.codigo === "J");
    expect(j).toBeDefined();
    expect(j!.permilagemCentesimas).toBe(3880);
    expect(j!.permilagem).toBeNull();
    expect(j!.evidence.find((item) => item.field === "permilagem")?.originalText).toBe("38,80");
  });

  test("2. decimal monetário (€) sem cue de permilagem → sem quota canónica", async () => {
    const result = await runText("quota-euro.txt", "Quota mensal 38,80 €\n");
    expect(result.units.every((unit) => unit.permilagem == null)).toBe(true);
  });

  test("3. percentagem explícita sem soma=100 justificada → não assume ‰", async () => {
    const result = await runText("taxa-pct.txt", "Taxa 38,80 %\n");
    expect(result.units.every((unit) => unit.permilagem == null)).toBe(true);
  });

  test("4. área m² → não é unit_share", async () => {
    const result = await runText("area.txt", "Área 38,80 m²\n");
    expect(result.units.every((unit) => unit.permilagem == null)).toBe(true);
  });

  test("5. linha sem código de fracção → sem unidade utilizável", async () => {
    const result = await runText(
      "sem-codigo.txt",
      ["Permilagem ‰", "38,80", ""].join("\n"),
    );
    expect(result.units.filter((unit) => unit.codigo && unit.permilagem != null)).toHaveLength(0);
  });

  test("6. código + número SEM contexto de permilagem → 0 candidatos (não forçar)", async () => {
    const result = await runText("sem-contexto.txt", "J 38,80\n");
    expect(result.units).toHaveLength(0);
    expect(result.summary.readyForConfirmation).toBe(0);
  });

  test("7. tabela unit_share válida com vários códigos", async () => {
    const result = await runText(
      "tabela.csv",
      "codigo,permilagem\nA,600\nB,400\n",
    );
    expect(result.units.map((unit) => unit.codigo)).toEqual(["A", "B"]);
    expect(result.units.map((unit) => unit.permilagem)).toEqual([600, 400]);
    expect(result.units.map((unit) => unit.permilagemCentesimas)).toEqual([60000, 40000]);
    expect(result.summary.readyForConfirmation).toBe(2);
    expect(result.summary.blocking).toEqual([]);
  });

  test("mais de 2 casas decimais no ‰ não inventa quota", async () => {
    const result = await runText(
      "excesso.txt",
      ["Permilagem ‰", "J 38,801", "K 961,199", ""].join("\n"),
    );
    expect(result.units.length).toBeGreaterThan(0);
    expect(result.units.every((unit) => unit.permilagemCentesimas == null)).toBe(true);
    expect(result.units.every((unit) => unit.permilagem == null)).toBe(true);
    expect(result.units.every((unit) => unit.review === "needs_human_review")).toBe(true);
    expect(result.summary.blocking.some((item) => item.code === "needs_human_review")).toBe(true);
  });

  test("percentagem: casas decimais contam-se no ‰ depois de ×10", async () => {
    const ok = await runText(
      "percent-ok.csv",
      "Unidade,Percentagem\nA,6.25\nB,93.75\n",
    );
    const byCode = Object.fromEntries(ok.units.map((unit) => [unit.codigo, unit]));
    expect(byCode.A?.permilagemCentesimas).toBe(6250);
    expect(byCode.B?.permilagemCentesimas).toBe(93750);
    expect(byCode.A?.permilagem).toBeNull();
    expect(ok.units.reduce((acc, unit) => acc + (unit.permilagemCentesimas ?? 0), 0)).toBe(100000);
    expect(ok.summary.blocking).toEqual([]);

    const excess = await runText(
      "percent-excesso.csv",
      "Unidade,Percentagem\nA,6.2555\nB,93.7445\n",
    );
    expect(excess.units.every((unit) => unit.permilagemCentesimas == null)).toBe(true);
    expect(excess.units.every((unit) => unit.review === "needs_human_review")).toBe(true);
  });
});
