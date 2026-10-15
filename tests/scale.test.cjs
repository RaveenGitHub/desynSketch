const { test } = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { calculateCoverage } = require("../dist/coverage");
const { transition, restore } = require("../dist/workflow");
const { readyWorkflow } = require("./fixtures.cjs");

test("100 features / 1000 AC / 6000 cases meet scoring and edit budgets without losing lineage", () => {
  const w = readyWorkflow(100, 10, true);
  assert.equal(w.test_cases.length, 6000);
  const start = performance.now();
  const coverage = calculateCoverage(w);
  const scoringMs = performance.now() - start;
  assert.equal(coverage.overall_score, 100);
  assert.equal(coverage.references.length, 13114);
  assert.ok(scoringMs < 500, `Scoring took ${scoringMs.toFixed(1)} ms; budget is 500 ms.`);
  const editStart = performance.now();
  const f = w.features[0];
  const edited = transition(w, { type: "saveArtifact", kind: "feature", id: f.requirement_id,
    value: { ...f, reviewer_notes: "Additional rationale." } });
  const editMs = performance.now() - editStart;
  assert.ok(editMs < 2000, `Edit took ${editMs.toFixed(1)} ms; budget is 2000 ms.`);
  assert.equal(edited.test_cases.length, 6000);
  assert.equal(restore(edited).test_cases.length, 6000);
  console.log(`6000-case workload: coverage ${scoringMs.toFixed(1)} ms, edit ${editMs.toFixed(1)} ms.`);
});
