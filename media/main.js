(() => {
  "use strict";
  const api = acquireVsCodeApi();
  const app = document.getElementById("app");
  const errorBox = document.getElementById("error");
  const announcement = document.getElementById("announcement");
  const cached = api.getState() || {};
  const ui = {
    view: cached.view || "brief", selected: cached.selected || {}, filters: cached.filters || {},
    pages: cached.pages || {}, scroll: cached.scroll || {}, drafts: cached.drafts || {},
    referenceQuery: cached.referenceQuery || "", referencePage: cached.referencePage || 0,
    exportStage: cached.exportStage || 1, exportFormat: cached.exportFormat || "json"
  };
  const views = [
    ["brief", "1. Product Brief", 1], ["clarifications", "2. Clarifications", 1],
    ["features", "3. Features", 2], ["criteria", "4. Acceptance Criteria", 2],
    ["scenarios", "5. Test Scenarios", 3], ["cases", "6. Test Cases", 3],
    ["summary", "7. Export & Summary", 0]
  ];
  if (!views.some(view => view[0] === ui.view)) ui.view = "brief";
  const categoryNames = ["positive", "negative", "boundary", "operational-risk", "security", "performance"];
  let state, gates, eligible = {}, busy = false, recovery, impact, pending;
  let counter = 0;
  const artifactCache = new Map();
  let filterTimer;
  const pageSize = 12;
  const clone = value => JSON.parse(JSON.stringify(value));
  const nonempty = value => typeof value === "string" && value.trim().length > 0;
  const persist = () => api.setState(ui);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const append = (parent, ...children) => { parent.append(...children); return parent; };
  const notice = text => el("p", text, "hint");
  const say = text => { if (announcement) announcement.textContent = text; };

  function error(text) {
    errorBox.textContent = text;
    errorBox.hidden = false;
    say(text);
  }

  function button(text, callback, reason = "", control = text) {
    const node = el("button", text);
    node.type = "button";
    node.disabled = busy || Boolean(reason);
    node.title = reason;
    node.dataset.control = control;
    node.addEventListener("click", () => {
      try { callback(); } catch (cause) { error(cause instanceof Error ? cause.message : String(cause)); }
    });
    return node;
  }

  function request(message, meta = {}) {
    if (busy) return;
    errorBox.hidden = true;
    pending = { id: `UI-${++counter}`, ...meta };
    pending.focus = meta.focus || document.activeElement?.dataset.control;
    ui.scroll[ui.view] = window.scrollY;
    persist();
    busy = true;
    app.setAttribute("aria-busy", "true");
    const saving = el("p", "Saving / waiting for a decision...", "save-status");
    saving.dataset.saving = "true";
    app.prepend(saving);
    app.querySelectorAll("button,input,select,textarea").forEach(node => {
      node.dataset.wasDisabled = String(node.disabled);
      node.disabled = true;
    });
    say("Saving or waiting for your decision.");
    api.postMessage({ ...message, requestId: pending.id, revision: state?.revision });
  }

  function act(action, meta) { request({ type: "action", action }, meta); }
  function unlocked(view) {
    const stage = views.find(v => v[0] === view)?.[2];
    if (view === "clarifications") return state.product.items.length > 0;
    return stage === 2 ? !gates.stage1.length && state.features.length > 0 :
      stage === 3 ? !gates.stage2.length && state.scenarios.length > 0 : true;
  }
  function navigate(view, id) {
    if (!unlocked(view)) throw new Error("Resolve preceding stage gates and generate artifacts first.");
    ui.scroll[ui.view] = window.scrollY;
    ui.view = view;
    if (id) {
      ui.selected[view] = id;
      ui.filters[view] = { query: "", status: "all", category: "all" };
      ui.pages[view] = 0;
    }
    persist();
    render(id ? "detail-heading" : "view-heading");
  }

  function artifacts(view) {
    if (!artifactCache.has(view)) {
      artifactCache.set(view, buildArtifacts(view).map(record => ({
        ...record, searchText: `${record.id} ${record.title} ${JSON.stringify(record.value)}`.toLowerCase()
      })));
    }
    return artifactCache.get(view);
  }

  function buildArtifacts(view) {
    if (view === "clarifications") return state.product.items.map(value => ({
      id: value.id, title: value.prompt, status: value.resolution_status, category: value.kind, kind: "clarification", value
    }));
    if (view === "features") return state.features.map(value => ({
      id: value.requirement_id, title: value.title, status: value.review_status, kind: "feature", value
    }));
    if (view === "criteria") return state.features.flatMap(f => f.acceptance_criteria.map(value => ({
      id: value.acceptance_criteria_id, title: `${f.title}: ${value.when}`, status: value.review_status, kind: "criterion", value
    })));
    const scenarios = new Map(state.scenarios.map(s => [s.scenario_id, s]));
    return (view === "scenarios" ? state.scenarios : state.test_cases).map(value => ({
      id: view === "scenarios" ? value.scenario_id : value.test_case_id,
      title: value.title, status: value.review_status, category: view === "scenarios" ? value.category :
        scenarios.get(value.scenario_id)?.category,
      kind: view === "scenarios" ? "scenario" : "test", value
    }));
  }

  const reviewKeys = ["reviewer_notes", "confidence_score", "business_priority", "severity", "automation_candidate", "automation_status"];
  function editable(kind, value) {
    const keys = kind === "brief" ? ["brief", "intent_links"] :
      kind === "product" ? ["reviewer_notes", "business_priority", "confidence_score", "traceability_confidence_score"] :
      kind === "clarification" ? ["answer", "reviewer_notes"] :
      kind === "feature" ? ["title", "description", "scope", "constraints", "dependencies", "invest_review", ...reviewKeys] :
      kind === "criterion" ? ["given", "when", "then", "measurement", "smart_review", ...reviewKeys] :
      kind === "scenario" ? ["title", "given", "when", "then", "design_technique", "traceability_confidence", ...reviewKeys] :
      ["title", "preconditions", "test_data", "environment_considerations", "steps", "traceability_confidence", ...reviewKeys];
    return Object.fromEntries(keys.map(key => [key, clone(value[key])]));
  }
  function draftFor(id, kind, saved) {
    const draft = ui.drafts[id];
    return draft || { kind, base: JSON.stringify(editable(kind, saved)), generation: saved.generation_revision ?? 0, value: editable(kind, saved) };
  }
  function stash(id, draft) {
    ui.drafts[id] = draft;
    persist();
    const status = [...app.querySelectorAll("[data-draft-status]")].find(node => node.dataset.draftStatus === id);
    if (status) status.textContent = "Unsaved draft - retained across views and other saves";
    app.querySelectorAll("[data-confirm-id]").forEach(node => {
      if (node.dataset.confirmId === id) {
        node.disabled = true;
        node.title = "Save this draft before confirming.";
      }
    });
    const discard = [...app.querySelectorAll("[data-control]")].find(node => node.dataset.control === `${id}:discard`);
    if (discard) discard.disabled = false;
    const productSave = [...app.querySelectorAll("[data-control]")].find(node =>
      node.dataset.control === `${id}:save` && node.title === "Product is already confirmed.");
    if (productSave) { productSave.disabled = false; productSave.title = ""; }
    const count = app.querySelector("[data-draft-count]");
    if (count) count.textContent = `${Object.keys(ui.drafts).length} retained drafts`;
  }
  function setPath(object, path, value) {
    const parent = path.slice(0, -1).reduce((target, key) => target[key], object);
    parent[path.at(-1)] = value;
  }

  function input(parent, label, value, onChange, options = {}) {
    const field = el("div", undefined, "field");
    const control = options.control || `${ui.view}:${label}`;
    const id = `field-${++counter}`;
    const labelNode = el("label", label);
    labelNode.htmlFor = id;
    let node;
    if (options.choices) {
      node = el("select");
      options.choices.forEach(choice => {
        const option = el("option", typeof choice === "string" ? choice : choice.label);
        option.value = typeof choice === "string" ? choice : choice.value;
        node.append(option);
      });
    } else if (options.boolean) {
      node = el("input");
      node.type = "checkbox";
    } else if (options.number || options.search) {
      node = el("input");
      node.type = options.number ? "number" : "search";
      if (options.number) { node.min = "0"; node.max = "100"; }
    } else {
      node = el("textarea");
      node.rows = options.rows || 3;
    }
    node.id = id;
    node.dataset.control = control;
    if (options.boolean) node.checked = value;
    else node.value = options.array ? value.join("\n") : String(value ?? "");
    node.disabled = busy;
    const feedback = el("p", undefined, "field-error");
    feedback.id = `${id}-error`;
    node.setAttribute("aria-describedby", feedback.id);
    const validate = () => {
      let urlError = "";
      if (options.urls) for (const line of node.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
        try {
          const url = new URL(line);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
            urlError = "Use HTTP(S) URLs without credentials.";
          }
        } catch { urlError = "Enter a valid HTTP(S) URL on each line."; }
      }
      const message = urlError || (options.number && (node.value.trim() === "" || !Number.isFinite(Number(node.value)) ||
        Number(node.value) < 0 || Number(node.value) > 100) ? "Enter a number from 0 to 100." :
        options.required && !nonempty(node.value) ? `${label} is required before confirmation.` : "");
      feedback.textContent = message;
      node.setAttribute("aria-invalid", String(Boolean(message)));
      return message;
    };
    node.addEventListener("input", () => {
      validate();
      onChange(options.boolean ? node.checked : options.number ? (node.value.trim() ? Number(node.value) : null) :
        options.array ? node.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : node.value);
    });
    validate();
    append(field, labelNode, node, feedback);
    parent.append(field);
    return node;
  }

  function render(focusKey, keepScroll = true) {
    if (!state) return;
    const previousFocus = focusKey || document.activeElement?.dataset.control;
    const selection = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement ?
      { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : undefined;
    const previousY = window.scrollY;
    if (!unlocked(ui.view)) ui.view = state.stage === 1 ? "clarifications" : state.stage === 2 ? "features" : "scenarios";
    if (!unlocked(ui.view)) ui.view = "brief";
    app.replaceChildren();
    app.removeAttribute("aria-busy");
    const nav = el("nav", undefined, "toolbar");
    nav.setAttribute("aria-label", "Workflow views");
    views.forEach(([view, label]) => {
      const reason = unlocked(view) ? "" : "Resolve preceding gates and generate this stage first.";
      const b = button(label, () => navigate(view), reason, `nav:${view}`);
      if (view === ui.view) b.setAttribute("aria-current", "page");
      nav.append(b);
    });
    app.append(nav);
    const heading = el("h2", views.find(v => v[0] === ui.view)[1]);
    heading.tabIndex = -1;
    heading.dataset.control = "view-heading";
    app.append(heading);
    const activeStage = views.find(v => v[0] === ui.view)[2] || state.stage;
    const dashboard = el("section", undefined, "compact-status");
    dashboard.append(el("p", `Overall structural traceability & reviewed plan coverage: ${state.coverage.overall_score}% | Stage ${activeStage}: ${state.coverage.stages[activeStage - 1].score}%`),
      notice("Not executed test coverage, pass rate, semantic completeness or security assurance."),
      notice(`Readiness: Stage ${state.stage} | Revision ${state.revision} | Clarity: ${state.product.clarity_status} | ${gates[`stage${activeStage}`].length} stage blockers`));
    const count = notice(`${Object.keys(ui.drafts).length} retained drafts`);
    count.dataset.draftCount = "true";
    dashboard.append(count);
    const progress = el("progress");
    progress.max = 100;
    progress.value = state.coverage.overall_score;
    progress.setAttribute("aria-label", "Overall planned traceability and coverage");
    dashboard.append(progress);
    const details = el("details");
    details.append(el("summary", "Current-stage blockers and stage scores"));
    state.coverage.stages.forEach(s => details.append(notice(`Stage ${s.stage}: ${s.score}% (${s.passed_checks}/${s.total_checks} checks)`)));
    const ul = el("ul");
    gates[`stage${activeStage}`].slice(0, 30).forEach(text => ul.append(el("li", text)));
    details.append(ul, notice("The score measures reviewed planned coverage, not semantic adequacy or executed tests. Export includes all blockers."));
    dashboard.append(details);
    app.append(dashboard);
    const controls = el("div", undefined, "toolbar");
    if (ui.view !== "summary") {
      const reason = gates[`stage${activeStage}`].length ? "Resolve and confirm every blocker in this stage." : "";
      const text = activeStage === 3 ? "Complete review" : activeStage === 1 ? "Proceed to Features" : "Proceed to Scenarios";
      controls.append(button(text, () => {
        if (state.stage > activeStage) navigate(activeStage === 1 ? "features" : "scenarios");
        else act({ type: "proceed" }, { nextView: activeStage === 1 ? "features" : activeStage === 2 ? "scenarios" : "summary" });
      }, reason));
      if (reason) controls.append(notice(reason));
      controls.append(button("Export & Summary", () => navigate("summary")));
    }
    app.append(controls);
    if (ui.view === "brief") renderBrief();
    else if (ui.view === "summary") renderSummary();
    else renderMasterDetail();
    persist();
    setTimeout(() => {
      const focus = [...app.querySelectorAll("[data-control]")].find(node => node.dataset.control === previousFocus);
      if (focus && !focus.disabled) {
        focus.focus({ preventScroll: true });
        if (!focusKey && selection?.start !== null && selection?.start !== undefined && focus.setSelectionRange) {
          focus.setSelectionRange(selection.start, selection.end);
        }
      }
      else if (previousFocus) heading.focus({ preventScroll: true });
      window.scrollTo(0, focusKey === "view-heading" || focusKey === "detail-heading" ?
        (ui.scroll[ui.view] || 0) : keepScroll ? previousY : 0);
    }, 0);
  }

  function showIdentity(parent, artifact) {
    const dl = el("dl", undefined, "identity");
    Object.entries(artifact).filter(([key]) => key.endsWith("_id") || key === "category" ||
      ["generation_revision", "review_status", "validation_status", "open_items_count", "traceability_matrix_reference"].includes(key))
      .forEach(([key, value]) => append(dl, el("dt", key.replaceAll("_", " ")), el("dd", String(value))));
    parent.append(dl);
    const id = artifact.test_case_id || artifact.scenario_id || artifact.acceptance_criteria_id || artifact.requirement_id || artifact.id;
    const ref = state.coverage.references.find(r => r.id === id);
    if (ref) {
      const toolbar = el("div", undefined, "toolbar");
      toolbar.append(notice("Reverse / parents:"));
      ref.reverse_references.forEach(id => toolbar.append(reference(id)));
      toolbar.append(notice("Forward / children:"));
      ref.forward_references.slice(0, 12).forEach(id => toolbar.append(reference(id)));
      if (ref.forward_references.length > 12) toolbar.append(button("All references", () => navigate("summary")));
      parent.append(toolbar);
    }
  }
  function reference(id) {
    return button(id, () => {
      const r = state.coverage.references.find(r => r.id === id);
      const view = { product: "brief", clarification: "clarifications", feature: "features", criterion: "criteria", scenario: "scenarios", test: "cases" }[r.kind];
      navigate(view, id);
    }, "", `reference:${id}`);
  }

  function renderMasterDetail() {
    const view = ui.view;
    const records = artifacts(view);
    const filter = ui.filters[view] || { query: "", status: "all", category: "all" };
    ui.filters[view] = filter;
    const filters = el("section", undefined, "filters");
    const updateFilter = (key, value) => {
      filter[key] = value;
      ui.pages[view] = 0;
      persist();
      clearTimeout(filterTimer);
      if (key === "query") filterTimer = setTimeout(() => render(), 120);
      else render();
    };
    input(filters, "Search artifacts", filter.query, value => updateFilter("query", value), { search: true, control: `${view}:search` });
    input(filters, "Review status", filter.status, value => updateFilter("status", value),
      { choices: ["all", "pending", ...(view === "clarifications" ? ["open", "answered"] : []), "confirmed"] });
    if (view === "clarifications" || view === "scenarios" || view === "cases") {
      input(filters, "Category", filter.category, value => updateFilter("category", value),
        { choices: ["all", ...(view === "clarifications" ? ["question", "ambiguity", "missing-information", "confirmation"] : categoryNames)] });
    }
    app.append(filters);
    const query = filter.query.toLowerCase();
    const matches = records.filter(r => r.searchText.includes(query) &&
      (filter.status === "all" || r.status === filter.status) && (filter.category === "all" || r.category === filter.category));
    const selected = matches.find(r => r.id === ui.selected[view]) || matches[0];
    if (selected) ui.selected[view] = selected.id;
    const layout = el("div", undefined, "master-detail");
    const master = el("aside");
    master.setAttribute("aria-label", "Artifact list");
    page(master, matches, ui.pages[view] || 0, value => { ui.pages[view] = value; persist(); render(); }, r => {
      const b = button(`${r.id} - ${r.title.slice(0, 100)} [${r.status}]${ui.drafts[r.id] ? " - draft" : ""}`, () => {
        ui.selected[view] = r.id;
        persist();
        render("detail-heading");
      }, "", `select:${r.id}`);
      if (selected?.id === r.id) b.setAttribute("aria-current", "true");
      return b;
    });
    const detail = el("section", undefined, "card detail");
    if (selected) {
      detail.dataset.artifactId = selected.id;
      const heading = el("h3", `${selected.id}: ${selected.title}`);
      heading.tabIndex = -1;
      heading.dataset.control = "detail-heading";
      detail.append(heading);
      showIdentity(detail, selected.value);
      if (selected.kind === "clarification") {
        detail.append(notice(`Suggested clarification: ${selected.value.suggestion}`),
          notice(`Missing-information severity: ${selected.value.severity_of_missing_info}`));
      }
      if (selected.kind === "scenario") detail.append(el("pre", selected.value.gherkin));
      artifactForm(detail, selected.id, selected.kind, selected.value);
      if (selected.kind === "feature") {
        const actions = el("div", undefined, "toolbar");
        actions.append(button("Review acceptance criteria", () => {
          navigate("criteria", selected.value.acceptance_criteria[0]?.acceptance_criteria_id);
        }), button("Add AC", () => act({ type: "addCriterion", id: selected.id }, { nextView: "criteria", addedKind: "criterion" })));
        detail.append(actions);
      }
      if (selected.kind === "scenario") detail.append(button("Add test case", () =>
        act({ type: "addTestCase", id: selected.id }, { nextView: "cases", addedKind: "test" })));
    } else detail.append(notice("No artifacts match these filters."));
    append(layout, master, detail);
    app.append(layout);
    if (view === "clarifications") {
      const review = el("section", undefined, "card");
      review.append(el("h3", "Product review checkpoint"));
      artifactForm(review, "productReview", "product", state.product);
      app.append(review);
    }
  }

  function page(parent, records, index, onPage, renderer) {
    const count = Math.max(1, Math.ceil(records.length / pageSize));
    const current = Math.min(index, count - 1);
    parent.append(notice(`${records.length} results - page ${current + 1} of ${count}`));
    const list = el("div", undefined, "result-list");
    records.slice(current * pageSize, (current + 1) * pageSize).forEach(r => list.append(renderer(r)));
    parent.append(list);
    const pager = el("div", undefined, "toolbar");
    pager.append(button("Previous page", () => onPage(current - 1), current === 0 ? "First page" : ""),
      button("Next page", () => onPage(current + 1), current === count - 1 ? "Last page" : ""));
    parent.append(pager);
  }

  function renderBrief() {
    const section = el("section", undefined, "card");
    section.dataset.artifactId = state.product.requirement_id;
    showIdentity(section, state.product);
    artifactForm(section, "brief", "brief", state.product);
    if (state.product.items.length) section.append(button("Review clarifications", () => navigate("clarifications")));
    app.append(section);
  }

  function artifactForm(parent, id, kind, saved) {
    const draft = draftFor(id, kind, saved);
    const working = draft.value;
    const stale = draft.base !== JSON.stringify(editable(kind, saved)) ||
      (draft.generation ?? 0) !== (saved.generation_revision ?? 0);
    const status = el("p", ui.drafts[id] ? "Unsaved draft - retained across views and other saves" : "Saved", "save-status");
    status.dataset.draftStatus = id;
    parent.append(status);
    if (stale) {
      parent.append(el("p", "The saved artifact changed since this draft began. Review the current saved values before rebasing. Saving is blocked until you acknowledge the new base.", "notice"));
      const snapshot = el("details");
      snapshot.append(el("summary", "Current saved editable values"), el("pre", JSON.stringify(editable(kind, saved), null, 2)));
      parent.append(snapshot, button("Rebase retained draft onto current saved artifact", () => {
        draft.base = JSON.stringify(editable(kind, saved));
        draft.generation = saved.generation_revision ?? 0;
        stash(id, draft);
        render();
      }));
    }
    const form = el("div");
    const change = (path, value) => { setPath(working, path, value); stash(id, draft); };
    const text = (key, label, options = {}) => input(form, label, working[key], value => change([key], value),
      { required: true, control: `${id}:${key}`, ...options });
    const checklist = (key, title) => {
      const group = el("fieldset");
      group.append(el("legend", title));
      Object.entries(working[key]).forEach(([name, value]) => input(group, name.replaceAll("_", " "),
        value, next => change([key, name], next), { boolean: true, control: `${id}:${key}:${name}` }));
      form.append(group);
    };
    if (kind === "brief") {
      text("brief", "Product brief", { rows: 6 });
      text("intent_links", "Solution intent links (one HTTP(S) URL per line)", { array: true, required: false, urls: true });
    } else if (kind === "clarification") {
      text("answer", "Resolution / answer", { rows: saved.key === "capabilities" ? 6 : 4 });
      text("reviewer_notes", "Reviewer notes / rationale");
    } else if (kind === "product") {
      text("reviewer_notes", "Product reviewer notes");
      text("business_priority", "Business priority", { choices: ["high", "medium", "low"] });
      text("confidence_score", "Human-assessed confidence (0-100)", { number: true });
      text("traceability_confidence_score", "Intent traceability confidence (0-100)", { number: true });
    } else {
      if (["feature", "scenario", "test"].includes(kind)) text("title", "Title");
      if (kind === "feature") {
        text("description", "Description");
        text("scope", "Scope");
        text("constraints", "Constraints");
        text("dependencies", "Dependencies (one per line; state None when applicable)", { array: true });
        checklist("invest_review", "Affirm INVEST after review");
      }
      if (["criterion", "scenario"].includes(kind)) {
        text("given", "Given");
        text("when", "When");
        text("then", "Then");
      }
      if (kind === "criterion") {
        text("measurement", "Measurement (threshold, unit and time/condition)");
        checklist("smart_review", "Affirm SMART after review");
      }
      if (kind === "scenario") text("design_technique", "Test design technique");
      if (kind === "test") {
        text("preconditions", "Preconditions (one per line)", { array: true });
        text("test_data", "Concrete synthetic test data");
        text("environment_considerations", "Environment considerations");
        const steps = el("section", undefined, "steps");
        steps.append(el("h4", "Ordered steps and expected results"));
        working.steps.forEach((step, index) => {
          const group = el("fieldset");
          group.append(el("legend", `Step ${index + 1}`));
          ["action", "expected_result"].forEach(key => input(group, key === "action" ? "Action" : "Expected result",
            step[key], value => change(["steps", index, key], value), { required: true, control: `${id}:steps:${index}:${key}` }));
          const toolbar = el("div", undefined, "toolbar");
          const move = offset => {
            [working.steps[index], working.steps[index + offset]] = [working.steps[index + offset], working.steps[index]];
            stash(id, draft); render();
          };
          toolbar.append(button(`Move step ${index + 1} up`, () => move(-1), index === 0 ? "Already first" : ""),
            button(`Move step ${index + 1} down`, () => move(1), index === working.steps.length - 1 ? "Already last" : ""),
            button(`Remove step ${index + 1}`, () => { working.steps.splice(index, 1); stash(id, draft); render(); }));
          group.append(toolbar);
          steps.append(group);
        });
        steps.append(button("Add step", () => { working.steps.push({ action: "", expected_result: "" }); stash(id, draft); render(); }));
        form.append(steps);
      }
      text("reviewer_notes", "Reviewer notes");
      text("confidence_score", "Human-assessed confidence (0-100)", { number: true });
      text("business_priority", "Business priority", { choices: ["high", "medium", "low"] });
      text("severity", "Severity", { choices: ["critical", "high", "medium", "low"] });
      input(form, "Automation candidate", working.automation_candidate, value => change(["automation_candidate"], value),
        { boolean: true, control: `${id}:automation_candidate` });
      text("automation_status", "Automation status", { choices: ["not-assessed", "planned", "automated", "manual"] });
      if (kind === "scenario" || kind === "test") text("traceability_confidence", "Traceability confidence (0-100)", { number: true });
    }
    parent.append(form);
    const advanced = el("details");
    advanced.append(el("summary", "Advanced editable-field JSON (IDs and derived fields excluded)"),
      notice("Import edits into the local typed draft; saving and confirmation still use host validation."));
    const raw = input(advanced, "Editable fields JSON", draft.raw ?? JSON.stringify(working, null, 2),
      value => { draft.raw = value; stash(id, draft); }, { rows: 12, control: `${id}:json` });
    raw.classList.add("json-editor");
    advanced.append(button("Apply JSON to draft", () => {
      const parsed = JSON.parse(raw.value);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" ||
          Object.keys(parsed).some(key => !(key in working))) throw new Error("Only editable fields are permitted.");
      const expected = editable(kind, saved);
      for (const [key, value] of Object.entries(parsed)) {
        if (value === null || typeof value !== typeof expected[key] || Array.isArray(value) !== Array.isArray(expected[key])) {
          throw new Error(`Invalid type for ${key}.`);
        }
        if (Array.isArray(value)) {
          if (key === "steps" ? !value.every(s => s && typeof s.action === "string" && typeof s.expected_result === "string") :
            !value.every(v => typeof v === "string")) throw new Error(`Invalid ${key} entries.`);
        } else if (value && typeof value === "object" &&
          (Object.keys(value).length !== Object.keys(expected[key]).length ||
            !Object.keys(expected[key]).every(k => typeof value[k] === "boolean"))) throw new Error(`Invalid ${key} checklist.`);
      }
      Object.assign(working, parsed);
      delete draft.raw;
      stash(id, draft);
      render();
    }));
    parent.append(advanced);
    const errors = eligible[id] || [];
    if (errors.length) {
      const blockers = el("details");
      blockers.append(el("summary", `${errors.length} saved-artifact confirmation blockers`));
      const list = el("ul");
      errors.forEach(text => list.append(el("li", text)));
      blockers.append(list);
      parent.append(blockers);
    }
    const controls = el("div", undefined, "toolbar");
    const save = () => {
      if (stale) throw new Error("Review and rebase the retained draft before saving.");
      if (draft.raw !== undefined) throw new Error("Apply the advanced JSON to the typed draft before saving.");
      if (form.querySelector('[aria-invalid="true"][type="number"]')) {
        throw new Error("Correct numeric scores before saving.");
      }
      if (kind === "brief") act({ type: "analyze", brief: working.brief, links: working.intent_links }, { key: id, nextView: "clarifications" });
      else if (kind === "clarification") act({ type: "resolve", id, answer: working.answer, notes: working.reviewer_notes }, { key: id });
      else if (kind === "product") act({ type: "confirmProduct", notes: working.reviewer_notes, priority: working.business_priority,
        confidence: working.confidence_score, traceConfidence: working.traceability_confidence_score }, { key: id });
      else {
        const current = artifacts(kind === "feature" ? "features" : kind === "criterion" ? "criteria" : kind === "scenario" ? "scenarios" : "cases")
          .find(a => a.id === id).value;
        act({ type: "saveArtifact", kind, id, value: { ...current, ...working } }, { key: id });
      }
    };
    const productReason = kind === "product" ?
      state.product.items.some(i => i.resolution_status !== "confirmed") ? "Confirm every clarification first." :
        saved.review_status === "confirmed" && !ui.drafts[id] ? "Product is already confirmed." : "" : "";
    controls.append(button(kind === "brief" ? (state.product.items.length ? "Re-analyze brief" : "Analyze brief") :
      kind === "product" ? "Confirm product definition" : "Resolve / Save", save, stale ? "Rebase required" : productReason, `${id}:save`));
    if (!["brief", "product"].includes(kind)) {
      const confirmed = kind === "clarification" ? saved.resolution_status === "confirmed" : saved.review_status === "confirmed";
      const reason = confirmed ? "Already confirmed." : ui.drafts[id] ? "Save the retained draft before confirming." : errors.join(" ");
      const confirm = button(kind === "clarification" ? "Confirm saved resolution" : `Confirm ${kind}`, () =>
        act(kind === "clarification" ? { type: "confirmItem", id } : { type: "confirmArtifact", kind, id }), reason, `${id}:confirm`);
      confirm.dataset.confirmId = id;
      controls.append(confirm);
      if (reason && !confirmed) controls.append(notice(`Confirm unavailable: ${reason}`));
    }
    controls.append(button("Discard this draft", () => {
      if (window.confirm("Discard only this local draft? Saved artifacts are unchanged.")) {
        delete ui.drafts[id]; persist(); render();
      }
    }, ui.drafts[id] ? "" : "No unsaved draft", `${id}:discard`));
    parent.append(controls);
    if (productReason) parent.append(notice(productReason));
  }

  function renderSummary() {
    const summary = el("section", undefined, "card");
    summary.append(el("h3", "Export & Review Summary"),
      notice(`Committed revision ${state.revision}, updated ${new Date(state.updated_at).toLocaleString()}. Unsaved drafts are not included in exports.`),
      notice(`${state.features.length} features | ${state.features.reduce((n, f) => n + f.acceptance_criteria.length, 0)} ACs | ${state.scenarios.length} scenarios | ${state.test_cases.length} cases`),
      notice(`High / critical risk scenarios: ${state.scenarios.filter(s => ["high", "critical"].includes(s.severity)).length}`));
    input(summary, "Export stage", String(ui.exportStage), value => { ui.exportStage = Number(value); persist(); render(); },
      { choices: [{ value: "1", label: "Stage 1 - Product" }, { value: "2", label: "Stage 2 - Features & AC" }, { value: "3", label: "Stage 3 - Scenarios & Cases" }] });
    input(summary, "Export format", ui.exportFormat, value => { ui.exportFormat = value; persist(); },
      { choices: ["json", "yaml", "markdown"] });
    summary.append(el("p", gates[`stage${ui.exportStage}`].length ? "Export status: DRAFT - unresolved checks will be included." : "Export status: REVIEWED - not execution evidence."),
      button("Export selected snapshot", () => request({ type: "export", stage: ui.exportStage, format: ui.exportFormat })));
    state.coverage.stages.forEach(stage => {
      const section = el("details");
      section.append(el("summary", `Stage ${stage.stage}: ${stage.score}% - ${gates[`stage${stage.stage}`].length} blockers`));
      const checks = state.coverage.checks.filter(c => c.stage === stage.stage && !c.passed);
      checks.slice(0, 30).forEach(c => {
        const row = el("p", `${c.direction}: ${c.description} (${c.source_id} > ${c.target_id}) `);
        if (state.coverage.references.some(r => r.id === c.source_id)) row.append(reference(c.source_id));
        section.append(row);
      });
      section.append(notice("Export includes the full blocking list."));
      summary.append(section);
    });
    app.append(summary);
    const refs = el("section", undefined, "card");
    refs.append(el("h3", "Bidirectional reference explorer"),
      notice("Product > Feature > AC > Scenario > Case, and back. Select an ID to open its focused view."));
    input(refs, "Search references", ui.referenceQuery, value => {
      ui.referenceQuery = value; ui.referencePage = 0; persist(); render();
    }, { search: true });
    const records = state.coverage.references.filter(r => JSON.stringify(r).toLowerCase().includes(ui.referenceQuery.toLowerCase()));
    page(refs, records, ui.referencePage, index => { ui.referencePage = index; persist(); render(); }, r => {
      const row = el("section", undefined, "reference-row");
      row.append(reference(r.id), notice(`Kind: ${r.kind}`));
      for (const [label, ids] of [["Forward / children", r.forward_references], ["Reverse / parents", r.reverse_references]]) {
        row.append(notice(`${label}: ${ids.length ? ids.join(", ") : "None"}`));
        ids.slice(0, 12).forEach(id => row.append(reference(id)));
        if (ids.length > 12) row.append(notice("Search a child ID to navigate more references."));
      }
      return row;
    });
    app.append(refs);
    const drafts = el("section", undefined, "card");
    drafts.append(el("h3", "Retained drafts"), notice("Invalidated or changed artifacts do not discard their local drafts. Copy their JSON before discarding; detached drafts cannot be saved into regenerated artifacts without rebasing."));
    Object.entries(ui.drafts).forEach(([id, draft]) => {
      const section = el("details");
      section.append(el("summary", `${id} - ${draft.kind} draft`), el("pre", draft.raw ?? JSON.stringify(draft.value, null, 2)),
        button(`Discard draft ${id}`, () => {
          if (window.confirm(`Discard only retained draft ${id}?`)) { delete ui.drafts[id]; persist(); render(); }
        }));
      drafts.append(section);
    });
    app.append(drafts, button("Reset workflow", () => request({ type: "reset" })));
  }

  function renderRecovery(message) {
    app.replaceChildren();
    app.removeAttribute("aria-busy");
    const section = el("section", undefined, "card");
    section.append(el("h2", "Saved workflow recovery"), el("p", message, "notice"),
      notice("Saved data has not been overwritten. Back up the raw snapshot before resetting. Retry if the workspace storage was repaired."));
    const toolbar = el("div", undefined, "toolbar");
    toolbar.append(button("Back up damaged snapshot", () => request({ type: "backupRecovery" })),
      button("Retry loading saved state", () => request({ type: "retryRecovery" })),
      button("Reset saved workflow", () => request({ type: "reset" })));
    section.append(toolbar);
    app.append(section);
  }

  function renderImpact() {
    app.replaceChildren();
    const dialog = el("section", undefined, "card");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "impact-heading");
    const heading = el("h2", `Change impact - saved revision ${impact.revision}`);
    heading.id = "impact-heading";
    heading.tabIndex = -1;
    dialog.append(heading, notice("No change has been committed. Inspect every affected ID. Your drafts are retained even when artifacts are removed. Backup is a revision-qualified full snapshot, not an import or automatic undo."));
    for (const [label, ids] of [["Artifacts to remove", impact.removed], ["Confirmations to reset", impact.reviews_reset]]) {
      const group = el("section");
      group.append(el("h3", `${label}: ${ids.length}`));
      page(group, ids, ui.pages[label] || 0, index => { ui.pages[label] = index; persist(); renderImpact(); }, id => el("p", id));
      dialog.append(group);
    }
    const decide = decision => request({ type: "impactDecision", token: impact.token, decision }, pending || {});
    const controls = el("div", undefined, "toolbar");
    controls.append(button("Cancel change", () => decide("cancel")),
      button("Back up revision and apply", () => decide("backupAndApply")),
      button("Apply without backup", () => decide("apply")));
    dialog.append(controls);
    app.append(dialog);
    heading.focus();
    dialog.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); decide("cancel"); }
      if (event.key === "Tab") {
        const buttons = [...dialog.querySelectorAll("button:not(:disabled)")];
        if (event.shiftKey && (document.activeElement === buttons[0] || document.activeElement === heading)) {
          event.preventDefault(); buttons.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) {
          event.preventDefault(); buttons[0]?.focus();
        }
      }
    });
  }

  window.addEventListener("message", event => {
    const msg = event.data;
    if (msg.type === "impact") {
      busy = false; impact = msg;
      app.removeAttribute("aria-busy");
      app.querySelector("[data-saving]")?.remove();
      renderImpact();
      say("Review downstream change impact before applying.");
      return;
    }
    if (msg.type === "error") {
      busy = false;
      app.removeAttribute("aria-busy");
      app.querySelector("[data-saving]")?.remove();
      app.querySelectorAll("[data-was-disabled]").forEach(node => { node.disabled = node.dataset.wasDisabled === "true"; });
      error(msg.message);
      return;
    }
    busy = false;
    if (msg.type === "recovery") {
      recovery = msg.message;
      if (pending?.id === msg.requestId) pending = undefined;
      renderRecovery(recovery);
      say("Recovery available. Saved data has not been overwritten.");
      return;
    }
    if (msg.type !== "state") return;
    const acknowledged = pending && msg.outcome === "committed" && (!msg.requestId || msg.requestId === pending.id);
    const previous = state;
    state = msg.workflow; gates = msg.gates; eligible = msg.eligibility || {};
    artifactCache.clear();
    clearTimeout(filterTimer);
    recovery = undefined; impact = undefined;
    let focus = pending?.focus;
    if (acknowledged) {
      if (pending.key) delete ui.drafts[pending.key];
      if (pending.nextView) {
        ui.view = pending.nextView;
        focus = "view-heading";
      }
      if (pending.addedKind) {
        const oldIds = new Set(previous ? artifactsFrom(previous, pending.addedKind) : []);
        ui.selected[ui.view] = artifactsFrom(state, pending.addedKind).find(id => !oldIds.has(id));
        ui.filters[ui.view] = { query: "", status: "all", category: "all" };
        focus = "detail-heading";
      }
      say("Saved. Readiness and coverage recalculated.");
    } else if (msg.outcome === "cancelled") say("Cancelled. Saved state and drafts unchanged.");
    if (pending?.id === msg.requestId || acknowledged) pending = undefined;
    persist();
    render(focus);
  });
  function artifactsFrom(w, kind) {
    return kind === "criterion" ? w.features.flatMap(f => f.acceptance_criteria.map(ac => ac.acceptance_criteria_id)) :
      w.test_cases.map(t => t.test_case_id);
  }
  api.postMessage({ type: "ready" });
})();
