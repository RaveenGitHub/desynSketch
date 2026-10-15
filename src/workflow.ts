import {
  Category, Criterion, Feature, OpenItem, Priority, Review, Scenario, Severity, Stage,
  Workflow, categories, emptyWorkflow
} from "./model";
import {
  caseErrors, criterionErrors, decodeWorkflow, featureErrors, isRecord, nonempty,
  requireFields, scenarioErrors, score, stageOneErrors, stageThreeErrors, stageTwoErrors
} from "./validation";
import { calculateCoverage } from "./coverage";
import { clarificationSpec as questions } from "./clarifications";

const derivedFields = new Set(["review_status", "validation_status", "open_items_count", "gherkin", "traceability_matrix_reference"]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).filter(key => !derivedFields.has(key)).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function changed(before: unknown, after: unknown, keys: string[]): boolean {
  requireFields(isRecord(before) && isRecord(after), "Invalid artifact comparison.");
  return keys.some(key => canonical(before[key]) !== canonical(after[key]));
}

function removeTests(w: Workflow, criteria: Set<string>): void {
  w.scenarios = w.scenarios.filter(s => !criteria.has(s.acceptance_criteria_id));
  w.test_cases = w.test_cases.filter(t => !criteria.has(t.acceptance_criteria_id));
  w.traceability_matrix = w.traceability_matrix.filter(t => !criteria.has(t.acceptance_criteria_id));
}

function hasCompleteTestStructure(w: Workflow): boolean {
  const present = new Set(w.scenarios.map(s => `${s.acceptance_criteria_id}:${s.category}`));
  const covered = new Set(w.test_cases.map(t => t.scenario_id));
  return w.scenarios.length > 0 && w.features.every(f => f.acceptance_criteria.every(ac =>
    categories.every(category => present.has(`${ac.acceptance_criteria_id}:${category}`)))) &&
    w.scenarios.every(s => covered.has(s.scenario_id));
}

const vagueTerms = /\b(fast|easy|simple|intuitive|user[- ]friendly|scalable|robust|secure|seamless|real[- ]time|etc|as needed|appropriate)\b/gi;
const severityRank: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function review(priority: Priority, severity: Severity = "medium"): Review {
  return {
    review_status: "pending", reviewer_notes: "", confidence_score: 0,
    business_priority: priority, severity, open_items_count: 1
  };
}

export function gherkin(s: Pick<Scenario, "scenario_id" | "requirement_id" | "acceptance_criteria_id" | "category" | "title" | "given" | "when" | "then">): string {
  const line = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();
  return `@${s.requirement_id} @${s.acceptance_criteria_id} @${s.scenario_id} @${s.category}\nScenario: ${line(s.title)}\n  Given ${line(s.given)}\n  When ${line(s.when)}\n  Then ${line(s.then)}`;
}

function answer(w: Workflow, key: string): string {
  const item = w.product.items.find(i => i.key === key);
  requireFields(item !== undefined && nonempty(item.answer), `Missing clarification: ${key}.`);
  return item.answer.trim();
}

export function refresh(w: Workflow): void {
  const p = w.product;
  const open = p.items.filter(i => i.resolution_status !== "confirmed" || !nonempty(i.answer) || !nonempty(i.reviewer_notes));
  p.open_items_count = open.length + (p.review_status === "confirmed" ? 0 : 1);
  p.clarity_status = !p.items.length ? "unreviewed" : p.open_items_count ? "needs-clarification" : "clear";
  p.ambiguity_resolution_status = !p.items.length ? "unreviewed" :
    p.items.some(i => i.kind === "ambiguity" && i.resolution_status !== "confirmed") ? "unresolved" : "resolved";
  p.severity_of_missing_info = open.reduce<Severity>(
    (level, item) => severityRank[item.severity_of_missing_info] > severityRank[level] ? item.severity_of_missing_info : level, "low");
  for (const f of w.features) {
    for (const ac of f.acceptance_criteria) {
      ac.traceability_matrix_reference = `${f.requirement_id}/${ac.acceptance_criteria_id}`;
      ac.open_items_count = criterionErrors(ac).length + (ac.review_status === "confirmed" && ac.validation_status === "validated" ? 0 : 1);
    }
    f.traceability_matrix_reference = f.requirement_id;
    f.open_items_count = featureErrors(f).length + (f.review_status === "confirmed" ? 0 : 1);
  }
  for (const s of w.scenarios) {
    s.gherkin = gherkin(s);
    s.open_items_count = scenarioErrors(s).length + (s.review_status === "confirmed" ? 0 : 1);
  }
  for (const t of w.test_cases) {
    t.open_items_count = caseErrors(t).length + (t.review_status === "confirmed" ? 0 : 1);
  }
  w.traceability_matrix = w.test_cases.map(t => ({
    product_requirement_id: p.requirement_id, requirement_id: t.requirement_id,
    acceptance_criteria_id: t.acceptance_criteria_id, scenario_id: t.scenario_id, test_case_id: t.test_case_id
  }));
  w.coverage = calculateCoverage(w);
  w.stage = stageOneErrors(w).length === 0 && w.features.length > 0 ?
    stageTwoErrors(w).length === 0 && hasCompleteTestStructure(w) ? 3 : 2 : 1;
}

function invalidate(w: Workflow, stage: Stage): void {
  if (stage === 1) {
    w.product.review_status = "pending";
    w.features = [];
  }
  if (stage <= 2) {
    w.scenarios = [];
    w.test_cases = [];
    w.traceability_matrix = [];
  }
  w.stage = Math.min(w.stage, stage) as Stage;
}

function analyze(w: Workflow, brief: string, links: string[]): void {
  requireFields(nonempty(brief), "Provide a nonempty product brief before analyzing.");
  for (const link of links) {
    let url: URL;
    try { url = new URL(link); } catch { throw new Error(`Invalid solution intent URL: ${link}`); }
    requireFields(["https:", "http:"].includes(url.protocol) && !url.username && !url.password,
      "Intent links must be HTTP(S) URLs without credentials.");
  }
  invalidate(w, 1);
  const p = w.product;
  p.brief = brief.trim();
  p.intent_links = [...new Set(links)];
  p.reviewer_notes = "";
  p.confidence_score = 0;
  p.traceability_confidence_score = 0;
  p.items = questions.map((q, index): OpenItem => ({
    id: `Q-${String(index + 1).padStart(3, "0")}`, kind: "missing-information",
    key: q.key, prompt: q.prompt, suggestion: q.suggestion, answer: "",
    resolution_status: "open", reviewer_notes: "", severity_of_missing_info: q.severity
  }));
  const terms = [...new Set([...brief.matchAll(vagueTerms)].map(match => match[0].toLowerCase()))];
  for (const term of terms) {
    p.items.push({
      id: `Q-${String(p.items.length + 1).padStart(3, "0")}`, kind: "ambiguity", key: `vague:${term}`,
      prompt: `Replace or precisely define "${term}" with observable criteria.`,
      suggestion: "Specify actor, context, measurable threshold, units and verification condition.",
      answer: "", resolution_status: "open", reviewer_notes: "", severity_of_missing_info: "high"
    });
  }
  for (const [index, link] of p.intent_links.entries()) {
    p.items.push({
      id: `Q-${String(p.items.length + 1).padStart(3, "0")}`, kind: "confirmation", key: `link:${index}`,
      prompt: `Confirm the authority, version and relevant intent of ${link}.`,
      suggestion: "Review the reference yourself and paste a summary or relevant excerpt. No network retrieval is performed.",
      answer: "", resolution_status: "open", reviewer_notes: "", severity_of_missing_info: "high"
    });
  }
}

function generateFeatures(w: Workflow): void {
  const capabilities = answer(w, "capabilities").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  requireFields(capabilities.length > 0 && capabilities.length <= 100, "Provide between 1 and 100 capability lines.");
  requireFields(new Set(capabilities.map(s => s.toLowerCase())).size === capabilities.length, "Capability lines must be unique.");
  w.features = capabilities.map((capability, index): Feature => {
    const id = `RQ-${String(index + 1).padStart(3, "0")}`;
    const acId = `AC-${String(index + 1).padStart(3, "0")}-01`;
    return {
      ...review(w.product.business_priority), generation_revision: w.revision + 1,
      requirement_id: id, product_requirement_id: w.product.requirement_id,
      title: capability, description: capability, scope: answer(w, "scope"),
      constraints: answer(w, "dependencies"), dependencies: [answer(w, "dependencies")],
      invest_review: { independent: false, negotiable: false, valuable: false, estimable: false, small: false, testable: false },
      automation_candidate: false, automation_status: "not-assessed", traceability_matrix_reference: id,
      acceptance_criteria: [{
        ...review(w.product.business_priority), generation_revision: w.revision + 1,
        acceptance_criteria_id: acId, requirement_id: id,
        given: answer(w, "actors"), when: capability, then: answer(w, "success"),
        measurement: "", validation_status: "pending", automation_candidate: false,
        smart_review: { specific: false, measurable: false, achievable: false, relevant: false, time_bound: false },
        automation_status: "not-assessed", traceability_matrix_reference: `${id}/${acId}`
      }]
    };
  });
}

function scenarioDraft(w: Workflow, f: Feature, ac: Criterion, category: Category, index: number): Scenario {
  const drafts: Record<Category, { given: string; when: string; then: string; technique: string; severity: Severity }> = {
    positive: {
      given: ac.given, when: ac.when, then: `${ac.then}; measured by ${ac.measurement}`,
      technique: "Equivalence partitioning: valid partition; decision-table happy path", severity: f.severity
    },
    negative: {
      given: `${ac.given}; invalid partition defined by: ${answer(w, "rules")}`,
      when: `Attempt ${ac.when} with the invalid partition`,
      then: `Observe the rejection and state behavior required by: ${answer(w, "rules")}`,
      technique: "Equivalence partitioning: invalid partition; decision-table rejection path", severity: "high"
    },
    boundary: {
      given: `${ac.given}; boundary contract: ${answer(w, "boundaries")}`,
      when: `Exercise ${ac.when} at each limit and immediately below/above it using the specified unit`,
      then: `Match each boundary outcome to: ${answer(w, "boundaries")}`,
      technique: "Three-value boundary value analysis; refine into individual boundary test cases", severity: "high"
    },
    "operational-risk": {
      given: `${ac.given}; recovery contract: ${answer(w, "operations")}`,
      when: `Simulate a documented dependency failure during ${ac.when} in the isolated test environment`,
      then: `Verify state transitions, recovery and observable evidence against: ${answer(w, "operations")}`,
      technique: "State transition testing; risk-based failure and recovery analysis", severity: "high"
    },
    security: {
      given: `An isolated authorized test environment with access policy: ${answer(w, "security")}`,
      when: `Attempt ${ac.when} using a documented unauthorized role and synthetic data`,
      then: `Verify denial, protected state and audit evidence required by: ${answer(w, "security")}`,
      technique: "Decision tables for access control; negative permission partition", severity: "critical"
    },
    performance: {
      given: `${ac.given}; workload and budgets: ${answer(w, "performance")}`,
      when: `Execute ${ac.when} under the documented workload and measurement interval`,
      then: `Compare collected measurements with every applicable budget: ${answer(w, "performance")}`,
      technique: "Risk-based load testing; workload partitioning and threshold analysis", severity: "high"
    }
  };
  const d = drafts[category];
  const s: Scenario = {
    ...review(f.business_priority, d.severity), generation_revision: w.revision + 1,
    scenario_id: `SC-${String(index).padStart(4, "0")}`,
    requirement_id: f.requirement_id, acceptance_criteria_id: ac.acceptance_criteria_id,
    category, title: `${f.title}: ${category}`, given: d.given, when: d.when, then: d.then,
    gherkin: "", design_technique: d.technique, automation_candidate: false,
    automation_status: "not-assessed", traceability_confidence: 100
  };
  s.gherkin = gherkin(s);
  return s;
}

function generateTests(w: Workflow): void {
  let scenarioIndex = Math.max(0, ...w.scenarios.map(s => Number(s.scenario_id.slice(3)) || 0));
  let caseIndex = Math.max(0, ...w.test_cases.map(t => Number(t.test_case_id.slice(3)) || 0));
  const present = new Set(w.scenarios.map(s => `${s.acceptance_criteria_id}:${s.category}`));
  for (const f of w.features) {
    for (const ac of f.acceptance_criteria) {
      for (const category of categories) {
        if (present.has(`${ac.acceptance_criteria_id}:${category}`)) continue;
        const s = scenarioDraft(w, f, ac, category, ++scenarioIndex);
        w.scenarios.push(s);
      }
    }
  }
  const covered = new Set(w.test_cases.map(t => t.scenario_id));
  for (const s of w.scenarios) {
    if (covered.has(s.scenario_id)) continue;
    w.test_cases.push({
      ...review(s.business_priority, s.severity),
      generation_revision: w.revision + 1,
      test_case_id: `TC-${String(++caseIndex).padStart(4, "0")}`,
      scenario_id: s.scenario_id, requirement_id: s.requirement_id, acceptance_criteria_id: s.acceptance_criteria_id,
      title: s.title, preconditions: [s.given], test_data: "",
      environment_considerations: answer(w, "environment"),
      steps: [
        { action: `Prepare fixtures and environment: ${answer(w, "environment")}`, expected_result: s.given },
        { action: s.when, expected_result: s.then }
      ],
      automation_candidate: false, automation_status: "not-assessed", traceability_confidence: 100
    });
  }
}

export type Action =
  | { type: "analyze"; brief: string; links: string[] }
  | { type: "resolve"; id: string; answer: string; notes: string }
  | { type: "confirmItem"; id: string }
  | { type: "confirmProduct"; notes: string; priority: Priority; confidence: number; traceConfidence: number }
  | { type: "proceed" }
  | { type: "navigate"; stage: Stage }
  | { type: "saveArtifact"; kind: "feature" | "criterion" | "scenario" | "test"; id: string; value: unknown }
  | { type: "confirmArtifact"; kind: "feature" | "criterion" | "scenario" | "test"; id: string }
  | { type: "addCriterion"; id: string }
  | { type: "addTestCase"; id: string };

export function decodeAction(value: unknown): Action {
  requireFields(isRecord(value), "Invalid workflow action.");
  const type = value.type;
  const id = value.id;
  switch (type) {
    case "analyze":
      requireFields(typeof value.brief === "string" && Array.isArray(value.links) && value.links.every(nonempty), "Invalid brief or links.");
      return { type, brief: value.brief, links: value.links };
    case "resolve":
      requireFields(nonempty(id) && typeof value.answer === "string" && typeof value.notes === "string", "Invalid resolution.");
      return { type, id, answer: value.answer, notes: value.notes };
    case "confirmItem":
    case "addCriterion":
    case "addTestCase":
      requireFields(nonempty(id), "An artifact ID is required.");
      return { type, id };
    case "confirmProduct":
      requireFields(nonempty(value.notes) && ["high", "medium", "low"].includes(String(value.priority)) &&
        score(value.confidence) && score(value.traceConfidence), "Product review requires notes, priority and confidence scores (0-100).");
      return { type, notes: value.notes, priority: value.priority as Priority, confidence: value.confidence, traceConfidence: value.traceConfidence };
    case "proceed": return { type };
    case "navigate":
      requireFields(value.stage === 1 || value.stage === 2 || value.stage === 3, "Invalid stage.");
      return { type, stage: value.stage };
    case "saveArtifact":
      requireFields(nonempty(id) && (value.kind === "feature" || value.kind === "criterion" || value.kind === "scenario" || value.kind === "test") &&
        isRecord(value.value), "Invalid artifact edit.");
      return { type, kind: value.kind, id, value: value.value };
    case "confirmArtifact":
      requireFields(nonempty(id) && (value.kind === "feature" || value.kind === "criterion" ||
        value.kind === "scenario" || value.kind === "test"), "Invalid artifact confirmation.");
      return { type, kind: value.kind, id };
    default: throw new Error("Unknown workflow action.");
  }
}

function assertNoErrors(errors: string[]): void {
  requireFields(errors.length === 0, errors.join("\n"));
}

export function transition(current: Workflow, action: Action): Workflow {
  const w = structuredClone(current);
  switch (action.type) {
    case "analyze": analyze(w, action.brief, action.links); break;
    case "resolve": {
      const item = w.product.items.find(i => i.id === action.id);
      requireFields(item !== undefined, "Unknown clarification item.");
      requireFields(nonempty(action.answer) && nonempty(action.notes), "Resolution and reviewer notes are required.");
      if (item.answer === action.answer.trim() && item.reviewer_notes === action.notes.trim()) return w;
      if (item.answer !== action.answer.trim()) invalidate(w, 1);
      else w.product.review_status = "pending";
      item.answer = action.answer.trim();
      item.reviewer_notes = action.notes.trim();
      item.resolution_status = "answered";
      break;
    }
    case "confirmItem": {
      const item = w.product.items.find(i => i.id === action.id);
      requireFields(item !== undefined && nonempty(item.answer) && nonempty(item.reviewer_notes), "Resolve the item with reviewer notes first.");
      if (item.resolution_status === "confirmed") return w;
      w.product.review_status = "pending";
      item.resolution_status = "confirmed";
      break;
    }
    case "confirmProduct": {
      requireFields(w.product.items.length > 0 && questions.every(q => w.product.items.some(i => i.key === q.key)) &&
        w.product.items.every(i => i.resolution_status === "confirmed" && nonempty(i.answer) && nonempty(i.reviewer_notes)),
      "Resolve and confirm every clarification first.");
      requireFields(nonempty(action.notes) && score(action.confidence) && score(action.traceConfidence) &&
        ["high", "medium", "low"].includes(action.priority), "Complete all product review metadata.");
      if (w.product.review_status === "confirmed" && w.product.reviewer_notes === action.notes.trim() &&
        w.product.business_priority === action.priority && w.product.confidence_score === action.confidence &&
        w.product.traceability_confidence_score === action.traceConfidence) return w;
      Object.assign(w.product, {
        reviewer_notes: action.notes.trim(), business_priority: action.priority, confidence_score: action.confidence,
        traceability_confidence_score: action.traceConfidence, review_status: "confirmed"
      });
      break;
    }
    case "proceed":
      if (w.stage === 1) {
        assertNoErrors(stageOneErrors(w));
        if (!w.features.length) generateFeatures(w);
        w.stage = 2;
      } else if (w.stage === 2) {
        assertNoErrors(stageTwoErrors(w));
        generateTests(w);
        w.stage = 3;
      } else {
        assertNoErrors(stageThreeErrors(w));
      }
      break;
    case "navigate":
      if (action.stage >= 2) assertNoErrors(stageOneErrors(w));
      if (action.stage >= 3) assertNoErrors(stageTwoErrors(w));
      requireFields(action.stage === 1 || (action.stage === 2 ? w.features.length > 0 : w.scenarios.length > 0),
        "Use Proceed to generate the next stage first.");
      return w;
    case "saveArtifact": if (!saveArtifact(w, action)) return w; break;
    case "confirmArtifact": if (!confirmArtifact(w, action.kind, action.id)) return w; break;
    case "addCriterion": {
      const f = w.features.find(feature => feature.requirement_id === action.id);
      requireFields(f !== undefined, "Unknown feature.");
      f.review_status = "pending";
      let suffix = f.acceptance_criteria.length + 1;
      while (f.acceptance_criteria.some(ac => ac.acceptance_criteria_id === `${f.requirement_id}-AC-${suffix}`)) suffix++;
      f.acceptance_criteria.push({
        ...review(f.business_priority), generation_revision: w.revision + 1,
        acceptance_criteria_id: `${f.requirement_id}-AC-${suffix}`,
        requirement_id: f.requirement_id, given: "", when: "", then: "", measurement: "",
        smart_review: { specific: false, measurable: false, achievable: false, relevant: false, time_bound: false },
        validation_status: "pending", automation_candidate: false, automation_status: "not-assessed",
        traceability_matrix_reference: ""
      });
      break;
    }
    case "addTestCase": {
      const s = w.scenarios.find(scenario => scenario.scenario_id === action.id);
      requireFields(s !== undefined, "Unknown scenario.");
      let index = w.test_cases.length + 1;
      while (w.test_cases.some(t => t.test_case_id === `TC-${String(index).padStart(4, "0")}`)) index++;
      w.test_cases.push({
        ...review(s.business_priority, s.severity), generation_revision: w.revision + 1,
        test_case_id: `TC-${String(index).padStart(4, "0")}`,
        scenario_id: s.scenario_id, requirement_id: s.requirement_id, acceptance_criteria_id: s.acceptance_criteria_id,
        title: s.title, preconditions: [s.given], test_data: "", environment_considerations: answer(w, "environment"),
        steps: [{ action: s.when, expected_result: s.then }], automation_candidate: false,
        automation_status: "not-assessed", traceability_confidence: 100
      });
      break;
    }
  }
  refresh(w);
  w.revision++;
  w.updated_at = new Date().toISOString();
  return w;
}

function saveArtifact(w: Workflow, action: Extract<Action, { type: "saveArtifact" }>): boolean {
  requireFields(isRecord(action.value), "Artifact must be a JSON object.");
  const v = structuredClone(action.value);
  if (action.kind === "criterion") {
    const f = w.features.find(feature => feature.acceptance_criteria.some(ac => ac.acceptance_criteria_id === action.id));
    const old = f?.acceptance_criteria.find(ac => ac.acceptance_criteria_id === action.id);
    requireFields(f !== undefined && old !== undefined && v.acceptance_criteria_id === old.acceptance_criteria_id &&
      v.requirement_id === old.requirement_id, "Criterion IDs and linkage cannot change.");
    requireFields(v.generation_revision === old.generation_revision, "Generation revision cannot change.");
    if (canonical(v) === canonical(old)) return false;
    v.review_status = "pending";
    v.validation_status = "pending";
    const candidate = {
      ...w, features: w.features.map(feature => feature.requirement_id === f.requirement_id ?
        { ...feature, review_status: "pending", acceptance_criteria: feature.acceptance_criteria.map(ac =>
          ac.acceptance_criteria_id === action.id ? v : ac) } : feature),
    };
    const decoded = decodeWorkflow(candidate);
    if (changed(old, v, ["given", "when", "then", "measurement"])) removeTests(w, new Set([old.acceptance_criteria_id]));
    w.features = decoded.features;
  } else if (action.kind === "feature") {
    const index = w.features.findIndex(f => f.requirement_id === action.id);
    const old = w.features[index];
    requireFields(old !== undefined && v.requirement_id === old.requirement_id &&
      v.product_requirement_id === old.product_requirement_id && Array.isArray(v.acceptance_criteria),
    "Feature IDs and product linkage cannot change.");
    requireFields(v.generation_revision === old.generation_revision, "Generation revision cannot change.");
    requireFields(v.acceptance_criteria.length === old.acceptance_criteria.length &&
      v.acceptance_criteria.every(ac => isRecord(ac) && old.acceptance_criteria.some(prior =>
        ac.acceptance_criteria_id === prior.acceptance_criteria_id && ac.requirement_id === prior.requirement_id)),
    "Keep existing acceptance criterion IDs; use Add AC for new criteria.");
    if (canonical(v) === canonical(old)) return false;
    const removedCriteria = new Set<string>();
    if (changed(old, v, ["title", "description", "scope", "constraints", "dependencies"])) {
      old.acceptance_criteria.forEach(ac => removedCriteria.add(ac.acceptance_criteria_id));
    }
    v.review_status = "pending";
    for (const ac of v.acceptance_criteria) {
      requireFields(isRecord(ac), "Invalid acceptance criterion.");
      const prior = old.acceptance_criteria.find(p => p.acceptance_criteria_id === ac.acceptance_criteria_id);
      requireFields(prior !== undefined, "Unknown acceptance criterion.");
      requireFields(ac.generation_revision === prior.generation_revision, "Generation revision cannot change.");
      const edited = { ...ac, review_status: prior.review_status, validation_status: prior.validation_status };
      if (canonical(edited) !== canonical(prior)) {
        ac.review_status = "pending";
        ac.validation_status = "pending";
        if (changed(prior, ac, ["given", "when", "then", "measurement"])) removedCriteria.add(prior.acceptance_criteria_id);
      } else {
        ac.review_status = prior.review_status;
        ac.validation_status = prior.validation_status;
      }
    }
    const candidate: unknown = { ...w, features: w.features.map((f, i) => i === index ? v : f) };
    const decoded = decodeWorkflow(candidate);
    removeTests(w, removedCriteria);
    w.features = decoded.features;
  } else if (action.kind === "scenario") {
    const old = w.scenarios.find(s => s.scenario_id === action.id);
    requireFields(old !== undefined && v.scenario_id === old.scenario_id && v.requirement_id === old.requirement_id &&
      v.acceptance_criteria_id === old.acceptance_criteria_id && v.category === old.category, "Scenario IDs, category and linkage cannot change.");
    requireFields(v.generation_revision === old.generation_revision, "Generation revision cannot change.");
    if (canonical(v) === canonical(old)) return false;
    v.review_status = "pending";
    const candidate: unknown = { ...w, scenarios: w.scenarios.map(s => s.scenario_id === action.id ? v : s) };
    w.scenarios = decodeWorkflow(candidate).scenarios;
    if (changed(old, v, ["title", "given", "when", "then", "design_technique"])) {
      for (const test of w.test_cases.filter(t => t.scenario_id === action.id)) test.review_status = "pending";
    }
  } else {
    const old = w.test_cases.find(t => t.test_case_id === action.id);
    requireFields(old !== undefined && v.test_case_id === old.test_case_id && v.scenario_id === old.scenario_id &&
      v.requirement_id === old.requirement_id && v.acceptance_criteria_id === old.acceptance_criteria_id, "Test case IDs and linkage cannot change.");
    requireFields(v.generation_revision === old.generation_revision, "Generation revision cannot change.");
    if (canonical(v) === canonical(old)) return false;
    v.review_status = "pending";
    const candidate: unknown = { ...w, test_cases: w.test_cases.map(t => t.test_case_id === action.id ? v : t) };
    w.test_cases = decodeWorkflow(candidate).test_cases;
  }
  return true;
}

function confirmArtifact(w: Workflow, kind: "feature" | "criterion" | "scenario" | "test", id: string): boolean {
  if (kind === "criterion") {
    const f = w.features.find(feature => feature.acceptance_criteria.some(ac => ac.acceptance_criteria_id === id));
    const ac = f?.acceptance_criteria.find(criterion => criterion.acceptance_criteria_id === id);
    requireFields(f !== undefined && ac !== undefined, "Unknown acceptance criterion.");
    assertNoErrors(criterionErrors(ac));
    if (ac.review_status === "confirmed" && ac.validation_status === "validated") return false;
    f.review_status = "pending";
    ac.review_status = "confirmed";
    ac.validation_status = "validated";
  } else if (kind === "feature") {
    const f = w.features.find(feature => feature.requirement_id === id);
    requireFields(f !== undefined, "Unknown feature.");
    assertNoErrors(featureErrors(f));
    if (f.review_status === "confirmed") return false;
    f.review_status = "confirmed";
  } else if (kind === "scenario") {
    const s = w.scenarios.find(scenario => scenario.scenario_id === id);
    requireFields(s !== undefined, "Unknown scenario.");
    assertNoErrors(scenarioErrors(s));
    if (s.review_status === "confirmed") return false;
    s.review_status = "confirmed";
  } else {
    const t = w.test_cases.find(test => test.test_case_id === id);
    requireFields(t !== undefined, "Unknown test case.");
    const s = w.scenarios.find(scenario => scenario.scenario_id === t.scenario_id);
    requireFields(s?.review_status === "confirmed", "Confirm the parent scenario before the test case.");
    assertNoErrors(caseErrors(t));
    if (t.review_status === "confirmed") return false;
    t.review_status = "confirmed";
  }
  return true;
}

export function restore(value: unknown): Workflow {
  const w = decodeWorkflow(value);
  const recordedStage = w.stage;
  requireFields(!w.product.items.length || questions.every(q => w.product.items.some(i => i.key === q.key)),
    "Saved workflow is missing required clarification categories.");
  requireFields(new Set(w.product.items.map(i => i.id)).size === w.product.items.length &&
    new Set(w.product.items.map(i => i.key)).size === w.product.items.length, "Duplicate clarification IDs or keys.");
  refresh(w);
  if (w.product.review_status === "confirmed") assertNoErrors(stageOneErrors(w));
  if (recordedStage >= 2) {
    assertNoErrors(stageOneErrors(w));
    requireFields(w.features.length > 0, "Stage 2 requires features.");
  }
  if (recordedStage === 3) {
    assertNoErrors(stageTwoErrors(w));
    requireFields(w.scenarios.length > 0, "Stage 3 requires scenarios.");
  }
  return w;
}

export function gates(w: Workflow): { stage1: string[]; stage2: string[]; stage3: string[] } {
  return { stage1: stageOneErrors(w), stage2: stageTwoErrors(w), stage3: stageThreeErrors(w) };
}

export { emptyWorkflow };
