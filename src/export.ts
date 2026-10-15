import { Stage, Workflow } from "./model";
import { gates, refresh } from "./workflow";

export type ExportFormat = "json" | "yaml" | "markdown";

export function exportArtifact(workflow: Workflow, stage: Stage, format: ExportFormat): string {
  const w = structuredClone(workflow);
  // Exclude downstream artifacts from stage-specific references and scoring.
  if (stage < 3) { w.scenarios = []; w.test_cases = []; }
  if (stage < 2) w.features = [];
  refresh(w);
  const errors = gates(w)[`stage${stage}`];
  const metadata = {
    schema_version: w.schema_version, stage, revision: w.revision, updated_at: w.updated_at,
    engine: w.engine, status: errors.length ? "draft" : "reviewed",
    disclaimer: "Local rule-based drafts; human review is required. Alignment guidance is not standards certification.",
    coverage_scope: "Structural traceability and reviewed plan coverage only; not executed test coverage, pass rate, semantic completeness or security assurance.",
    open_items_count: errors.length, blocking_items: errors, coverage: w.coverage
  };
  const payload = stage === 1 ? { ...metadata, product: w.product } :
    stage === 2 ? { ...metadata, product: w.product, features: w.features } :
      { ...metadata, product: w.product, features: w.features, scenarios: w.scenarios,
        test_cases: w.test_cases, traceability_matrix: w.traceability_matrix };
  const json = JSON.stringify(payload, null, 2);
  // JSON is a YAML 1.2 subset; this preserves every scalar and multiline field without lossy escaping.
  if (format === "json" || format === "yaml") return `${json}\n`;
  const safe = (s: string): string => s.replace(/[\\`*_[\]<>|#]/g, "\\$&").replace(/\r?\n/g, " ");
  const fence = "`".repeat(Math.max(3, ...[...json.matchAll(/`+/g)].map(match => match[0].length + 1)));
  const sections = [
    `# Product Quality Workflow - Stage ${stage}`, "",
    `Status: **${metadata.status}** | Revision: ${w.revision} | Open items: ${errors.length}`, "",
    metadata.disclaimer, "", "## Product Definition", "",
    `**${w.product.requirement_id}**: ${safe(w.product.brief)}`, ""
  ];
  sections.splice(5, 0, "## Combined Structural Traceability & Reviewed Plan Coverage", "",
    metadata.coverage_scope, "",
    `Overall: **${w.coverage.overall_score}%** (equal-weight mean of three stage scores; future stages remain incomplete).`, "",
    ...w.coverage.stages.map(s => `- Stage ${s.stage}: ${s.score}% (${s.passed_checks}/${s.total_checks} checks)`), "",
    "### Bidirectional References", "", "| Artifact | Forward (children) | Reverse (parents) |", "|---|---|---|",
    ...w.coverage.references.map(r => `| ${safe(r.id)} | ${safe(r.forward_references.join(", ") || "None")} | ${safe(r.reverse_references.join(", ") || "None")} |`), "");
  if (stage >= 2) {
    sections.push("## Feature & Acceptance Criteria", "");
    for (const f of w.features) {
      sections.push(`### ${safe(f.requirement_id)}: ${safe(f.title)}`, "",
        `Description: ${safe(f.description)}`, "", `Scope: ${safe(f.scope)}`, "",
        `Constraints: ${safe(f.constraints)}`, "", `Dependencies: ${safe(f.dependencies.join("; "))}`, "");
      for (const ac of f.acceptance_criteria) {
        sections.push(`#### ${safe(ac.acceptance_criteria_id)}`, "",
          `Given ${safe(ac.given)}`, "", `When ${safe(ac.when)}`, "", `Then ${safe(ac.then)}`, "",
          `Measurement: ${safe(ac.measurement)}`, "");
      }
    }
  }
  if (stage === 3) {
    sections.push("## Scenarios", "");
    for (const s of w.scenarios) {
      sections.push(`### ${safe(s.scenario_id)}: ${safe(s.title)}`, "",
        `${fence}gherkin`, s.gherkin, fence, "");
    }
    sections.push("## Test Cases", "");
    for (const t of w.test_cases) {
      sections.push(`### ${safe(t.test_case_id)}: ${safe(t.title)}`, "",
        `Links: ${safe(t.requirement_id)} > ${safe(t.acceptance_criteria_id)} > ${safe(t.scenario_id)}`, "",
        `Preconditions: ${safe(t.preconditions.join("; "))}`, "", `Test data: ${safe(t.test_data)}`, "",
        `Environment: ${safe(t.environment_considerations)}`, "",
        "| Step | Action | Expected result |", "|---|---|---|");
      t.steps.forEach((step, index) => sections.push(`| ${index + 1} | ${safe(step.action)} | ${safe(step.expected_result)} |`));
      sections.push("");
    }
    sections.push("## Traceability Matrix", "", "| Product | Requirement | AC | Scenario | Test case |", "|---|---|---|---|---|");
    for (const row of w.traceability_matrix) {
      sections.push(`| ${safe(row.product_requirement_id)} | ${safe(row.requirement_id)} | ${safe(row.acceptance_criteria_id)} | ${safe(row.scenario_id)} | ${safe(row.test_case_id)} |`);
    }
    sections.push("");
  }
  sections.push("## Complete Metadata (lossless JSON)", "", `${fence}json`, json, fence, "");
  return sections.join("\n");
}
