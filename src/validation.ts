import { AutomationStatus, Criterion, Feature, Review, Scenario, TestCase, Workflow, categories } from "./model";
import { clarificationKeys } from "./clarifications";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function score(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function oneOf(value: unknown, choices: readonly unknown[]): boolean {
  return choices.includes(value);
}

export function requireFields(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function automation(value: { automation_candidate: boolean; automation_status: AutomationStatus }): string[] {
  const errors: string[] = [];
  if (typeof value.automation_candidate !== "boolean") errors.push("Automation candidate must be boolean.");
  if (!oneOf(value.automation_status, ["not-assessed", "planned", "automated", "manual"])) {
    errors.push("Select a valid automation status.");
  }
  if (!value.automation_candidate && ["planned", "automated"].includes(value.automation_status)) {
    errors.push("Planned/automated artifacts must be automation candidates.");
  }
  return errors;
}

export function reviewErrors(value: Review): string[] {
  const errors: string[] = [];
  if (!nonempty(value.reviewer_notes)) errors.push("Reviewer notes are required.");
  if (!score(value.confidence_score)) errors.push("Confidence must be between 0 and 100.");
  if (!oneOf(value.business_priority, ["high", "medium", "low"])) errors.push("Business priority is required.");
  if (!oneOf(value.severity, ["critical", "high", "medium", "low"])) errors.push("Severity is required.");
  return errors;
}

export function criterionErrors(ac: Criterion): string[] {
  return [
    ...reviewErrors(ac), ...automation(ac),
    ...(!isRecord(ac.smart_review) ||
      !["specific", "measurable", "achievable", "relevant", "time_bound"]
        .every(key => ac.smart_review[key as keyof typeof ac.smart_review] === true) ?
      ["Review and affirm all five SMART principles, with exact measurement and a time/condition bound."] : []),
    ...(["given", "when", "then", "measurement"] as const)
      .filter(key => !nonempty(ac[key])).map(key => `Acceptance criterion ${key} is required.`)
  ];
}

export function featureErrors(feature: Feature): string[] {
  const errors = [...reviewErrors(feature), ...automation(feature)];
  for (const key of ["title", "description", "scope", "constraints"] as const) {
    if (!nonempty(feature[key])) errors.push(`Feature ${key} is required.`);
  }
  if (!Array.isArray(feature.dependencies) || !feature.dependencies.length || !feature.dependencies.every(nonempty)) {
    errors.push("List dependencies, or explicitly state 'None'.");
  }
  if (!isRecord(feature.invest_review) ||
      !["independent", "negotiable", "valuable", "estimable", "small", "testable"].every(key => feature.invest_review[key as keyof typeof feature.invest_review] === true)) {
    errors.push("Review and affirm all six INVEST principles; split unsuitable features before confirming.");
  }
  if (!Array.isArray(feature.acceptance_criteria) || !feature.acceptance_criteria.length) {
    errors.push("At least one acceptance criterion is required.");
  } else {
    for (const ac of feature.acceptance_criteria) {
      errors.push(...criterionErrors(ac).map(error => `${ac.acceptance_criteria_id}: ${error}`));
      if (ac.review_status !== "confirmed" || ac.validation_status !== "validated") {
        errors.push(`${ac.acceptance_criteria_id} must be validated and confirmed.`);
      }
    }
  }
  return errors;
}

export function scenarioErrors(scenario: Scenario): string[] {
  const errors = [...reviewErrors(scenario), ...automation(scenario)];
  for (const key of ["title", "given", "when", "then", "design_technique"] as const) {
    if (!nonempty(scenario[key])) errors.push(`Scenario ${key} is required.`);
  }
  if (!score(scenario.traceability_confidence)) errors.push("Traceability confidence must be between 0 and 100.");
  return errors;
}

export function caseErrors(test: TestCase): string[] {
  const errors = [...reviewErrors(test), ...automation(test)];
  for (const key of ["title", "test_data", "environment_considerations"] as const) {
    if (!nonempty(test[key])) errors.push(`Test case ${key} is required.`);
  }
  if (!Array.isArray(test.preconditions) || !test.preconditions.length || !test.preconditions.every(nonempty)) {
    errors.push("At least one precondition is required.");
  }
  if (!Array.isArray(test.steps) || !test.steps.length ||
      !test.steps.every(step => isRecord(step) && nonempty(step.action) && nonempty(step.expected_result))) {
    errors.push("Every test step needs an action and an expected result.");
  }
  if (!score(test.traceability_confidence)) errors.push("Traceability confidence must be between 0 and 100.");
  return errors;
}

export function stageOneErrors(workflow: Workflow): string[] {
  const p = workflow.product;
  const errors: string[] = [];
  if (!nonempty(p.brief)) errors.push("Provide a product brief.");
  if (!p.items.length) errors.push("Analyze the brief first.");
  else for (const key of clarificationKeys) {
    if (!p.items.some(item => item.key === key)) errors.push(`Missing required clarification: ${key}.`);
  }
  for (const item of p.items) {
    if (!nonempty(item.answer) || item.resolution_status !== "confirmed" || !nonempty(item.reviewer_notes)) {
      errors.push(`${item.id}: resolve and confirm with reviewer notes.`);
    }
  }
  if (!nonempty(p.reviewer_notes)) errors.push("Product reviewer notes are required.");
  if (!score(p.confidence_score) || !score(p.traceability_confidence_score)) errors.push("Product confidence scores must be between 0 and 100.");
  if (!oneOf(p.business_priority, ["high", "medium", "low"])) errors.push("Product business priority is required.");
  if (p.review_status !== "confirmed") errors.push("Confirm the product definition.");
  return errors;
}

export function stageTwoErrors(workflow: Workflow): string[] {
  const errors = stageOneErrors(workflow);
  if (!workflow.features.length) errors.push("Generate and review features.");
  for (const feature of workflow.features) {
    errors.push(...featureErrors(feature).map(error => `${feature.requirement_id}: ${error}`));
    if (feature.review_status !== "confirmed") errors.push(`${feature.requirement_id} needs confirmation.`);
  }
  return errors;
}

export function stageThreeErrors(workflow: Workflow): string[] {
  const errors = stageTwoErrors(workflow);
  for (const feature of workflow.features) {
    for (const ac of feature.acceptance_criteria) {
      for (const category of categories) {
        if (!workflow.scenarios.some(s => s.requirement_id === feature.requirement_id &&
            s.acceptance_criteria_id === ac.acceptance_criteria_id && s.category === category)) {
          errors.push(`${ac.acceptance_criteria_id}: missing ${category} coverage.`);
        }
      }
    }
  }
  for (const scenario of workflow.scenarios) {
    errors.push(...scenarioErrors(scenario).map(error => `${scenario.scenario_id}: ${error}`));
    if (scenario.review_status !== "confirmed") errors.push(`${scenario.scenario_id} needs confirmation.`);
    if (!workflow.test_cases.some(t => t.scenario_id === scenario.scenario_id)) errors.push(`${scenario.scenario_id} needs a test case.`);
  }
  for (const test of workflow.test_cases) {
    errors.push(...caseErrors(test).map(error => `${test.test_case_id}: ${error}`));
    if (test.review_status !== "confirmed") errors.push(`${test.test_case_id} needs confirmation.`);
  }
  return errors;
}

// Stored data and webview JSON are untrusted; validate shape before typed access.
export function decodeWorkflow(value: unknown): Workflow {
  assertWorkflow(value);
  return value;
}

function assertWorkflow(value: unknown): asserts value is Workflow {
  requireFields(isRecord(value) && value.schema_version === 1 && value.engine === "local-rules" &&
    oneOf(value.stage, [1, 2, 3]) && Number.isInteger(value.revision) && Number(value.revision) >= 0 &&
    nonempty(value.updated_at), "Unsupported or malformed workflow.");
  const p = value.product;
  requireFields(isRecord(p) && p.requirement_id === "PRD-001" && typeof p.brief === "string" &&
    Array.isArray(p.intent_links) && p.intent_links.every(nonempty) && Array.isArray(p.items) &&
    oneOf(p.clarity_status, ["unreviewed", "needs-clarification", "clear"]) &&
    oneOf(p.ambiguity_resolution_status, ["unreviewed", "unresolved", "resolved"]) &&
    oneOf(p.review_status, ["pending", "confirmed"]) && typeof p.reviewer_notes === "string" &&
    score(p.confidence_score) && score(p.traceability_confidence_score) &&
    oneOf(p.business_priority, ["high", "medium", "low"]) &&
    oneOf(p.severity_of_missing_info, ["critical", "high", "medium", "low"]) &&
    Number.isInteger(p.open_items_count), "Malformed product metadata.");
  for (const item of p.items) {
    requireFields(isRecord(item) && nonempty(item.id) && nonempty(item.key) && nonempty(item.prompt) &&
      typeof item.suggestion === "string" && typeof item.answer === "string" && typeof item.reviewer_notes === "string" &&
      oneOf(item.kind, ["question", "ambiguity", "missing-information", "confirmation"]) &&
      oneOf(item.resolution_status, ["open", "answered", "confirmed"]) &&
      oneOf(item.severity_of_missing_info, ["critical", "high", "medium", "low"]), "Malformed clarification item.");
  }
  function shapeReview(record: Record<string, unknown>): void {
    requireFields(record.generation_revision === undefined ||
      (Number.isInteger(record.generation_revision) && Number(record.generation_revision) >= 0),
    "Invalid generation revision.");
    requireFields(oneOf(record.review_status, ["pending", "confirmed"]) &&
      typeof record.reviewer_notes === "string" && score(record.confidence_score) &&
      oneOf(record.business_priority, ["high", "medium", "low"]) &&
      oneOf(record.severity, ["critical", "high", "medium", "low"]) &&
      Number.isInteger(record.open_items_count) && typeof record.automation_candidate === "boolean" &&
      oneOf(record.automation_status, ["not-assessed", "planned", "automated", "manual"]),
    "Malformed artifact review metadata.");
  }
  const featureIds = new Set<string>();
  const acIds = new Set<string>();
  requireFields(Array.isArray(value.features), "Features must be an array.");
  for (const f of value.features) {
    requireFields(isRecord(f) && nonempty(f.requirement_id) && f.product_requirement_id === p.requirement_id &&
      !featureIds.has(f.requirement_id), "Invalid or duplicate feature linkage.");
    featureIds.add(f.requirement_id);
    shapeReview(f);
    const invest = f.invest_review;
    requireFields(["title", "description", "scope", "constraints", "traceability_matrix_reference"].every(key => typeof f[key] === "string") &&
      Array.isArray(f.dependencies) && f.dependencies.every(x => typeof x === "string") &&
      isRecord(invest) && ["independent", "negotiable", "valuable", "estimable", "small", "testable"]
        .every(key => typeof invest[key] === "boolean") &&
      Array.isArray(f.acceptance_criteria), "Malformed feature.");
    for (const ac of f.acceptance_criteria) {
      requireFields(isRecord(ac) && nonempty(ac.acceptance_criteria_id) && !acIds.has(ac.acceptance_criteria_id) &&
        ac.requirement_id === f.requirement_id, "Invalid or duplicate acceptance criterion linkage.");
      acIds.add(ac.acceptance_criteria_id);
      shapeReview(ac);
      const smart = ac.smart_review;
      requireFields(["given", "when", "then", "measurement", "traceability_matrix_reference"].every(key => typeof ac[key] === "string") &&
        isRecord(smart) && ["specific", "measurable", "achievable", "relevant", "time_bound"].every(key => typeof smart[key] === "boolean") &&
        oneOf(ac.validation_status, ["pending", "validated"]), "Malformed acceptance criterion.");
    }
  }
  requireFields(Array.isArray(value.scenarios) && Array.isArray(value.test_cases) && Array.isArray(value.traceability_matrix),
    "Scenarios, test cases and traceability must be arrays.");
  const scenarioIds = new Set<string>();
  for (const s of value.scenarios) {
    requireFields(isRecord(s) && nonempty(s.scenario_id) && !scenarioIds.has(s.scenario_id) &&
      featureIds.has(String(s.requirement_id)) && acIds.has(String(s.acceptance_criteria_id)), "Invalid scenario linkage.");
    const parent = value.features.find(f => isRecord(f) && f.requirement_id === s.requirement_id);
    requireFields(isRecord(parent) && Array.isArray(parent.acceptance_criteria) &&
      parent.acceptance_criteria.some(ac => isRecord(ac) && ac.acceptance_criteria_id === s.acceptance_criteria_id),
    "Scenario AC belongs to a different requirement.");
    scenarioIds.add(s.scenario_id);
    shapeReview(s);
    requireFields(oneOf(s.category, categories) && score(s.traceability_confidence) &&
      ["title", "given", "when", "then", "gherkin", "design_technique"].every(key => typeof s[key] === "string"), "Malformed scenario.");
  }
  const caseIds = new Set<string>();
  for (const t of value.test_cases) {
    requireFields(isRecord(t) && nonempty(t.test_case_id) && !caseIds.has(t.test_case_id), "Invalid test case ID.");
    caseIds.add(t.test_case_id);
    const parent = value.scenarios.find(s => isRecord(s) && s.scenario_id === t.scenario_id);
    requireFields(isRecord(parent) && parent.requirement_id === t.requirement_id &&
      parent.acceptance_criteria_id === t.acceptance_criteria_id, "Invalid test case linkage.");
    shapeReview(t);
    requireFields(score(t.traceability_confidence) &&
      ["title", "test_data", "environment_considerations"].every(key => typeof t[key] === "string") &&
      Array.isArray(t.preconditions) && t.preconditions.every(x => typeof x === "string") &&
      Array.isArray(t.steps) && t.steps.every(step => isRecord(step) && typeof step.action === "string" &&
        typeof step.expected_result === "string"), "Malformed test case.");
  }
  for (const row of value.traceability_matrix) {
    requireFields(isRecord(row) &&
      ["product_requirement_id", "requirement_id", "acceptance_criteria_id", "scenario_id", "test_case_id"].every(key => nonempty(row[key])),
    "Malformed traceability row.");
  }
}
