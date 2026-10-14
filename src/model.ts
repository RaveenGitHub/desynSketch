export type Stage = 1 | 2 | 3;
export type Priority = "high" | "medium" | "low";
export type Severity = "critical" | "high" | "medium" | "low";
export type ReviewStatus = "pending" | "confirmed";
export type AutomationStatus = "not-assessed" | "planned" | "automated" | "manual";
export type Category = "positive" | "negative" | "boundary" | "operational-risk" | "security" | "performance";

export interface Review {
  generation_revision?: number;
  review_status: ReviewStatus;
  reviewer_notes: string;
  confidence_score: number;
  business_priority: Priority;
  severity: Severity;
  open_items_count: number;
}

export interface OpenItem {
  id: string;
  kind: "question" | "ambiguity" | "missing-information" | "confirmation";
  key: string;
  prompt: string;
  suggestion: string;
  answer: string;
  resolution_status: "open" | "answered" | "confirmed";
  severity_of_missing_info: Severity;
  reviewer_notes: string;
}

export interface Product {
  requirement_id: string;
  brief: string;
  intent_links: string[];
  items: OpenItem[];
  clarity_status: "unreviewed" | "needs-clarification" | "clear";
  ambiguity_resolution_status: "unreviewed" | "unresolved" | "resolved";
  review_status: ReviewStatus;
  reviewer_notes: string;
  traceability_confidence_score: number;
  confidence_score: number;
  severity_of_missing_info: Severity;
  business_priority: Priority;
  open_items_count: number;
}

export interface Criterion extends Review {
  acceptance_criteria_id: string;
  requirement_id: string;
  given: string;
  when: string;
  then: string;
  measurement: string;
  smart_review: {
    specific: boolean;
    measurable: boolean;
    achievable: boolean;
    relevant: boolean;
    time_bound: boolean;
  };
  validation_status: "pending" | "validated";
  automation_candidate: boolean;
  automation_status: AutomationStatus;
  traceability_matrix_reference: string;
}

export interface Feature extends Review {
  requirement_id: string;
  product_requirement_id: string;
  title: string;
  description: string;
  scope: string;
  constraints: string;
  dependencies: string[];
  invest_review: {
    independent: boolean;
    negotiable: boolean;
    valuable: boolean;
    estimable: boolean;
    small: boolean;
    testable: boolean;
  };
  automation_candidate: boolean;
  automation_status: AutomationStatus;
  traceability_matrix_reference: string;
  acceptance_criteria: Criterion[];
}

export interface Scenario extends Review {
  scenario_id: string;
  requirement_id: string;
  acceptance_criteria_id: string;
  category: Category;
  title: string;
  given: string;
  when: string;
  then: string;
  gherkin: string;
  design_technique: string;
  automation_candidate: boolean;
  automation_status: AutomationStatus;
  traceability_confidence: number;
}

export interface TestCase extends Review {
  test_case_id: string;
  scenario_id: string;
  requirement_id: string;
  acceptance_criteria_id: string;
  title: string;
  preconditions: string[];
  test_data: string;
  environment_considerations: string;
  steps: { action: string; expected_result: string }[];
  automation_candidate: boolean;
  automation_status: AutomationStatus;
  traceability_confidence: number;
}

export interface TraceRow {
  product_requirement_id: string;
  requirement_id: string;
  acceptance_criteria_id: string;
  scenario_id: string;
  test_case_id: string;
}

export interface CoverageCheck {
  id: string;
  stage: Stage;
  direction: "forward" | "reverse" | "review";
  source_id: string;
  target_id: string;
  description: string;
  passed: boolean;
}

export interface ArtifactReference {
  id: string;
  kind: "product" | "clarification" | "feature" | "criterion" | "scenario" | "test";
  stage: Stage;
  forward_references: string[];
  reverse_references: string[];
}

export interface CoverageMetrics {
  methodology: "balanced-stage-checks-v1";
  overall_score: number;
  stages: { stage: Stage; score: number; passed_checks: number; total_checks: number }[];
  checks: CoverageCheck[];
  references: ArtifactReference[];
}

export interface Workflow {
  schema_version: 1;
  stage: Stage;
  revision: number;
  updated_at: string;
  engine: "local-rules";
  product: Product;
  features: Feature[];
  scenarios: Scenario[];
  test_cases: TestCase[];
  traceability_matrix: TraceRow[];
  coverage: CoverageMetrics;
}

export const categories: Category[] = [
  "positive", "negative", "boundary", "operational-risk", "security", "performance"
];

export function emptyWorkflow(): Workflow {
  return {
    schema_version: 1, stage: 1, revision: 0, updated_at: new Date().toISOString(),
    engine: "local-rules",
    product: {
      requirement_id: "PRD-001", brief: "", intent_links: [], items: [],
      clarity_status: "unreviewed", ambiguity_resolution_status: "unreviewed",
      review_status: "pending", reviewer_notes: "", traceability_confidence_score: 0,
      confidence_score: 0, severity_of_missing_info: "high",
      business_priority: "medium", open_items_count: 1
    },
    features: [], scenarios: [], test_cases: [], traceability_matrix: [],
    coverage: {
      methodology: "balanced-stage-checks-v1", overall_score: 0,
      stages: [1, 2, 3].map(stage => ({ stage: stage as Stage, score: 0, passed_checks: 0, total_checks: 1 })),
      checks: [], references: []
    }
  };
}
