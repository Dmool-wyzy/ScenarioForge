import assert from "node:assert/strict";
import { test } from "node:test";
import { planSchema, readResearchPlan } from "../lib/research-plan";

function fixture(count: number, structured = false) {
  return {
    scenarioType: "schema_fixture",
    researchQuestions: Array.from({ length: count }, (_, index) => structured
      ? { question: `Question ${index + 1}`, searchQueries: ["fixture query"], priority: "high" }
      : `Question ${index + 1}`),
    searchQueries: ["fixture query"],
    unknowns: [],
    filePlan: ["README.md", "RESEARCH.md", "SOURCES.md"].map(filename => ({
      filename, purpose: "Fixture document", priority: "required", contentOutline: ["Fixture content"],
    })),
  };
}

test("research plans accept one, two and six questions in both supported forms", () => {
  for (const structured of [false, true]) for (const count of [1, 2, 6]) {
    const plan = readResearchPlan(JSON.stringify(fixture(count, structured)))!;
    assert.equal(plan.researchQuestions.length, count);
    assert.equal(plan.questionDetails.length, count);
    assert.equal(plan.filePlan.length, 3);
  }
});

test("research plans still reject empty or over-budget question lists", () => {
  for (const structured of [false, true]) for (const count of [0, 7]) {
    assert.equal(planSchema.safeParse(fixture(count, structured)).success, false);
  }
});

test("a one-question research plan still requires all three default Markdown files", () => {
  const plan = fixture(1);
  assert.equal(planSchema.safeParse({ ...plan, filePlan: plan.filePlan.slice(0, 2) }).success, false);
  assert.equal(planSchema.safeParse({ ...plan, filePlan: plan.filePlan.map(item => item.filename === "SOURCES.md"
    ? { ...item, filename: "NOTES.md" } : item) }).success, false);
  assert.equal(planSchema.safeParse({ ...plan, filePlan: plan.filePlan.map(item => item.filename === "SOURCES.md"
    ? { ...item, priority: "optional" } : item) }).success, false);
});
