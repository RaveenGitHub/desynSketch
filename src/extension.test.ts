import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { Workflow } from "./model";
import { emptyWorkflow, transition } from "./workflow";

function host(initial: unknown) {
  let saved = initial;
  let command: (() => void) | undefined;
  let receiver: ((message: unknown) => void) | undefined;
  let failPersist = false;
  let savePath: string | undefined = "snapshot.json";
  let confirmation: string | undefined = "Reset workflow";
  let dispose: (() => void) | undefined;
  const writes: { uri: unknown; data: Uint8Array }[] = [];
  const messages: Record<string, unknown>[] = [];
  const waiting: ((message: Record<string, unknown>) => void)[] = [];
  const uri = (fsPath: string) => ({ fsPath, toString: () => fsPath });
  const vscode = {
    Uri: { joinPath: (_base: unknown, ...parts: string[]) => uri(parts.join("\\")) },
    ViewColumn: { One: 1 },
    commands: { registerCommand: (_id: string, callback: () => void) => { command = callback; return {}; } },
    workspace: { fs: { writeFile: async (target: unknown, data: Uint8Array) => { writes.push({ uri: target, data }); } } },
    window: {
      showSaveDialog: async () => savePath ? uri(savePath) : undefined,
      showWarningMessage: async () => confirmation,
      showInformationMessage: () => undefined, showErrorMessage: () => undefined,
      createWebviewPanel: () => ({
        reveal: () => undefined,
        onDidDispose: (callback: () => void) => { dispose = callback; return {}; },
        webview: {
          cspSource: "test:",
          html: "",
          asWebviewUri: (value: unknown) => value,
          onDidReceiveMessage: (callback: (message: unknown) => void) => { receiver = callback; return {}; },
          postMessage: async (message: Record<string, unknown>) => {
            messages.push(message);
            waiting.shift()?.(message);
            return true;
          }
        }
      })
    }
  };
  const moduleRequire = createRequire(path.join(__dirname, "extension.js"));
  const exported: { activate?: (context: unknown) => void } = {};
  runInNewContext(readFileSync(path.join(__dirname, "extension.js"), "utf8"), {
    exports: exported, require: (id: string) => id === "vscode" ? vscode : moduleRequire(id), Buffer
  });
  exported.activate?.({
    extensionUri: uri("extension"),
    subscriptions: [],
    workspaceState: {
      get: () => saved,
      update: async (_key: string, next: unknown) => {
        if (failPersist) throw new Error("Simulated persistence failure");
        saved = next;
      }
    }
  });
  command?.();
  const send = (message: unknown): Promise<Record<string, unknown>> => new Promise(resolve => {
    waiting.push(resolve);
    receiver?.(message);
  });
  return {
    send, messages, writes, saved: () => saved,
    fail: (value: boolean) => { failPersist = value; },
    destination: (value: string | undefined) => { savePath = value; },
    confirm: (value: string | undefined) => { confirmation = value; },
    reopen: () => { dispose?.(); command?.(); }
  };
}

function seed(): Workflow {
  let w = transition(emptyWorkflow(), { type: "analyze", brief: "Synthetic inventory", links: [] });
  for (const i of w.product.items) {
    w = transition(w, { type: "resolve", id: i.id, answer: i.key === "capabilities" ? "Create stock" : "Explicit synthetic contract.", notes: "Owner reviewed" });
    w = transition(w, { type: "confirmItem", id: i.id });
  }
  w = transition(w, { type: "confirmProduct", notes: "Reviewed", priority: "high", confidence: 90, traceConfidence: 90 });
  return transition(w, { type: "proceed" });
}

test("host recovery backs up raw malformed data, supports cancellation, and resets only with explicit consent", async () => {
  const corrupt = { schema_version: 999, important: "preserve me" };
  const h = host(corrupt);
  const recovery = await h.send({ type: "ready" });
  assert.equal(recovery.type, "recovery");
  const backup = await h.send({ type: "backupRecovery", requestId: "backup" });
  assert.equal(backup.type, "recovery");
  assert.deepEqual(JSON.parse(Buffer.from(h.writes[0]!.data).toString()), corrupt);
  assert.deepEqual(h.saved(), corrupt);
  h.confirm(undefined);
  await h.send({ type: "reset", requestId: "cancel" });
  assert.deepEqual(h.saved(), corrupt);
  h.confirm("Reset workflow");
  const reset = await h.send({ type: "reset", requestId: "reset" });
  assert.equal(reset.type, "state");
  assert.equal(reset.outcome, "committed");
  assert.equal((h.saved() as Workflow).coverage.overall_score, 0);
});

test("host previews exact impact before committing; cancellation preserves saved revision and score", async () => {
  const before = seed();
  const h = host(before);
  const preview = await h.send({ type: "action", requestId: "save", revision: before.revision,
    action: { type: "resolve", id: "Q-001", answer: "Changed intent", notes: "Owner reviewed" } });
  assert.equal(preview.type, "impact");
  assert.deepEqual(preview.removed, ["RQ-001", "AC-001-01"]);
  assert.deepEqual(h.saved(), before);
  const cancelled = await h.send({ type: "impactDecision", decision: "cancel", token: preview.token,
    revision: before.revision, requestId: "save" });
  assert.equal(cancelled.outcome, "cancelled");
  assert.deepEqual(h.saved(), before);
});

test("backup-and-apply cancellation does not commit; accepted backup captures the prior revision", async () => {
  const before = seed();
  const h = host(before);
  const preview = await h.send({ type: "action", requestId: "save", revision: before.revision,
    action: { type: "resolve", id: "Q-001", answer: "Changed intent", notes: "Owner reviewed" } });
  h.destination(undefined);
  const stillPending = await h.send({ type: "impactDecision", decision: "backupAndApply", token: preview.token,
    revision: before.revision, requestId: "save" });
  assert.equal(stillPending.type, "impact");
  assert.deepEqual(h.saved(), before);
  h.destination("snapshot.json");
  const committed = await h.send({ type: "impactDecision", decision: "backupAndApply", token: preview.token,
    revision: before.revision, requestId: "save" });
  assert.equal(committed.outcome, "committed");
  assert.equal(committed.requestId, "save");
  assert.equal((h.saved() as Workflow).features.length, 0);
  assert.deepEqual(JSON.parse(Buffer.from(h.writes[0]!.data).toString()), before);
});

test("persistence errors preserve original state and retries succeed; stale messages are rejected", async () => {
  const h = host(emptyWorkflow());
  const action = { type: "analyze", brief: "Stock", links: [] };
  h.fail(true);
  const failed = await h.send({ type: "action", action, revision: 0, requestId: "save" });
  assert.equal(failed.type, "error");
  assert.match(String(failed.message), /persistence failure/);
  assert.equal((h.saved() as Workflow).revision, 0);
  h.fail(false);
  const done = await h.send({ type: "action", action, revision: 0, requestId: "save2" });
  assert.equal(done.outcome, "committed");
  const stale = await h.send({ type: "action", action, revision: 0, requestId: "stale" });
  assert.equal(stale.type, "error");
  assert.match(String(stale.message), /Stale revision/);
});

test("host exports selected stage without navigation or revision changes", async () => {
  const before = seed();
  const h = host(before);
  const output = await h.send({ type: "export", stage: 1, format: "json", revision: before.revision, requestId: "export" });
  assert.equal(output.outcome, "exported");
  const data = JSON.parse(Buffer.from(h.writes[0]!.data).toString());
  assert.equal(data.stage, 1);
  assert.equal(data.features, undefined);
  assert.deepEqual(h.saved(), before);
  h.reopen();
  const state = await h.send({ type: "ready" });
  assert.equal(state.type, "state");
});

test("impact tokens cannot be forged and a failed commit can be retried without losing the candidate", async () => {
  const before = seed();
  const h = host(before);
  const preview = await h.send({ type: "action", requestId: "save", revision: before.revision,
    action: { type: "resolve", id: "Q-001", answer: "Changed intent", notes: "Owner reviewed" } });
  const forged = await h.send({ type: "impactDecision", decision: "apply", token: "forged",
    revision: before.revision, requestId: "save" });
  assert.equal(forged.type, "error");
  assert.deepEqual(h.saved(), before);
  h.fail(true);
  const failed = await h.send({ type: "impactDecision", decision: "apply", token: preview.token,
    revision: before.revision, requestId: "save" });
  assert.equal(failed.type, "error");
  assert.deepEqual(h.saved(), before);
  h.fail(false);
  const committed = await h.send({ type: "impactDecision", decision: "apply", token: preview.token,
    revision: before.revision, requestId: "save" });
  assert.equal(committed.outcome, "committed");
  assert.equal((h.saved() as Workflow).revision, before.revision + 1);
});
