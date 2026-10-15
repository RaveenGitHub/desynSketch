const { emptyWorkflow, transition, refresh } = require("../dist/workflow");

function readyWorkflow(featureCount = 2, criteriaPerFeature = 1, complete = false) {
  let w = transition(emptyWorkflow(), { type: "analyze", brief: "Synthetic isolated inventory workflow.", links: [] });
  for (const item of w.product.items) {
    w = transition(w, { type: "resolve", id: item.id,
      answer: item.key === "capabilities" ? Array.from({ length: featureCount }, (_,i) => `Create item ${i + 1}`).join("\n") :
        "Authorized clerk, synthetic data, 0-100 inclusive, 200 ms maximum; isolated simulator; denial without mutation.",
      notes: "Synthetic contract reviewed." });
    w = transition(w, { type: "confirmItem", id: item.id });
  }
  w = transition(w, { type: "confirmProduct", notes: "Synthetic product reviewed.", priority: "high", confidence: 90, traceConfidence: 90 });
  w = transition(w, { type: "proceed" });
  for (const f of w.features) {
    f.review_status = "confirmed";
    f.reviewer_notes = "Synthetic feature reviewed.";
    f.confidence_score = 90;
    Object.keys(f.invest_review).forEach(key => { f.invest_review[key] = true; });
    const initial = f.acceptance_criteria[0];
    f.acceptance_criteria = Array.from({ length: criteriaPerFeature }, (_,i) => ({
      ...structuredClone(initial), acceptance_criteria_id: `${f.requirement_id}-AC-${i + 1}`,
      measurement: "Exactly one selected item persists within 200 ms.",
      reviewer_notes: "Synthetic criterion reviewed.", confidence_score: 90,
      review_status: "confirmed", validation_status: "validated",
      smart_review: { specific: true, measurable: true, achievable: true, relevant: true, time_bound: true }
    }));
  }
  refresh(w);
  if (complete) {
    w = transition(w, { type: "proceed" });
    for (const artifact of [...w.scenarios, ...w.test_cases]) {
      artifact.review_status = "confirmed";
      artifact.reviewer_notes = "Synthetic test reviewed.";
      artifact.confidence_score = 90;
    }
    w.test_cases.forEach(t => { t.test_data = "Synthetic SKU TEST-001; quantity 0, 100, 101."; });
    refresh(w);
  }
  return w;
}

module.exports = { readyWorkflow };
