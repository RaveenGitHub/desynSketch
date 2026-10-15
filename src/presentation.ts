import { Workflow } from "./model";
import { caseErrors, criterionErrors, featureErrors, nonempty, scenarioErrors } from "./validation";
import { Action } from "./workflow";

export function eligibility(w: Workflow): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const scenarios = new Map(w.scenarios.map(s => [s.scenario_id, s]));
  for (const i of w.product.items) {
    result[i.id] = nonempty(i.answer) && nonempty(i.reviewer_notes) ? [] : ["Save an answer and reviewer notes first."];
  }
  for (const f of w.features) {
    result[f.requirement_id] = featureErrors(f);
    for (const ac of f.acceptance_criteria) result[ac.acceptance_criteria_id] = criterionErrors(ac);
  }
  for (const s of w.scenarios) result[s.scenario_id] = scenarioErrors(s);
  for (const t of w.test_cases) result[t.test_case_id] = [
    ...caseErrors(t),
    ...(scenarios.get(t.scenario_id)?.review_status === "confirmed" ?
      [] : ["Confirm the parent scenario first."])
  ];
  return result;
}

export interface ImpactPreview {
  revision: number;
  removed: string[];
  reviews_reset: string[];
}

export function impactPreview(before: Workflow, after: Workflow): ImpactPreview {
  const artifacts = (w: Workflow): { id: string; confirmed: boolean }[] => [
    { id: w.product.requirement_id, confirmed: w.product.review_status === "confirmed" },
    ...w.product.items.map(i => ({ id: i.id, confirmed: i.resolution_status === "confirmed" })),
    ...w.features.flatMap(f => [
      { id: f.requirement_id, confirmed: f.review_status === "confirmed" },
      ...f.acceptance_criteria.map(ac => ({ id: ac.acceptance_criteria_id, confirmed: ac.review_status === "confirmed" }))
    ]),
    ...w.scenarios.map(s => ({ id: s.scenario_id, confirmed: s.review_status === "confirmed" })),
    ...w.test_cases.map(t => ({ id: t.test_case_id, confirmed: t.review_status === "confirmed" }))
  ];
  const next = new Map(artifacts(after).map(a => [a.id, a]));
  const previous = artifacts(before);
  return {
    revision: before.revision,
    removed: previous.filter(a => !next.has(a.id)).map(a => a.id),
    reviews_reset: previous.filter(a => a.confirmed && next.has(a.id) && !next.get(a.id)?.confirmed).map(a => a.id)
  };
}

export function needsImpactConfirmation(action: Action, preview: ImpactPreview): boolean {
  if (action.type === "proceed" || action.type === "navigate" || action.type === "addTestCase") return false;
  // The edited artifact's own review reset is expected; dependent resets are disruptive.
  const ownId = "id" in action ? action.id : action.type === "confirmProduct" ? "PRD-001" : undefined;
  return preview.removed.length > 0 || preview.reviews_reset.some(id => id !== ownId);
}
