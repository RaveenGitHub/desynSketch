const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { emptyWorkflow } = require("../../dist/model");
const { readyWorkflow } = require("../fixtures.cjs");
const { createHost } = require("./host.cjs");

async function mount(page, host, cached = {}) {
  await page.goto("about:blank");
  await page.setContent('<div id="error" hidden role="alert"></div><main id="app"></main><div id="announcement" role="status"></div>');
  await page.evaluate(cached => {
    let state = cached;
    window.acquireVsCodeApi = () => ({
      getState: () => state, setState: next => { state = next; window.testCached = next; },
      postMessage: message => window.hostMessage(message).then(data =>
        window.dispatchEvent(new MessageEvent("message", { data })))
    });
  }, cached);
  if (!cached.mounted) await page.exposeFunction("hostMessage", message => host.send(message));
  await page.addScriptTag({ path: path.resolve(__dirname, "..", "..", "media", "main.js") });
  await expect(page.locator('[data-control="view-heading"]')).toBeVisible();
}

const control = (page, key) => page.locator(`[data-control="${key}"]`);

async function reviewGeneratedTests(page, host) {
  await page.getByRole("button", { name: "Proceed to Scenarios" }).click();
  await expect(control(page, "view-heading")).toHaveText("5. Test Scenarios");
  await expect(page.getByRole("button", { name: "Complete review" })).toBeDisabled();
  const scenarioIds = host.saved().scenarios.map(s => s.scenario_id);
  expect(scenarioIds).toHaveLength(6);
  for (const id of scenarioIds) {
    await control(page, `select:${id}`).click();
    await control(page, `${id}:reviewer_notes`).fill("Reviewed isolated risk contract.");
    await control(page, `${id}:save`).click();
    await expect(control(page, `${id}:confirm`)).toBeEnabled();
    await control(page, `${id}:confirm`).click();
    await expect(control(page, `${id}:confirm`)).toBeDisabled();
  }
  await control(page, "nav:cases").click();
  for (const t of host.saved().test_cases) {
    await control(page, `select:${t.test_case_id}`).click();
    await control(page, `${t.test_case_id}:test_data`).fill("Synthetic SKU TEST-001; 0, 100, 101.");
    await control(page, `${t.test_case_id}:reviewer_notes`).fill("Ordered steps and expected results reviewed.");
    await control(page, `${t.test_case_id}:save`).click();
    await expect(control(page, `${t.test_case_id}:confirm`)).toBeEnabled();
    await control(page, `${t.test_case_id}:confirm`).click();
    await expect(control(page, `${t.test_case_id}:confirm`)).toBeDisabled();
  }
  await expect(page.getByRole("button", { name: "Complete review" })).toBeEnabled();
  expect(host.saved().coverage.overall_score).toBe(100);
  await page.getByRole("button", { name: "Complete review" }).click();
  await expect(control(page, "view-heading")).toHaveText("7. Export & Summary");
}

test("launch gates and clarification generation use the actual compiled host bridge", async ({ page }) => {
  const host = createHost(emptyWorkflow());
  await mount(page, host);
  await expect(control(page, "nav:features")).toBeDisabled();
  await control(page, "brief:brief").fill("A fast inventory workflow.");
  await control(page, "brief:save").click();
  await expect(control(page, "view-heading")).toHaveText("2. Clarifications");
  expect(host.saved().product.items.some(i => i.kind === "ambiguity")).toBe(true);
  await expect(control(page, "nav:features")).toBeDisabled();
});

test("drafts survive other saves, host errors and webview recreation; no-op save preserves downstream work", async ({ page }) => {
  const host = createHost(readyWorkflow(2, 1, true));
  await mount(page, host, { view: "features" });
  const before = host.saved();
  await control(page, "RQ-001:save").click();
  await expect(page.locator("#app")).not.toHaveAttribute("aria-busy", "true");
  expect(host.saved().revision).toBe(before.revision);
  await control(page, "RQ-001:title").fill("Retained title");
  await control(page, "select:RQ-002").click();
  await control(page, "RQ-002:reviewer_notes").fill("Updated rationale.");
  await control(page, "RQ-002:save").click();
  await expect(control(page, "RQ-002:confirm")).toBeEnabled();
  expect(host.saved().test_cases).toEqual(before.test_cases);
  const cached = await page.evaluate(() => ({ ...window.testCached, mounted: true }));
  host.reopen();
  await mount(page, host, cached);
  await control(page, "select:RQ-001").click();
  await expect(control(page, "RQ-001:title")).toHaveValue("Retained title");
  host.fail(true);
  await control(page, "RQ-001:reviewer_notes").fill("Unsaved rationale.");
  await control(page, "RQ-001:save").click();
  await page.getByRole("button", { name: "Apply without backup" }).click();
  await expect(page.getByRole("alert")).toContainText("persistence failure");
  await page.getByRole("button", { name: "Cancel change" }).click();
  await expect(control(page, "RQ-001:title")).toHaveValue("Retained title");
});

test("semantic impact cancellation and apply are scoped, and exports distinguish structural scores", async ({ page }) => {
  const host = createHost(readyWorkflow(2, 1, true));
  await mount(page, host, { view: "criteria" });
  await control(page, "RQ-001-AC-1:measurement").fill("Exactly one item within 150 ms.");
  await control(page, "RQ-001-AC-1:save").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel change" }).click();
  expect(host.saved().test_cases).toHaveLength(12);
  await control(page, "RQ-001-AC-1:save").click();
  await page.getByRole("button", { name: "Apply without backup" }).click();
  await expect(control(page, "RQ-001-AC-1:confirm")).toBeEnabled();
  expect(host.saved().test_cases).toHaveLength(6);
  expect(host.saved().test_cases.every(t => t.requirement_id === "RQ-002")).toBe(true);
  await control(page, "nav:summary").click();
  await page.getByLabel("Export stage").selectOption("3");
  await page.getByRole("button", { name: "Export selected snapshot" }).click();
  await expect(page.locator("#app")).not.toHaveAttribute("aria-busy", "true");
  const exported = JSON.parse(host.writes.at(-1));
  expect(exported.coverage_scope).toContain("not executed test coverage");
});

test("search and pagination use the complete collection without changing scores", async ({ page }) => {
  const host = createHost(readyWorkflow(25));
  await mount(page, host, { view: "features" });
  await expect(page.locator(".result-list button")).toHaveCount(12);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator(".result-list button")).toHaveCount(12);
  const score = host.saved().coverage.overall_score;
  await page.getByLabel("Search artifacts").fill("RQ-025");
  await expect(page.locator(".result-list button")).toHaveCount(1);
  await expect(control(page, "RQ-025:title")).toHaveValue("Create item 25");
  expect(host.saved().coverage.overall_score).toBe(score);
});

test("a conflicting saved update blocks a retained draft until explicit rebase", async ({ page }) => {
  const host = createHost(readyWorkflow(1, 1, true));
  await mount(page, host, { view: "features" });
  await control(page, "RQ-001:title").fill("Retained changed title");
  const w = host.saved();
  const update = await host.send({ type: "action", requestId: "external-review", revision: w.revision,
    action: { type: "saveArtifact", kind: "feature", id: "RQ-001",
      value: { ...w.features[0], reviewer_notes: "Another saved review." } } });
  await page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), update);
  await expect(control(page, "RQ-001:save")).toBeDisabled();
  await page.getByRole("button", { name: "Rebase retained draft onto current saved artifact" }).click();
  await expect(control(page, "RQ-001:save")).toBeEnabled();
  await expect(control(page, "RQ-001:title")).toHaveValue("Retained changed title");
});

test("ordered case steps can be added, reordered and removed without changing linkage", async ({ page }) => {
  const host = createHost(readyWorkflow(1, 1, true));
  await mount(page, host, { view: "cases" });
  const t = host.saved().test_cases[0];
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await control(page, `${t.test_case_id}:steps:2:action`).fill("Read back the selected record.");
  await control(page, `${t.test_case_id}:steps:2:expected_result`).fill("Exactly one selected record matches.");
  await page.getByRole("button", { name: "Move step 3 up" }).click();
  await expect(control(page, `${t.test_case_id}:steps:1:action`)).toHaveValue("Read back the selected record.");
  await page.getByRole("button", { name: "Remove step 3" }).click();
  await control(page, `${t.test_case_id}:save`).click();
  await expect(control(page, `${t.test_case_id}:confirm`)).toBeEnabled();
  expect(host.saved().test_cases[0].steps).toHaveLength(2);
  expect(host.saved().test_cases[0].steps[1].action).toBe("Read back the selected record.");
  expect(host.saved().test_cases[0].scenario_id).toBe(t.scenario_id);
});

test("malformed saved state offers recovery without silently replacing data", async ({ page }) => {
  const corrupt = { schema_version: 999, important: "Keep this raw snapshot" };
  const host = createHost(corrupt);
  await page.goto("about:blank");
  await page.exposeFunction("hostMessage", message => host.send(message));
  await page.setContent('<div id="error" hidden role="alert"></div><main id="app"></main><div id="announcement" role="status"></div>');
  await page.evaluate(() => {
    window.acquireVsCodeApi = () => ({
      getState: () => ({}), setState: () => undefined,
      postMessage: message => window.hostMessage(message).then(data =>
        window.dispatchEvent(new MessageEvent("message", { data })))
    });
  });
  await page.addScriptTag({ path: path.resolve(__dirname, "..", "..", "media", "main.js") });
  await expect(page.getByText("Saved workflow recovery", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back up damaged snapshot" }).click();
  await expect(page.locator("#app")).not.toHaveAttribute("aria-busy", "true");
  expect(JSON.parse(host.writes[0])).toEqual(corrupt);
  expect(host.saved()).toEqual(corrupt);
});

test("generated scenarios and cases can be reviewed through the UI to reach exactly 100 percent", async ({ page }) => {
  const host = createHost(readyWorkflow(1));
  await mount(page, host, { view: "features" });
  await reviewGeneratedTests(page, host);
});

test("complete user journey reviews product, SMART criteria, INVEST feature and tests without bypassing gates", async ({ page }) => {
  const host = createHost(emptyWorkflow());
  await mount(page, host);
  await control(page, "brief:brief").fill("Inventory workflow.");
  await control(page, "brief:save").click();
  await expect(control(page, "view-heading")).toHaveText("2. Clarifications");
  for (const item of host.saved().product.items) {
    await page.getByLabel("Search artifacts").fill(item.id);
    await expect(control(page, `${item.id}:answer`)).toBeVisible();
    await control(page, `${item.id}:answer`).fill(item.key === "capabilities" ? "Create an inventory item." :
      "An authorized clerk uses synthetic SKU TEST-001; 0-100 inclusive; denial without mutation; 200 ms maximum in an isolated simulator.");
    await control(page, `${item.id}:reviewer_notes`).fill("Reviewed exact synthetic contract.");
    await control(page, `${item.id}:save`).click();
    await expect(control(page, `${item.id}:confirm`)).toBeEnabled();
    await control(page, `${item.id}:confirm`).click();
    await expect(control(page, `${item.id}:confirm`)).toBeDisabled();
  }
  await control(page, "productReview:reviewer_notes").fill("Product scope, rules and risks reviewed.");
  await control(page, "productReview:confidence_score").fill("90");
  await control(page, "productReview:traceability_confidence_score").fill("95");
  await control(page, "productReview:save").click();
  await expect(page.getByRole("button", { name: "Proceed to Features" })).toBeEnabled();
  await page.getByRole("button", { name: "Proceed to Features" }).click();
  await expect(control(page, "view-heading")).toHaveText("3. Features");
  await expect(control(page, "RQ-001:confirm")).toBeDisabled();
  await page.getByRole("button", { name: "Review acceptance criteria" }).click();
  const ac = host.saved().features[0].acceptance_criteria[0];
  await control(page, `${ac.acceptance_criteria_id}:measurement`).fill("Persist exactly one item within 200 ms; read-back must match.");
  for (const key of Object.keys(ac.smart_review)) await control(page, `${ac.acceptance_criteria_id}:smart_review:${key}`).check();
  await control(page, `${ac.acceptance_criteria_id}:reviewer_notes`).fill("All SMART principles reviewed.");
  await control(page, `${ac.acceptance_criteria_id}:save`).click();
  await expect(control(page, `${ac.acceptance_criteria_id}:confirm`)).toBeEnabled();
  await control(page, `${ac.acceptance_criteria_id}:confirm`).click();
  await expect(control(page, `${ac.acceptance_criteria_id}:confirm`)).toBeDisabled();
  await control(page, "nav:features").click();
  for (const key of Object.keys(host.saved().features[0].invest_review)) await control(page, `RQ-001:invest_review:${key}`).check();
  await control(page, "RQ-001:reviewer_notes").fill("All INVEST principles reviewed.");
  await control(page, "RQ-001:save").click();
  await expect(control(page, "RQ-001:confirm")).toBeEnabled();
  await control(page, "RQ-001:confirm").click();
  await expect(control(page, "RQ-001:confirm")).toBeDisabled();
  await reviewGeneratedTests(page, host);
});
