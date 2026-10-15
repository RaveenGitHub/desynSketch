# Product Quality Workflow

A local-only VS Code extension for stage-gated product definition and quality
engineering. No AI provider, remote-document retrieval, telemetry or credentials
are used.

## Run

Development requires Node.js 22.13+; the extension supports VS Code 1.95+.

1. Open this project folder in VS Code.
2. Run `npm install`, then `npm run compile`.
3. Press **F5** with **Run Product Quality Extension**.
4. In the Extension Development Host, run **Product Quality: Open Workflow**
   from the Command Palette.

Run `npm test` for domain and mocked extension-host regression tests.
For release validation, install Chromium with `npx playwright install chromium`,
then run `npm run verify` (lint, strict TypeScript compilation, unit/host-bridge
tests, workload budgets, browser journeys and package-content checks).
Run `npm run test:host` for a real VS Code 1.95.0 lifecycle smoke test. Set
`VSCODE_TEST_VERSION=stable` to test the current stable editor instead.
The test tools download their editor/browser binaries; the extension itself
still makes no remote requests.
Run `npm run package` to produce a local VSIX; install it
with **Extensions: Install from VSIX**.
Packaging preserves relative documentation links because this local extension
has no published repository URL; the diagram document is included in the VSIX.

See [UI flow and system architecture diagrams](docs/workflow-design.md).

## Seven focused views, three authoritative stages

Navigation is presentation state: switching views does **not** mutate saved
workflow readiness or revision. Host validators independently enforce every
generation, confirmation and stage gate.

| View | Stage | Purpose |
|---|---|---|
| Product Brief | 1 | Brief and optional solution-intent URLs; analyze/re-analyze |
| Clarifications | 1 | Resolve and confirm questions/ambiguities; confirm product |
| Features | 2 | Typed scope, constraints, dependencies and INVEST review |
| Acceptance Criteria | 2 | Independently edit/validate GWT, measurement and SMART |
| Test Scenarios | 3 | Review six categories per AC, Gherkin and risk metadata |
| Test Cases | 3 | Preconditions, data, environment and ordered steps/results |
| Export & Summary | Any | Readiness, gaps, risk summary, drafts and references |

### Stage 1 - Product Brief & Intent

Enter a nonempty brief and optional HTTP(S) URLs, then **Analyze brief**.
The shared clarification specification supplies 13 required categories: intent,
actors, capabilities, scope, rules, boundaries, data, dependencies, operations,
security, performance, environment and measurable success. A bounded vague-term
matcher adds ambiguity flags; each reference URL requires authority/version and
intent confirmation. Suggestions are never treated as answers.

URLs are references only and are not fetched. Review documents yourself and
paste authoritative summaries/excerpts locally. If none exist, explicitly confirm
that and describe the agreed solution intent. Never paste secrets or personal data.

Use the searchable clarification list to select an item. Enter an answer and
reviewer rationale; **Resolve / Save**, then **Confirm saved resolution**.
Supply **one independent capability per line** (1-100 unique lines).
After all items are confirmed, complete the product review form and
**Confirm product definition**. **Proceed to Features** is enabled only when
Stage 1 is fully resolved.

### Stage 2 - Feature & AC Definition

Feature drafts have requirement/product linkage, description, scope, constraints,
dependencies and one initial AC. Use typed fields rather than whole-object JSON.
IDs, linkage, category, generation revision, review statuses and derived fields
are read-only. An advanced editable-field JSON option excludes these fields.

In **Acceptance Criteria**, refine Given/When/Then, supply an exact `measurement`
with threshold, unit and verification time/condition, affirm SMART and supply
review notes/confidence. Save, then confirm the criterion. **Add AC** creates a
new independently editable criterion.

In **Features**, affirm INVEST only after reviewing independence, negotiability,
business value, estimability, size and testability. Save and confirm the feature
after its ACs. Features failing INVEST must be split/reworked via the Stage 1
capability list. **Proceed to Scenarios** remains blocked until all features/ACs
are complete, validated and confirmed.

### Stage 3 - Test Scenarios & Cases

Six scenario categories are drafted per AC: positive, negative, boundary,
operational risk, security and performance. Cases are initially generated together
with scenarios, but their reviews are separate.

Refine scenario GWT, design technique and risk metadata, save and confirm.
In **Test Cases**, supply concrete synthetic test data, preconditions, environment,
review metadata, actions and per-step expected results. The ordered editor supports
adding, removing and moving steps. **Add test case** supports separate partitions,
decision combinations and boundary values.

Test data starts blank and deliberately blocks confirmation. Confirm the parent
scenario before its cases. **Complete review** requires all six categories per AC,
cases for every scenario, valid metadata, complete reviews and valid earlier gates;
it then opens the summary. For a genuinely inapplicable category, document the
rationale and make its draft a verifiable applicability assessment.

## Editing, drafts and scalable navigation

- Artifact lists support text search, review-status filtering, category filtering
  where applicable, and 12-item pages with a single detail editor. Coverage always
  uses the full dataset, never only visible results.
- Search text is indexed once per received snapshot and query changes are
  debounced by 120 ms; pagination does not change coverage or review scope.
- Field errors are associated with inputs. Confirmation buttons show explicit
  reasons and use host-computed saved-artifact eligibility; unsaved edits cannot
  be confirmed. Incomplete structurally valid drafts may be saved for later review.
- **Saved**, **Unsaved draft** and an announced saving state distinguish local
  edits from committed artifacts. Focus and view scroll are restored after saves.
- Local drafts, selections and filters use VS Code webview state and survive view
  changes, another artifact's save and webview restoration. Only a successfully
  committed save clears that artifact's draft. Failed/cancelled actions retain it.
  Drafts are local presentation state, not committed workflow artifacts or exports.
- If saved editable values or generation identity changed, saving the old draft
  is blocked. Inspect current saved values, then explicitly **Rebase retained draft**
  or discard only that draft. Regenerated artifacts retain stable IDs but have a
  new read-only generation revision.
- Removing an artifact does not remove its local draft. Detached drafts remain
  visible as copyable JSON in **Retained drafts** within the summary. Webview state
  is not a permanent audit store: export committed work and copy drafts you need
  before uninstalling, clearing editor state or changing workspaces.

## Impact preview, persistence and recovery

Committed workflows use VS Code **workspaceState** and resume in the same
workspace. Requests are serialized and revision-checked. Candidate transitions
are validated without mutating current state, then persisted **before** success
is published. Failed persistence reports an error and does not advance state.

Disruptive actions display an exact, paginated **Change impact** preview:

- Re-analyzing a brief or changing a clarification answer removes dependent
  features, ACs, scenarios and cases. Notes-only clarification edits retain them
  but require clarification/product re-confirmation.
- Feature content changes (title, description, scope, constraints, dependencies)
  remove only that feature's scenarios/cases. AC content changes (Given, When,
  Then, measurement) remove only that AC's scenarios/cases.
- Metadata/checklist edits retain descendant content and confirmations, but reset
  the edited artifact's review (and the parent feature's review for an AC).
  Earlier unresolved gates still prevent progression and reduce lineage credit.
- Scenario content edits reset that scenario and its related case confirmations;
  scenario metadata-only edits reset its own review.
- Unchanged artifact saves and repeated confirmations are no-ops: revision,
  timestamps, reviews and downstream work remain unchanged. Object key order and
  derived fields do not count as editable changes.
- Adding an AC preserves existing tests. After upstream reviews are completed,
  **Proceed to Scenarios** fills missing categories/cases without replacing
  unrelated IDs, generation revisions, content or reviews.
- Preview **Artifacts to remove** and **Confirmations to reset** before choosing
  **Cancel change**, **Back up revision and apply**, or **Apply without backup**.
- Backup saves a full snapshot under a revision-qualified suggested file name.
  Cancelling the Save dialog keeps the preview open and does not apply the change.
  This is a user-saved snapshot, not automatic undo, import or a tamper-evident
  historical audit database.

Malformed saved state opens **Saved workflow recovery** rather than preventing UI
access. Read diagnostics, **Back up damaged snapshot**, **Retry loading saved state**
or explicitly **Reset saved workflow**. No malformed data is silently replaced.
Reset always requires native modal confirmation; retained drafts are separate
and must be discarded explicitly.

Workspace state, webview draft state and exports are not encrypted. Use appropriate
workstation/file permissions.

## Export & Summary

The summary is available at every stage and reports committed revision, readiness,
artifact counts, high/critical risks, stage gaps and the reference explorer.
Choose an export stage and JSON, YAML or Markdown; exporting does not navigate
stages or change readiness/revision.

Exports include the chosen stage and upstream context with every metadata field.
Incomplete exports are labeled **draft** with all blocking items; fully reviewed
ones are labeled **reviewed**, not passed execution results. YAML uses YAML 1.2's
JSON-compatible syntax for lossless serialization. Markdown includes readable
artifacts, Gherkin, cases, directional references and a metadata appendix. Stage 3
includes the requirement-to-case matrix. Exports are deliverables, not an import
format; local unsaved drafts are not included.

## Combined traceability and coverage score

The calculation is versioned as `balanced-stage-checks-v1`:

- Stage score = `100 * passed checks / total checks`.
- Overall = equal-weight mean of all three stage scores. Future stages remain
  incomplete rather than being excluded. Only all checks passing gives 100%.
- Values are rounded down to one decimal. Stage gates remain independent of score.
- Stage 1 checks clarification presence, answers/notes, confirmations and product
  review. Stage 2 checks capability/feature/AC linkage, INVEST, SMART and reviews.
- Stage 3 checks six-category reviewed scenario/case coverage per AC, case presence,
  valid reverse lineage to reviewed upstream artifacts, metadata and reviews.
- Recompute after every committed action, restoration and export. Failed or
  cancelled changes leave saved scores unchanged. Navigation does not change them.
  Adding a draft AC/case or invalidating descendants can lower the score.

Forward: `Product -> Feature -> AC -> Scenario -> Test Case`.
Reverse: `Test Case -> Scenario -> AC -> Feature -> Product`.
Clarifications also link to their product. Select an ID to open its focused view.
Paginated reference results and all exports expose both directions.

Stage-specific exports exclude downstream data and recompute their snapshot's
score, which may differ from the complete live workflow. Scores measure
**structural traceability and reviewed planned coverage**, not code coverage,
test execution pass rates, semantic completeness or security assurance. This
limitation is shown in the main UI and in every export format.

## Release checks and workload envelope

The checked-in CI runs on Windows and Linux with Node.js 22. It runs lint,
compilation, domain/host-bridge tests, headless Chromium journeys, dependency audit,
workload and package-content checks, then builds the VSIX. Separate real editor
smoke tests cover VS Code 1.95.0 and current stable activation, command registration
and webview open/reveal/dispose/reopen. Browser tests use the real compiled host
bridge with mocked editor APIs; they do not claim end-to-end native dialog coverage.

The synthetic workload regression contains 100 features, 1,000 ACs and 6,000
scenarios/cases. It checks 100% reviewed structural coverage and complete lineage,
with budgets of less than 500 ms for one coverage calculation and less than
2,000 ms for one metadata edit transition. These are development regression
budgets, not guarantees for all hardware or end-to-end webview/persistence latency.
Snapshots are still transmitted and stored in full; exceptionally large text and
larger workloads require additional capacity testing.

## Standards and limits

INVEST, SMART and Gherkin conventions guide reviews. Draft techniques include
ISTQB-style equivalence partitions, boundary values, decision tables and state
transitions, plus risk-based operational, security and performance checks.
Traceable review artifacts support practices associated with ISO/IEC/IEEE 29119.
**This is alignment guidance, not standards certification.**

The deterministic engine does not understand arbitrary architecture documents,
infer hidden rules, resolve semantic contradictions or prove ambiguity-free
completeness. Every generated artifact remains a human-reviewed template.
Confidence is on a 0-100 scale: human-assessed confidence starts at zero;
generated test-linkage confidence starts at 100 for exact ID relationships,
not semantic quality. Automation flags track planning only; generated cases are
not executed by this extension.
