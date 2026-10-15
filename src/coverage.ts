import { ArtifactReference, CoverageCheck, CoverageMetrics, Stage, Workflow, categories } from "./model";
import { caseErrors, criterionErrors, featureErrors, nonempty, scenarioErrors, stageOneErrors } from "./validation";
import { clarificationKeys } from "./clarifications";

function percentage(passed: number, total: number): number {
  if (total === 0) return 0;
  return passed === total ? 100 : Math.min(99.9, Math.floor(passed / total * 1000) / 10);
}

export function calculateCoverage(w: Workflow): CoverageMetrics {
  const checks: CoverageCheck[] = [];
  const references: ArtifactReference[] = [];
  const check = (stage: Stage, direction: CoverageCheck["direction"], source: string,
    target: string, description: string, passed: boolean): void => {
    checks.push({ id: `CHECK-${checks.length + 1}`, stage, direction,
      source_id: source, target_id: target, description, passed });
  };
  const node = (id: string, kind: ArtifactReference["kind"], stage: Stage): void => {
    references.push({ id, kind, stage, forward_references: [], reverse_references: [] });
  };
  const p = w.product;
  const productReady = stageOneErrors(w).length === 0;
  const features = new Map(w.features.map(f => [f.requirement_id, f]));
  const criteria = new Map(w.features.flatMap(f => f.acceptance_criteria.map(ac => [ac.acceptance_criteria_id, ac] as const)));
  const scenariosById = new Map(w.scenarios.map(s => [s.scenario_id, s]));
  const featureValid = new Map(w.features.map(f => [f.requirement_id, featureErrors(f).length === 0]));
  const criterionValid = new Map([...criteria.values()].map(ac => [ac.acceptance_criteria_id, criterionErrors(ac).length === 0]));
  const scenarioValid = new Map(w.scenarios.map(s => [s.scenario_id, scenarioErrors(s).length === 0]));
  const caseValid = new Map(w.test_cases.map(t => [t.test_case_id, caseErrors(t).length === 0]));
  const coveredScenarios = new Set(w.test_cases.filter(t => {
    const s = scenariosById.get(t.scenario_id);
    return s && s.requirement_id === t.requirement_id && s.acceptance_criteria_id === t.acceptance_criteria_id &&
      t.review_status === "confirmed" && caseValid.get(t.test_case_id);
  }).map(t => t.scenario_id));
  const coveredCategories = new Set(w.scenarios.filter(s => s.review_status === "confirmed" &&
    scenarioValid.get(s.scenario_id) && coveredScenarios.has(s.scenario_id))
    .map(s => `${s.requirement_id}/${s.acceptance_criteria_id}/${s.category}`));
  node(p.requirement_id, "product", 1);
  check(1, "review", p.requirement_id, p.requirement_id, "Product definition and review complete", productReady);
  for (const key of clarificationKeys) {
    const item = p.items.find(i => i.key === key);
    check(1, "forward", p.requirement_id, item?.id ?? `missing:${key}`,
      `Required clarification exists: ${key}`, item !== undefined);
  }
  for (const item of p.items) {
    node(item.id, "clarification", 1);
    check(1, "review", item.id, p.requirement_id, "Answer and reviewer notes saved",
      nonempty(item.answer) && nonempty(item.reviewer_notes));
    check(1, "review", item.id, p.requirement_id, "Resolution explicitly confirmed",
      item.resolution_status === "confirmed" && nonempty(item.answer) && nonempty(item.reviewer_notes));
  }
  const capabilities = p.items.find(i => i.key === "capabilities")?.answer.split(/\r?\n/)
    .map(s => s.trim()).filter(Boolean) ?? [];
  check(2, "forward", p.requirement_id, "capabilities", "Capabilities are defined and unique",
    capabilities.length > 0 && new Set(capabilities.map(s => s.toLowerCase())).size === capabilities.length);
  for (const [index] of capabilities.entries()) {
    const id = `RQ-${String(index + 1).padStart(3, "0")}`;
    check(2, "forward", p.requirement_id, id, "Capability has its generated feature", features.has(id));
  }
  check(2, "forward", p.requirement_id, "features", "At least one feature exists", w.features.length > 0);
  for (const f of w.features) {
    node(f.requirement_id, "feature", 2);
    const featureReady = productReady && f.review_status === "confirmed" && featureValid.get(f.requirement_id) === true;
    check(2, "reverse", f.requirement_id, p.requirement_id, "Feature resolves to reviewed product",
      f.product_requirement_id === p.requirement_id && productReady);
    check(2, "review", f.requirement_id, f.requirement_id, "Feature metadata, INVEST and review complete", featureReady);
    check(2, "forward", f.requirement_id, "acceptance-criteria", "Feature has acceptance criteria", f.acceptance_criteria.length > 0);
    for (const ac of f.acceptance_criteria) {
      node(ac.acceptance_criteria_id, "criterion", 2);
      const acReady = featureReady && ac.requirement_id === f.requirement_id &&
        ac.review_status === "confirmed" && ac.validation_status === "validated" && criterionValid.get(ac.acceptance_criteria_id) === true;
      check(2, "reverse", ac.acceptance_criteria_id, f.requirement_id, "AC resolves through feature to reviewed product", acReady);
      check(2, "review", ac.acceptance_criteria_id, ac.acceptance_criteria_id, "AC metadata, SMART and validation complete",
        ac.review_status === "confirmed" && ac.validation_status === "validated" && criterionValid.get(ac.acceptance_criteria_id) === true);
      for (const category of categories) {
        check(3, "forward", ac.acceptance_criteria_id, `${ac.acceptance_criteria_id}:${category}`,
          `${category}: reviewed scenario and case cover this AC`, acReady &&
            coveredCategories.has(`${f.requirement_id}/${ac.acceptance_criteria_id}/${category}`));
      }
    }
  }
  check(3, "forward", p.requirement_id, "scenarios", "At least one scenario exists", w.scenarios.length > 0);
  check(3, "forward", p.requirement_id, "test-cases", "At least one test case exists", w.test_cases.length > 0);
  const lineageReady = (requirement: string, criterion: string): boolean => {
    const f = features.get(requirement);
    const ac = criteria.get(criterion);
    return productReady && f !== undefined && f.product_requirement_id === p.requirement_id &&
      f.review_status === "confirmed" && featureValid.get(requirement) === true && ac !== undefined && ac.requirement_id === requirement &&
      ac.review_status === "confirmed" && ac.validation_status === "validated" && criterionValid.get(criterion) === true;
  };
  for (const s of w.scenarios) {
    node(s.scenario_id, "scenario", 3);
    check(3, "reverse", s.scenario_id, s.acceptance_criteria_id, "Scenario resolves through AC and feature to reviewed product",
      lineageReady(s.requirement_id, s.acceptance_criteria_id));
    check(3, "review", s.scenario_id, s.scenario_id, "Scenario metadata and review complete",
      s.review_status === "confirmed" && scenarioValid.get(s.scenario_id) === true);
    check(3, "forward", s.scenario_id, "test-cases", "Scenario has a reviewed, correctly linked case",
      coveredScenarios.has(s.scenario_id));
  }
  for (const t of w.test_cases) {
    node(t.test_case_id, "test", 3);
    const s = scenariosById.get(t.scenario_id);
    check(3, "reverse", t.test_case_id, t.scenario_id, "Case resolves through reviewed scenario, AC, feature and product",
      s !== undefined && s.requirement_id === t.requirement_id && s.acceptance_criteria_id === t.acceptance_criteria_id &&
      s.review_status === "confirmed" && scenarioValid.get(s.scenario_id) === true && lineageReady(t.requirement_id, t.acceptance_criteria_id));
    check(3, "review", t.test_case_id, t.test_case_id, "Case metadata, steps, data and review complete",
      t.review_status === "confirmed" && caseValid.get(t.test_case_id) === true);
  }
  const byId = new Map(references.map(reference => [reference.id, reference]));
  const link = (parent: string, child: string): void => {
    const source = byId.get(parent);
    const target = byId.get(child);
    if (source && target) {
      source.forward_references.push(child);
      target.reverse_references.push(parent);
    }
  };
  for (const item of p.items) link(p.requirement_id, item.id);
  for (const f of w.features) {
    link(f.product_requirement_id, f.requirement_id);
    for (const ac of f.acceptance_criteria) link(ac.requirement_id, ac.acceptance_criteria_id);
  }
  for (const s of w.scenarios) {
    if (features.has(s.requirement_id) && criteria.get(s.acceptance_criteria_id)?.requirement_id === s.requirement_id) {
      link(s.acceptance_criteria_id, s.scenario_id);
    }
  }
  for (const t of w.test_cases) {
    const s = scenariosById.get(t.scenario_id);
    if (s?.requirement_id === t.requirement_id && s.acceptance_criteria_id === t.acceptance_criteria_id) link(t.scenario_id, t.test_case_id);
  }
  const stages = ([1, 2, 3] as const).map(stage => {
    const list = checks.filter(c => c.stage === stage);
    const passed = list.filter(c => c.passed).length;
    return { stage, score: percentage(passed, list.length), passed_checks: passed, total_checks: list.length };
  });
  const mean = stages.reduce((sum, stage) => sum + stage.score, 0) / 3;
  return {
    methodology: "balanced-stage-checks-v1",
    overall_score: stages.every(stage => stage.score === 100) ? 100 : Math.min(99.9, Math.floor(mean * 10) / 10),
    stages, checks, references
  };
}
