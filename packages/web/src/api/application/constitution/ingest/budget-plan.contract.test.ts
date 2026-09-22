/**
 * budget_plan é contrato (ADR-044). O pipeline ligado continua a ser unit_share.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUDGET_PLAN_DOES_NOT_CREATE,
  BUDGET_PLAN_PHASE,
  BUDGET_PLAN_PROFILE_ID,
} from "./profiles/budget-plan";
import { F1_PROFILE_CORPUS } from "./profiles/corpus";

const here = dirname(fileURLToPath(import.meta.url));

describe("F1 budget_plan — contratos, sem pipeline", () => {
  test("o corpus tem dez ou mais exemplos e o mapa de dívidas é falso positivo", () => {
    expect(F1_PROFILE_CORPUS.length).toBeGreaterThanOrEqual(10);
    const debt = F1_PROFILE_CORPUS.filter((example) => example.id === "09-debt-map");
    expect(debt).toHaveLength(1);
    expect(debt[0]!.budgetPlanVerdict).toBe("false_positive");
    expect(debt[0]!.text.toLowerCase()).toContain("dívidas");
    expect(F1_PROFILE_CORPUS.some((example) => example.budgetPlanVerdict === "future_candidate")).toBe(
      true,
    );
    expect(F1_PROFILE_CORPUS.some((example) => example.budgetPlanVerdict === "out_of_profile")).toBe(
      true,
    );
  });

  test("o perfil não está ligado e não nomeia escrita de domínio", () => {
    expect(BUDGET_PLAN_PHASE).toBe("contracts_only");
    expect(BUDGET_PLAN_PROFILE_ID).toBe("budget_plan");
    expect(BUDGET_PLAN_DOES_NOT_CREATE).toContain("obligation");
    expect(BUDGET_PLAN_DOES_NOT_CREATE).toContain("annual_budget");
    const budgetPlan = readFileSync(join(here, "profiles/budget-plan.ts"), "utf8");
    expect(budgetPlan).not.toMatch(/createAnnualBudget\s*\(/);
    expect(budgetPlan).not.toMatch(/approveBudgetAndCreateObligations\s*\(/);
    expect(budgetPlan).not.toMatch(/runIngestPipeline\s*\(/);
  });

  test("o pipeline de frações não importa o perfil de orçamento", () => {
    const wired = [
      "pipeline.ts",
      "validate.ts",
      "canonicalize.ts",
      "semantic-extraction.ts",
      "intake.ts",
      "llm-hypothesis.ts",
    ];
    for (const file of wired) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source.includes("budget-plan")).toBe(false);
      expect(source.includes("budget_plan")).toBe(false);
    }
    const upload = readFileSync(join(here, "../upload-and-extract.ts"), "utf8");
    expect(upload.includes("profiles/budget-plan")).toBe(false);
    expect(upload.includes("INGEST_DOCUMENT_KINDS.regulamento")).toBe(true);
  });
});
