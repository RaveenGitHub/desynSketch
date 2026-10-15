import { test } from "node:test";
import * as assert from "node:assert/strict";
import { exportArtifact } from "./export";
import { Criterion, Feature, Scenario, TestCase, Workflow, categories, emptyWorkflow } from "./model";
import { decodeWorkflow, stageOneErrors, stageThreeErrors, stageTwoErrors } from "./validation";
import { decodeAction, gates, restore, transition } from "./workflow";
import { calculateCoverage } from "./coverage";
import { eligibility, impactPreview, needsImpactConfirmation } from "./presentation";
import { clarificationKeys } from "./clarifications";

const responses: Record<string, string> = {
  intent: "The version 1 solution uses a local repository and synthetic inventory. No authoritative remote documents exist.",
  actors: "An authenticated inventory clerk with create permission and a restricted read-only user.",
  capabilities: "An inventory clerk creates an item to track stock.\nAn inventory clerk updates quantity to reconcile stock.",
  scope: "Inventory items and quantity updates are in scope; billing is excluded from release 1.",
  rules: "A unique SKU creates one item. Duplicate SKUs and invalid quantities return validation errors without mutation.",
  boundaries: "Quantity must be an integer from 0 to 100 inclusive. -1 and 101 are rejected; 0 and 100 are accepted.",
  data: 'Synthetic SKU TEST-001 and quantities -1, 0, 1, 99, 100 and 101; no customer data.',
  dependencies: "A repository simulator with a controllable one-second timeout; no external integrations.",
  operations: "On repository timeout, display a timeout error, do not retry automatically, preserve stock and log a correlation ID.",
  security: "Read-only users are denied mutations without changes; denial is audited. Test only in the isolated simulator.",
  performance: "p95 latency <= 200 ms at 10 concurrent clerks and 20 requests/s over 60 seconds in the simulator.",
  environment: "Isolated VS Code test workspace; repository simulator reset before each case; no production network access.",
  success: "One authorized action changes only the selected item and returns its persisted state within 200 ms."
};

function resolvedProduct(): Workflow {
  let w = transition(emptyWorkflow(), { type: "analyze", brief: "Track inventory.", links: [] });
  for (const item of w.product.items) {
    w = transition(w, { type: "resolve", id: item.id, answer: responses[item.key] ?? "Explicitly reviewed with the specified constraints.", notes: "Reviewed with product owner." });
    w = transition(w, { type: "confirmItem", id: item.id });
  }
  return transition(w, { type: "confirmProduct", notes: "Release 1 scope and risks agreed.", priority: "high", confidence: 90, traceConfidence: 95 });
}

function criterionReady(ac: Criterion): Criterion {
  return {
    ...ac, reviewer_notes: "SMART and GWT verified against inventory rules.", confidence_score: 90,
    measurement: "Persist exactly one selected item's resulting state within 200 ms; read-back must match the submitted valid quantity.",
    smart_review: { specific: true, measurable: true, achievable: true, relevant: true, time_bound: true }
  };
}

function featureReady(f: Feature): Feature {
  return {
    ...f, reviewer_notes: "INVEST assessed; bounded independently testable capability.", confidence_score: 90,
    invest_review: { independent: true, negotiable: true, valuable: true, estimable: true, small: true, testable: true },
    acceptance_criteria: f.acceptance_criteria.map(criterionReady)
  };
}

function confirmedFeatures(): Workflow {
  let w = transition(resolvedProduct(), { type: "proceed" });
  for (const f of w.features) {
    w = transition(w, { type: "saveArtifact", kind: "feature", id: f.requirement_id, value: featureReady(f) });
    for (const ac of f.acceptance_criteria) {
      w = transition(w, { type: "confirmArtifact", kind: "criterion", id: ac.acceptance_criteria_id });
    }
    w = transition(w, { type: "confirmArtifact", kind: "feature", id: f.requirement_id });
  }
  return w;
}

function completeWorkflow(): Workflow {
  let w = transition(confirmedFeatures(), { type: "proceed" });
  for (const s of w.scenarios) {
    const value: Scenario = { ...s, reviewer_notes: "Risk and category-specific contract verified.", confidence_score: 90 };
    w = transition(w, { type: "saveArtifact", kind: "scenario", id: s.scenario_id, value });
    w = transition(w, { type: "confirmArtifact", kind: "scenario", id: s.scenario_id });
  }
  for (const t of w.test_cases) {
    const value: TestCase = {
      ...t, reviewer_notes: "Steps and synthetic partition data reviewed.", confidence_score: 90,
      test_data: 'SKU TEST-001, quantities -1,0,1,99,100,101; clerk/read-only fixtures; timeout toggle.'
    };
    w = transition(w, { type: "saveArtifact", kind: "test", id: t.test_case_id, value });
    w = transition(w, { type: "confirmArtifact", kind: "test", id: t.test_case_id });
  }
  return w;
}

test("empty and partially reviewed definitions cannot proceed, confirm, or navigate to a locked stage", () => {
  const w = emptyWorkflow();
  assert.throws(() => transition(w, { type: "proceed" }), /Provide a product brief/);
  assert.throws(() => transition(w, { type: "navigate", stage: 3 }), /Provide a product brief/);
  assert.throws(() => transition(w, { type: "confirmProduct", notes: "Reviewed", priority: "high", confidence: 100, traceConfidence: 100 }), /every clarification/);
  assert.equal(w.revision, 0);
});

test("analysis produces required missing information, unique ambiguity flags and document confirmations", () => {
  const w = transition(emptyWorkflow(), { type: "analyze", brief: "A fast, scalable and FAST stock service.", links: ["https://example.org/intent"] });
  assert.equal(w.product.items.filter(i => i.kind === "ambiguity").length, 2);
  assert.equal(w.product.items.filter(i => i.kind === "missing-information").length, 13);
  assert.equal(w.product.items.filter(i => i.kind === "confirmation").length, 1);
  assert.equal(w.product.open_items_count, 17);
  assert.equal(w.product.severity_of_missing_info, "critical");
  assert.equal(w.product.ambiguity_resolution_status, "unresolved");
  assert.equal(w.product.intent_links[0], "https://example.org/intent");
});

test("rejects malformed, unsafe and credential-bearing intent URLs without altering the current workflow", () => {
  for (const url of ["javascript:alert(1)", "file:///C:/secret", "not-a-url", "https://user:password@example.org"]) {
    const w = emptyWorkflow();
    assert.throws(() => transition(w, { type: "analyze", brief: "Stock", links: [url] }));
    assert.equal(w.product.brief, "");
  }
});

test("answering is distinct from confirmation and needs reviewer notes", () => {
  let w = transition(emptyWorkflow(), { type: "analyze", brief: "Stock.", links: [] });
  assert.throws(() => transition(w, { type: "confirmItem", id: "Q-001" }), /Resolve/);
  assert.throws(() => transition(w, { type: "resolve", id: "Q-001", answer: "Some intent", notes: "" }), /reviewer notes/);
  w = transition(w, { type: "resolve", id: "Q-001", answer: "No remote documents.", notes: "Owner confirmed." });
  assert.equal(w.product.items[0]?.resolution_status, "answered");
  assert.ok(stageOneErrors(w).length);
});

test("every required clarification and product confirmation unlocks feature generation", () => {
  const w = resolvedProduct();
  assert.deepEqual(stageOneErrors(w), []);
  assert.equal(w.product.open_items_count, 0);
  assert.equal(w.product.clarity_status, "clear");
  const features = transition(w, { type: "proceed" });
  assert.equal(features.stage, 2);
  assert.equal(features.features.length, 2);
  assert.equal(features.features[0]?.product_requirement_id, "PRD-001");
  assert.ok(stageTwoErrors(features).length);
  assert.throws(() => transition(features, { type: "proceed" }), /SMART|Measurement|measurement/);
});

test("duplicate capabilities fail generation with an actionable error", () => {
  let w = resolvedProduct();
  const item = w.product.items.find(i => i.key === "capabilities");
  assert.ok(item);
  w = transition(w, { type: "resolve", id: item.id, answer: "Create stock\ncreate stock", notes: "Review" });
  w = transition(w, { type: "confirmItem", id: item.id });
  w = transition(w, { type: "confirmProduct", notes: "Review", priority: "high", confidence: 90, traceConfidence: 90 });
  assert.throws(() => transition(w, { type: "proceed" }), /unique/);
});

test("feature confirmation requires reviewed SMART criteria and all INVEST dimensions", () => {
  const w = transition(resolvedProduct(), { type: "proceed" });
  const f = w.features[0];
  assert.ok(f);
  assert.throws(() => transition(w, { type: "confirmArtifact", kind: "feature", id: f.requirement_id }), /INVEST/);
  assert.throws(() => transition(w, { type: "confirmArtifact", kind: "criterion", id: f.acceptance_criteria[0]!.acceptance_criteria_id }), /SMART/);
  assert.deepEqual(stageTwoErrors(confirmedFeatures()), []);
});

test("generation creates all six categories per AC, Gherkin, detailed cases and exact traceability", () => {
  const w = transition(confirmedFeatures(), { type: "proceed" });
  assert.equal(w.stage, 3);
  assert.equal(w.scenarios.length, 12);
  assert.equal(w.test_cases.length, 12);
  for (const f of w.features) {
    for (const ac of f.acceptance_criteria) {
      const scenarios = w.scenarios.filter(s => s.acceptance_criteria_id === ac.acceptance_criteria_id);
      assert.deepEqual(scenarios.map(s => s.category), categories);
      scenarios.forEach(s => assert.match(s.gherkin, /Scenario:.*\n {2}Given .*\n {2}When .*\n {2}Then /));
    }
  }
  w.test_cases.forEach(t => {
    assert.equal(t.test_data, "");
    assert.ok(t.steps.every(step => step.action.length && step.expected_result.length));
    assert.ok(t.preconditions.length);
    const row = w.traceability_matrix.find(r => r.test_case_id === t.test_case_id);
    assert.equal(row?.requirement_id, t.requirement_id);
    assert.equal(row?.acceptance_criteria_id, t.acceptance_criteria_id);
    assert.equal(row?.scenario_id, t.scenario_id);
  });
  assert.ok(gates(w).stage3.length);
});

test("test data, metadata and scenario confirmation are mandatory, not silently defaulted", () => {
  const w = transition(confirmedFeatures(), { type: "proceed" });
  const t = w.test_cases[0];
  const s = w.scenarios[0];
  assert.ok(t && s);
  assert.throws(() => transition(w, { type: "confirmArtifact", kind: "test", id: t.test_case_id }), /parent scenario/);
  assert.throws(() => transition(w, { type: "confirmArtifact", kind: "scenario", id: s.scenario_id }), /Reviewer notes/);
});

test("a fully reviewed workflow passes every gate and remains persistent through JSON restoration", () => {
  const w = completeWorkflow();
  assert.deepEqual(stageThreeErrors(w), []);
  assert.equal(transition(w, { type: "proceed" }).stage, 3);
  const restored = restore(JSON.parse(JSON.stringify(w)));
  assert.deepEqual(gates(restored), { stage1: [], stage2: [], stage3: [] });
  assert.deepEqual(restored.traceability_matrix, w.traceability_matrix);
});

test("upstream edits invalidate product confirmation and all downstream artifacts", () => {
  const w = completeWorkflow();
  const edited = transition(w, { type: "resolve", id: "Q-001", answer: "Intent changed.", notes: "Change request." });
  assert.equal(edited.stage, 1);
  assert.equal(edited.product.review_status, "pending");
  assert.equal(edited.features.length, 0);
  assert.equal(edited.scenarios.length, 0);
  assert.equal(edited.test_cases.length, 0);
  assert.equal(edited.traceability_matrix.length, 0);
  assert.equal(w.stage, 3);
});

test("feature content edits invalidate only dependent tests, without undoing unchanged AC reviews", () => {
  const w = completeWorkflow();
  const f = w.features[0];
  assert.ok(f);
  const edited = transition(w, { type: "saveArtifact", kind: "feature", id: f.requirement_id, value: { ...f, scope: "Changed release scope." } });
  assert.equal(edited.stage, 2);
  assert.equal(edited.features[0]?.review_status, "pending");
  assert.equal(edited.features[0]?.acceptance_criteria[0]?.review_status, "confirmed");
  assert.deepEqual(edited.scenarios, w.scenarios.filter(s => s.requirement_id !== f.requirement_id));
  assert.deepEqual(edited.test_cases, w.test_cases.filter(t => t.requirement_id !== f.requirement_id));
});

test("AC edits force revalidation even when JSON claims confirmed/validated", () => {
  const w = confirmedFeatures();
  const f = w.features[0];
  assert.ok(f);
  const changed = structuredClone(f);
  changed.acceptance_criteria[0]!.then = "Changed observable outcome.";
  const edited = transition(w, { type: "saveArtifact", kind: "feature", id: f.requirement_id, value: changed });
  assert.equal(edited.features[0]?.acceptance_criteria[0]?.review_status, "pending");
  assert.equal(edited.features[0]?.acceptance_criteria[0]?.validation_status, "pending");
  assert.throws(() => transition(edited, { type: "proceed" }), /confirmed/);
});

test("scenario edits regenerate Gherkin and invalidate related case confirmations", () => {
  const w = completeWorkflow();
  const s = w.scenarios[0];
  assert.ok(s);
  const edited = transition(w, { type: "saveArtifact", kind: "scenario", id: s.scenario_id, value: { ...s, when: "Submit quantity 99." } });
  assert.equal(edited.scenarios[0]?.review_status, "pending");
  assert.match(edited.scenarios[0]!.gherkin, /When Submit quantity 99/);
  assert.equal(edited.test_cases[0]?.review_status, "pending");
  assert.equal(edited.test_cases[1]?.review_status, "confirmed");
});

test("artifact edits cannot forge IDs, category, cross-feature AC linkage or duplicate criteria", () => {
  const w = completeWorkflow();
  const f = w.features[0];
  const s = w.scenarios[0];
  const t = w.test_cases[0];
  assert.ok(f && s && t);
  assert.throws(() => transition(w, { type: "saveArtifact", kind: "feature", id: f.requirement_id, value: { ...f, requirement_id: "FORGED" } }), /IDs/);
  assert.throws(() => transition(w, { type: "saveArtifact", kind: "scenario", id: s.scenario_id, value: { ...s, category: "security" } }), /category/);
  assert.throws(() => transition(w, { type: "saveArtifact", kind: "test", id: t.test_case_id, value: { ...t, acceptance_criteria_id: "AC-002-01" } }), /linkage/);
  const malformed = structuredClone(w);
  malformed.scenarios[0]!.acceptance_criteria_id = "AC-002-01";
  assert.throws(() => decodeWorkflow(malformed), /different requirement/);
});

test("new ACs and boundary test cases get unique IDs, full metadata and block completion until reviewed", () => {
  let w = confirmedFeatures();
  w = transition(w, { type: "addCriterion", id: "RQ-001" });
  assert.equal(w.features[0]?.review_status, "pending");
  assert.equal(w.features[0]?.acceptance_criteria.length, 2);
  assert.throws(() => transition(w, { type: "proceed" }), /required/);
  w = completeWorkflow();
  const previousCount = w.test_cases.length;
  const edited = transition(w, { type: "addTestCase", id: w.scenarios[0]!.scenario_id });
  assert.equal(edited.test_cases.length, previousCount + 1);
  assert.equal(new Set(edited.test_cases.map(t => t.test_case_id)).size, previousCount + 1);
  assert.ok(stageThreeErrors(edited).length);
});

test("JSON and YAML 1.2 exports are lossless and stage-specific; drafts are explicitly labeled", () => {
  const w = completeWorkflow();
  const json = JSON.parse(exportArtifact(w, 3, "json"));
  const yaml = JSON.parse(exportArtifact(w, 3, "yaml"));
  assert.deepEqual(json, yaml);
  assert.equal(json.status, "reviewed");
  assert.equal(json.open_items_count, 0);
  assert.equal(json.traceability_matrix.length, w.test_cases.length);
  assert.equal(json.test_cases[0].reviewer_notes, w.test_cases[0]?.reviewer_notes);
  const product = JSON.parse(exportArtifact(w, 1, "json"));
  assert.equal(product.features, undefined);
  assert.equal(product.test_cases, undefined);
  const features = JSON.parse(exportArtifact(w, 2, "json"));
  assert.ok(features.features);
  assert.equal(features.scenarios, undefined);
  const draft = JSON.parse(exportArtifact(emptyWorkflow(), 1, "json"));
  assert.equal(draft.status, "draft");
  assert.ok(draft.blocking_items.length);
});

test("Markdown includes Gherkin, cases, traceability and every metadata field in its lossless appendix", () => {
  const w = completeWorkflow();
  const text = exportArtifact(w, 3, "markdown");
  assert.match(text, /## Traceability Matrix/);
  assert.match(text, /```gherkin/);
  assert.match(text, /## Test Cases/);
  assert.match(text, /"automation_status": "not-assessed"/);
  assert.match(text, /"traceability_confidence": 100/);
  assert.match(text, /"reviewer_notes"/);
  assert.match(text, /"smart_review"/);
});

test("Markdown fences cannot be broken by artifact text", () => {
  const w = completeWorkflow();
  w.scenarios[0]!.when = "Submit literal ``` and ````` safely.";
  const text = exportArtifact(w, 3, "markdown");
  assert.match(text, /``````gherkin/);
  assert.match(text, /``````json/);
});

test("malformed persisted states are rejected instead of silently discarding user work", () => {
  assert.throws(() => restore({ schema_version: 2 }), /Unsupported/);
  const w = completeWorkflow();
  const bad: unknown = { ...w, product: { ...w.product, items: [{ id: "Q-001" }] } };
  assert.throws(() => restore(bad), /Malformed clarification/);
  const badConfidence = structuredClone(w);
  badConfidence.features[0]!.confidence_score = 101;
  assert.throws(() => restore(badConfidence), /metadata/);
  const badLink = structuredClone(w);
  badLink.test_cases[0]!.scenario_id = "UNKNOWN";
  assert.throws(() => restore(badLink), /linkage/);
  const missingCategory = structuredClone(w);
  missingCategory.product.items = missingCategory.product.items.filter(i => i.key !== "security");
  assert.throws(() => restore(missingCategory), /required clarification/);
});

test("webview action decoder rejects missing fields, invalid enums and invalid numeric scores", () => {
  for (const action of [
    null, { type: "unknown" }, { type: "navigate", stage: 4 },
    { type: "analyze", brief: "Stock", links: [1] },
    { type: "confirmProduct", notes: "Review", priority: "urgent", confidence: 90, traceConfidence: 90 },
    { type: "confirmProduct", notes: "Review", priority: "high", confidence: Number.NaN, traceConfidence: 90 },
    { type: "saveArtifact", kind: "scenario", id: "SC-001", value: [] }
  ]) assert.throws(() => decodeAction(action));
  assert.deepEqual(decodeAction({ type: "navigate", stage: 1 }), { type: "navigate", stage: 1 });
});

test("invalid automation combinations and incomplete step results fail validation", () => {
  const w = completeWorkflow();
  const t = w.test_cases[0];
  assert.ok(t);
  const bad = transition(w, { type: "saveArtifact", kind: "test", id: t.test_case_id, value: { ...t, automation_candidate: false, automation_status: "automated" } });
  assert.throws(() => transition(bad, { type: "confirmArtifact", kind: "test", id: t.test_case_id }), /automation candidates/);
  const emptyStep = transition(w, { type: "saveArtifact", kind: "test", id: t.test_case_id, value: { ...t, steps: [{ action: "Do it", expected_result: "" }] } });
  assert.throws(() => transition(emptyStep, { type: "confirmArtifact", kind: "test", id: t.test_case_id }), /expected result/);
});

test("navigating backward and proceeding again preserves already generated artifacts", () => {
  let w = completeWorkflow();
  const ids = w.test_cases.map(t => t.test_case_id);
  w = transition(w, { type: "navigate", stage: 1 });
  w = transition(w, { type: "proceed" });
  w = transition(w, { type: "proceed" });
  assert.equal(w.stage, 3);
  assert.deepEqual(w.test_cases.map(t => t.test_case_id), ids);
  assert.deepEqual(stageThreeErrors(w), []);
});

test("coverage checks detect missing scenario categories even if every remaining artifact is confirmed", () => {
  const w = completeWorkflow();
  w.scenarios = w.scenarios.filter(s => !(s.requirement_id === "RQ-001" && s.category === "boundary"));
  w.test_cases = w.test_cases.filter(t => w.scenarios.some(s => s.scenario_id === t.scenario_id));
  assert.match(stageThreeErrors(w).join("\n"), /missing boundary coverage/);
});

test("risk scenario drafts preserve exact clarified thresholds, workload and recovery contracts", () => {
  const w = transition(confirmedFeatures(), { type: "proceed" });
  const boundary = w.scenarios.find(s => s.category === "boundary");
  const performance = w.scenarios.find(s => s.category === "performance");
  const operations = w.scenarios.find(s => s.category === "operational-risk");
  const security = w.scenarios.find(s => s.category === "security");
  assert.ok(boundary && performance && operations && security);
  assert.ok(boundary.given.includes(responses.boundaries!));
  assert.ok(boundary.then.includes(responses.boundaries!));
  assert.ok(performance.given.includes(responses.performance!));
  assert.ok(performance.then.includes(responses.performance!));
  assert.ok(operations.then.includes(responses.operations!));
  assert.ok(security.then.includes(responses.security!));
  assert.match(security.given, /isolated authorized test environment/);
});

test("duplicate criterion and test case IDs cannot enter saved state", () => {
  const w = confirmedFeatures();
  const f = w.features[0];
  assert.ok(f);
  const duplicate = { ...f, acceptance_criteria: [...f.acceptance_criteria, f.acceptance_criteria[0]] };
  assert.throws(() => transition(w, { type: "saveArtifact", kind: "feature", id: f.requirement_id, value: duplicate }), /existing acceptance criterion IDs/);
  const full = completeWorkflow();
  full.test_cases.push(full.test_cases[0]!);
  assert.throws(() => restore(full), /test case ID/);
});

test("combined scoring starts at zero and updates immediately on resolution, confirmation and generation", () => {
  assert.equal(calculateCoverage(emptyWorkflow()).overall_score, 0);
  let w = transition(emptyWorkflow(), { type: "analyze", brief: "Stock.", links: [] });
  const initial = w.coverage.overall_score;
  w = transition(w, { type: "resolve", id: "Q-001", answer: responses.intent!, notes: "Reviewed" });
  assert.ok(w.coverage.overall_score > initial);
  const resolved = w.coverage.overall_score;
  w = transition(w, { type: "confirmItem", id: "Q-001" });
  assert.ok(w.coverage.overall_score > resolved);
  const product = resolvedProduct();
  assert.equal(product.coverage.stages[0]?.score, 100);
  assert.ok(product.coverage.overall_score < 100);
  const features = transition(product, { type: "proceed" });
  assert.ok(features.coverage.overall_score > product.coverage.overall_score);
  assert.ok(features.coverage.overall_score < 100);
  assert.equal(confirmedFeatures().coverage.stages[1]?.score, 100);
});

test("overall score follows exact balanced-stage formula and 100 requires all checks passing", () => {
  const w = completeWorkflow();
  assert.equal(w.coverage.overall_score, 100);
  assert.ok(w.coverage.checks.every(check => check.passed));
  assert.ok(w.coverage.stages.every(stage => stage.score === 100 && stage.passed_checks === stage.total_checks));
  const partial = transition(confirmedFeatures(), { type: "proceed" });
  for (const stage of partial.coverage.stages) {
    const checks = partial.coverage.checks.filter(check => check.stage === stage.stage);
    assert.equal(stage.total_checks, checks.length);
    assert.equal(stage.passed_checks, checks.filter(check => check.passed).length);
    assert.equal(stage.score, stage.passed_checks === stage.total_checks ? 100 :
      Math.floor(stage.passed_checks / stage.total_checks * 1000) / 10);
  }
  assert.equal(partial.coverage.overall_score,
    Math.floor(partial.coverage.stages.reduce((sum, stage) => sum + stage.score, 0) / 3 * 10) / 10);
});

test("bidirectional references permit traversal along the full product-to-case and case-to-product chain", () => {
  const w = completeWorkflow();
  const refs = new Map(w.coverage.references.map(reference => [reference.id, reference]));
  const t = w.test_cases[0]!;
  const chain = ["PRD-001", t.requirement_id, t.acceptance_criteria_id, t.scenario_id, t.test_case_id];
  for (let index = 0; index < chain.length - 1; index++) {
    const parent = chain[index]!;
    const child = chain[index + 1]!;
    assert.ok(refs.get(parent)?.forward_references.includes(child));
    assert.ok(refs.get(child)?.reverse_references.includes(parent));
  }
  assert.ok(refs.get("PRD-001")?.forward_references.includes("Q-001"));
  assert.deepEqual(refs.get("Q-001")?.reverse_references, ["PRD-001"]);
  assert.deepEqual(refs.get(t.test_case_id)?.forward_references, []);
  assert.deepEqual(refs.get("PRD-001")?.reverse_references, []);
});

test("adding artifacts and upstream invalidation lower the combined score and refresh references", () => {
  const w = completeWorkflow();
  const added = transition(w, { type: "addTestCase", id: w.scenarios[0]!.scenario_id });
  assert.ok(added.coverage.overall_score < 100);
  const last = added.test_cases.at(-1)!;
  assert.ok(added.coverage.references.find(r => r.id === last.scenario_id)?.forward_references.includes(last.test_case_id));
  const changed = transition(w, { type: "resolve", id: "Q-001", answer: "Changed intent.", notes: "Review" });
  assert.ok(changed.coverage.overall_score < w.coverage.overall_score);
  assert.ok(!changed.coverage.references.some(r => ["feature", "criterion", "scenario", "test"].includes(r.kind)));
  assert.equal(changed.coverage.stages[2]?.score, 0);
});

test("orphaned reverse references, missing categories and unreviewed metadata never receive full credit", () => {
  const w = completeWorkflow();
  w.test_cases[0]!.scenario_id = "UNKNOWN";
  const orphan = calculateCoverage(w);
  assert.ok(orphan.overall_score < 100);
  assert.ok(orphan.checks.some(c => c.direction === "reverse" && c.source_id === w.test_cases[0]!.test_case_id && !c.passed));
  assert.deepEqual(orphan.references.find(r => r.id === w.test_cases[0]!.test_case_id)?.reverse_references, []);
  const missing = completeWorkflow();
  missing.scenarios = missing.scenarios.filter(s => !(s.requirement_id === "RQ-001" && s.category === "security"));
  const result = calculateCoverage(missing);
  assert.ok(result.checks.some(c => c.description.startsWith("security:") && !c.passed));
  assert.ok(result.overall_score < 100);
  const incomplete = completeWorkflow();
  incomplete.test_cases[0]!.test_data = "";
  assert.ok(calculateCoverage(incomplete).overall_score < 100);
});

test("restoration migrates old workflow data and ignores forged derived scores", () => {
  const w = completeWorkflow();
  const legacy: Record<string, unknown> = { ...w };
  delete legacy.coverage;
  assert.deepEqual(restore(legacy).coverage, w.coverage);
  const forged = { ...w, coverage: { overall_score: -999, references: "forged" } };
  assert.equal(restore(forged).coverage.overall_score, 100);
  const pending = transition(confirmedFeatures(), { type: "proceed" });
  const malicious = { ...pending, coverage: { ...pending.coverage, overall_score: 100 } };
  assert.ok(restore(malicious).coverage.overall_score < 100);
});

test("exports include scores and both reference directions without downstream leakage", () => {
  const w = completeWorkflow();
  const full = JSON.parse(exportArtifact(w, 3, "json"));
  assert.equal(full.coverage.overall_score, 100);
  assert.deepEqual(full.coverage, JSON.parse(exportArtifact(w, 3, "yaml")).coverage);
  const stage1 = JSON.parse(exportArtifact(w, 1, "json"));
  assert.ok(stage1.coverage.overall_score < 100);
  assert.ok(stage1.coverage.references.every((r: { stage: number }) => r.stage === 1));
  const stage2 = JSON.parse(exportArtifact(w, 2, "json"));
  assert.ok(stage2.coverage.references.every((r: { stage: number }) => r.stage <= 2));
  const text = exportArtifact(w, 3, "markdown");
  assert.match(text, /Overall: \*\*100%\*\*/);
  assert.match(text, /### Bidirectional References/);
  assert.match(text, /"forward_references"/);
  assert.match(text, /"reverse_references"/);
});

test("navigation leaves full-workflow scoring unchanged and rejected actions leave saved scoring unchanged", () => {
  const w = completeWorkflow();
  assert.deepEqual(transition(w, { type: "navigate", stage: 1 }).coverage, w.coverage);
  const pending = transition(confirmedFeatures(), { type: "proceed" });
  const snapshot = structuredClone(pending.coverage);
  assert.throws(() => transition(pending, { type: "proceed" }));
  assert.deepEqual(pending.coverage, snapshot);
});

test("view navigation cannot mutate readiness, revision or artifacts", () => {
  const w = completeWorkflow();
  assert.deepEqual(transition(w, { type: "navigate", stage: 1 }), w);
  assert.deepEqual(transition(w, { type: "navigate", stage: 2 }), w);
  const legacy = { ...w, stage: 1 };
  assert.equal(restore(legacy).stage, 3);
  const malformed = { ...emptyWorkflow(), stage: 3 };
  assert.throws(() => restore(malformed), /Provide a product brief/);
});

test("standalone criterion editing resets only its review and owning feature, then removes generated tests", () => {
  const w = completeWorkflow();
  const ac = w.features[0]!.acceptance_criteria[0]!;
  const next = transition(w, { type: "saveArtifact", kind: "criterion", id: ac.acceptance_criteria_id,
    value: { ...ac, measurement: "Read back the selected item within 150 ms." } });
  assert.equal(next.stage, 2);
  assert.equal(next.features[0]?.review_status, "pending");
  assert.equal(next.features[0]?.acceptance_criteria[0]?.validation_status, "pending");
  assert.equal(next.features[1]?.review_status, "confirmed");
  assert.deepEqual(next.scenarios, w.scenarios.filter(s => s.acceptance_criteria_id !== ac.acceptance_criteria_id));
  assert.deepEqual(next.test_cases, w.test_cases.filter(t => t.acceptance_criteria_id !== ac.acceptance_criteria_id));
  assert.throws(() => transition(w, { type: "saveArtifact", kind: "criterion", id: ac.acceptance_criteria_id,
    value: { ...ac, requirement_id: "RQ-002" } }), /linkage/);
});

test("impact preview enumerates exact dependent removals and review resets, without side effects", () => {
  const before = completeWorkflow();
  const ac = before.features[0]!.acceptance_criteria[0]!;
  const action = { type: "saveArtifact", kind: "criterion", id: ac.acceptance_criteria_id,
    value: { ...ac, then: "Changed outcome" } } as const;
  const after = transition(before, action);
  const impact = impactPreview(before, after);
  assert.deepEqual(impact.removed, [...before.scenarios.filter(s => s.acceptance_criteria_id === ac.acceptance_criteria_id).map(s => s.scenario_id),
    ...before.test_cases.filter(t => t.acceptance_criteria_id === ac.acceptance_criteria_id).map(t => t.test_case_id)]);
  assert.deepEqual(impact.reviews_reset, ["RQ-001", ac.acceptance_criteria_id]);
  assert.ok(needsImpactConfirmation(action, impact));
  assert.equal(impact.revision, before.revision);
  assert.equal(before.coverage.overall_score, 100);
  const s = before.scenarios[0]!;
  const scenarioAction = { type: "saveArtifact", kind: "scenario", id: s.scenario_id, value: { ...s, when: "Changed action" } } as const;
  const scenarioImpact = impactPreview(before, transition(before, scenarioAction));
  assert.deepEqual(scenarioImpact.removed, []);
  assert.deepEqual(scenarioImpact.reviews_reset, [s.scenario_id, before.test_cases[0]!.test_case_id]);
  assert.ok(needsImpactConfirmation(scenarioAction, scenarioImpact));
});

test("eligibility uses host validators and lists explicit saved-artifact confirmation blockers", () => {
  const draft = transition(confirmedFeatures(), { type: "proceed" });
  const checks = eligibility(draft);
  assert.ok(checks[draft.scenarios[0]!.scenario_id]?.includes("Reviewer notes are required."));
  assert.ok(checks[draft.test_cases[0]!.test_case_id]?.includes("Confirm the parent scenario first."));
  const done = completeWorkflow();
  assert.ok(Object.values(eligibility(done)).every(errors => errors.length === 0));
});

test("one clarification specification drives prompts, gates and coverage", () => {
  const analyzed = transition(emptyWorkflow(), { type: "analyze", brief: "Stock", links: [] });
  assert.deepEqual(analyzed.product.items.map(i => i.key), clarificationKeys);
  const w = completeWorkflow();
  w.product.items = w.product.items.filter(item => item.key !== "security");
  assert.ok(stageOneErrors(w).includes("Missing required clarification: security."));
  assert.ok(calculateCoverage(w).checks.some(c => c.target_id === "missing:security" && !c.passed));
});

test("generation revision changes across regeneration and is immutable in artifact edits", () => {
  let w = confirmedFeatures();
  const originalGeneration = w.features[0]!.generation_revision;
  const item = w.product.items.find(i => i.key === "intent")!;
  w = transition(w, { type: "resolve", id: item.id, answer: `${item.answer} Release 2 changes the solution intent.`, notes: "Reconfirm intent." });
  w = transition(w, { type: "confirmItem", id: item.id });
  w = transition(w, { type: "confirmProduct", notes: "Reviewed", priority: "high", confidence: 90, traceConfidence: 90 });
  w = transition(w, { type: "proceed" });
  assert.ok(w.features[0]!.generation_revision! > originalGeneration!);
  const f = w.features[0]!;
  assert.throws(() => transition(w, { type: "saveArtifact", kind: "feature", id: f.requirement_id,
    value: { ...f, generation_revision: 1 } }), /Generation revision/);
});

test("unchanged saves, reordered object keys and derived fields are no-ops for every artifact type", () => {
  const w = completeWorkflow();
  const artifacts = [
    { kind: "feature", id: w.features[0]!.requirement_id, value: w.features[0]! },
    { kind: "criterion", id: w.features[0]!.acceptance_criteria[0]!.acceptance_criteria_id, value: w.features[0]!.acceptance_criteria[0]! },
    { kind: "scenario", id: w.scenarios[0]!.scenario_id, value: w.scenarios[0]! },
    { kind: "test", id: w.test_cases[0]!.test_case_id, value: w.test_cases[0]! }
  ] as const;
  for (const artifact of artifacts) {
    const value = Object.fromEntries(Object.entries(artifact.value).reverse());
    value.open_items_count = 999;
    const next = transition(w, { type: "saveArtifact", ...artifact, value });
    assert.deepEqual(next, w);
    assert.deepEqual(impactPreview(w, next).removed, []);
  }
});

test("metadata-only edits retain descendant content/reviews and restore safely while upstream review is pending", () => {
  const w = completeWorkflow();
  const f = w.features[0]!;
  const edited = transition(w, { type: "saveArtifact", kind: "feature", id: f.requirement_id,
    value: { ...f, reviewer_notes: "Additional rationale." } });
  assert.deepEqual(edited.scenarios, w.scenarios);
  assert.deepEqual(edited.test_cases, w.test_cases);
  assert.equal(edited.features[0]!.review_status, "pending");
  assert.deepEqual(restore(edited), edited);
  const reviewed = transition(edited, { type: "confirmArtifact", kind: "feature", id: f.requirement_id });
  assert.equal(reviewed.coverage.overall_score, 100);
  const s = w.scenarios[0]!;
  const scenarioMetadata = transition(w, { type: "saveArtifact", kind: "scenario", id: s.scenario_id,
    value: { ...s, confidence_score: 95 } });
  assert.deepEqual(scenarioMetadata.test_cases, w.test_cases);
  assert.ok(scenarioMetadata.coverage.overall_score < 100);
});

test("scoped regeneration preserves unrelated identities, content and reviews", () => {
  const w = completeWorkflow();
  const f = w.features[0]!;
  const ac = f.acceptance_criteria[0]!;
  let next = transition(w, { type: "saveArtifact", kind: "criterion", id: ac.acceptance_criteria_id,
    value: { ...ac, measurement: "Read back exactly one item within 150 ms." } });
  assert.deepEqual(restore(next), next);
  assert.throws(() => transition(next, { type: "proceed" }), /confirmed/);
  next = transition(next, { type: "confirmArtifact", kind: "criterion", id: ac.acceptance_criteria_id });
  next = transition(next, { type: "confirmArtifact", kind: "feature", id: f.requirement_id });
  assert.equal(next.stage, 2);
  next = transition(next, { type: "proceed" });
  assert.equal(next.stage, 3);
  assert.equal(next.scenarios.length, 12);
  assert.equal(new Set(next.scenarios.map(s => s.scenario_id)).size, 12);
  assert.equal(new Set(next.test_cases.map(t => t.test_case_id)).size, 12);
  assert.deepEqual(next.scenarios.filter(s => s.requirement_id !== f.requirement_id),
    w.scenarios.filter(s => s.requirement_id !== f.requirement_id));
  assert.deepEqual(next.test_cases.filter(t => t.requirement_id !== f.requirement_id),
    w.test_cases.filter(t => t.requirement_id !== f.requirement_id));
  assert.ok(next.scenarios.filter(s => s.requirement_id === f.requirement_id)
    .every(s => s.review_status === "pending" && s.generation_revision === next.revision));
});

test("adding a criterion preserves existing test work and only generates its six categories", () => {
  const w = completeWorkflow();
  const f = w.features[0]!;
  let next = transition(w, { type: "addCriterion", id: f.requirement_id });
  assert.deepEqual(next.scenarios, w.scenarios);
  const ac = next.features[0]!.acceptance_criteria.at(-1)!;
  next = transition(next, { type: "saveArtifact", kind: "criterion", id: ac.acceptance_criteria_id,
    value: criterionReady({ ...ac, given: "Authorized clerk", when: "Create another item", then: "One item is persisted" }) });
  next = transition(next, { type: "confirmArtifact", kind: "criterion", id: ac.acceptance_criteria_id });
  next = transition(next, { type: "confirmArtifact", kind: "feature", id: f.requirement_id });
  next = transition(next, { type: "proceed" });
  assert.equal(next.scenarios.length, 18);
  assert.deepEqual(next.scenarios.slice(0, 12), w.scenarios);
  assert.deepEqual(next.test_cases.slice(0, 12), w.test_cases);
});

test("every export explicitly distinguishes planned structural coverage from execution", () => {
  const w = completeWorkflow();
  const json = JSON.parse(exportArtifact(w, 3, "json"));
  assert.match(json.coverage_scope, /not executed test coverage/);
  assert.match(exportArtifact(w, 3, "markdown"), /not executed test coverage/);
});

test("clarification notes and product review metadata do not destroy unchanged downstream work", () => {
  const w = completeWorkflow();
  const item = w.product.items[0]!;
  let edited = transition(w, { type: "resolve", id: item.id, answer: item.answer, notes: "Additional rationale." });
  assert.equal(edited.stage, 1);
  assert.deepEqual(edited.test_cases, w.test_cases);
  assert.deepEqual(restore(edited), edited);
  edited = transition(edited, { type: "confirmItem", id: item.id });
  edited = transition(edited, { type: "confirmProduct", notes: "Updated rationale.", priority: "high", confidence: 95, traceConfidence: 95 });
  assert.deepEqual(edited.scenarios, w.scenarios);
  assert.deepEqual(edited.test_cases, w.test_cases);
  assert.equal(edited.coverage.overall_score, 100);
});

test("repeated artifact confirmations are idempotent and do not undo owning reviews", () => {
  const w = completeWorkflow();
  for (const [kind, id] of [
    ["feature", w.features[0]!.requirement_id],
    ["criterion", w.features[0]!.acceptance_criteria[0]!.acceptance_criteria_id],
    ["scenario", w.scenarios[0]!.scenario_id],
    ["test", w.test_cases[0]!.test_case_id]
  ] as const) {
    assert.deepEqual(transition(w, { type: "confirmArtifact", kind, id }), w);
  }
});

test("proceed repairs missing cases in a structurally valid restored draft without replacing scenarios", () => {
  const w = completeWorkflow();
  const missing = w.test_cases[0]!;
  w.test_cases = w.test_cases.slice(1);
  const restored = restore(w);
  assert.equal(restored.stage, 2);
  const regenerated = transition(restored, { type: "proceed" });
  assert.equal(regenerated.stage, 3);
  assert.deepEqual(regenerated.scenarios, restored.scenarios);
  assert.equal(regenerated.test_cases.length, 12);
  assert.equal(regenerated.test_cases.at(-1)!.scenario_id, missing.scenario_id);
  assert.deepEqual(regenerated.test_cases.slice(0, 11), restored.test_cases);
});
