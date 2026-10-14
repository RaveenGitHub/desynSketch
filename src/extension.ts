import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { ExportFormat, exportArtifact } from "./export";
import { Workflow, emptyWorkflow } from "./model";
import { isRecord, requireFields } from "./validation";
import { Action, decodeAction, gates, refresh, restore, transition } from "./workflow";
import { eligibility, impactPreview, needsImpactConfirmation } from "./presentation";

const storageKey = "productQuality.workflow.v1";

export function activate(context: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;
  let workflow: Workflow | undefined;
  let recovery: { message: string; raw: unknown } | undefined;
  let pending: { token: string; revision: number; action: Action; candidate: Workflow; requestId: string } | undefined;
  let queue: Promise<void> = Promise.resolve();

  const load = (): void => {
    const raw = context.workspaceState.get<unknown>(storageKey);
    try {
      workflow = raw === undefined ? emptyWorkflow() : restore(raw);
      refresh(workflow);
      recovery = undefined;
    } catch (error) {
      workflow = undefined;
      recovery = { message: error instanceof Error ? error.message : String(error), raw };
    }
  };

  const postState = async (requestId?: string, outcome = "unchanged"): Promise<void> => {
    if (recovery) {
      await panel?.webview.postMessage({ type: "recovery", message: recovery.message, requestId, outcome });
    } else if (workflow) {
      refresh(workflow);
      await panel?.webview.postMessage({
        type: "state", workflow, gates: gates(workflow), eligibility: eligibility(workflow), requestId, outcome
      });
    }
  };

  const backup = async (raw: unknown, revision?: number): Promise<boolean> => {
    const uri = await vscode.window.showSaveDialog({
      title: "Save immutable workflow snapshot before changing state",
      defaultUri: vscode.Uri.joinPath(context.extensionUri,
        revision === undefined ? "product-quality-recovery.json" : `product-quality-revision-${revision}.json`),
      filters: { JSON: ["json"] }
    });
    if (!uri) return false;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(raw, null, 2), "utf8"));
    void vscode.window.showInformationMessage(`Snapshot saved to ${uri.fsPath}.`);
    return true;
  };

  const commit = async (next: Workflow, requestId: string, action?: Action): Promise<void> => {
    await context.workspaceState.update(storageKey, next);
    workflow = next;
    recovery = undefined;
    pending = undefined;
    await postState(requestId, "committed");
    if (action?.type === "proceed" && next.stage === 3 && gates(next).stage3.length === 0) {
      void vscode.window.showInformationMessage("All artifacts reviewed; requirement-to-test traceability complete.");
    }
  };

  const handle = async (message: unknown): Promise<void> => {
    requireFields(isRecord(message) && typeof message.type === "string", "Malformed webview message.");
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    if (message.type === "ready") { await postState(); return; }
    if (message.type === "retryRecovery") {
      requireFields(recovery !== undefined, "No recovery is required.");
      load();
      await postState(requestId);
      return;
    }
    if (message.type === "backupRecovery") {
      requireFields(recovery !== undefined, "No damaged snapshot to back up.");
      await backup(recovery.raw);
      await postState(requestId);
      return;
    }
    if (message.type === "reset") {
      if (workflow) requireFields(message.revision === workflow.revision, "Stale reset request.");
      const result = await vscode.window.showWarningMessage(
        "Replace all saved workflow data? Back up first. This cannot be undone from the extension.",
        { modal: true }, "Reset workflow"
      );
      if (result === "Reset workflow") {
        const next = emptyWorkflow();
        next.revision = (workflow?.revision ?? 0) + 1;
        refresh(next);
        await commit(next, requestId);
      } else await postState(requestId, "cancelled");
      return;
    }
    requireFields(workflow !== undefined, "Saved workflow needs recovery. Back up or reset from the recovery view.");
    requireFields(message.revision === workflow.revision, "Stale revision. Your draft is retained; reopen and review against the latest saved state.");
    if (message.type === "impactDecision") {
      requireFields(pending !== undefined && message.token === pending.token &&
        pending.revision === workflow.revision, "Impact preview expired. Save again to get a fresh preview.");
      if (message.decision === "cancel") {
        pending = undefined;
        await postState(requestId, "cancelled");
      } else if (message.decision === "apply" || message.decision === "backupAndApply") {
        if (message.decision === "backupAndApply" && !await backup(workflow, workflow.revision)) {
          await panel?.webview.postMessage({ type: "impact", ...impactPreview(workflow, pending.candidate),
            token: pending.token, requestId: pending.requestId });
          return;
        }
        const accepted = pending;
        await commit(accepted.candidate, accepted.requestId, accepted.action);
      } else throw new Error("Unknown impact decision.");
      return;
    }
    requireFields(pending === undefined, "Resolve the pending impact preview first.");
    if (message.type === "export") {
      requireFields(message.format === "json" || message.format === "yaml" || message.format === "markdown", "Unknown export format.");
      requireFields(message.stage === 1 || message.stage === 2 || message.stage === 3, "Choose a valid export stage.");
      const format: ExportFormat = message.format;
      const stage = message.stage;
      const suffix = format === "markdown" ? "md" : format;
      const uri = await vscode.window.showSaveDialog({
        title: `Export Stage ${stage} (${gates(workflow)[`stage${stage}`].length ? "draft" : "reviewed"})`,
        defaultUri: vscode.Uri.joinPath(context.extensionUri, `product-quality-stage-${stage}-revision-${workflow.revision}.${suffix}`),
        filters: { [format.toUpperCase()]: [suffix] }
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(exportArtifact(workflow, stage, format), "utf8"));
        void vscode.window.showInformationMessage(`Stage ${stage}, revision ${workflow.revision} exported.`);
      }
      await postState(requestId, uri ? "exported" : "cancelled");
      return;
    }
    requireFields(message.type === "action", "Unknown webview request.");
    const action = decodeAction(message.action);
    const candidate = transition(workflow, action);
    const impact = impactPreview(workflow, candidate);
    if (needsImpactConfirmation(action, impact)) {
      pending = { token: randomBytes(16).toString("hex"), revision: workflow.revision, action, candidate, requestId };
      await panel?.webview.postMessage({ type: "impact", ...impact, token: pending.token, requestId });
    } else if (action.type === "navigate") {
      await postState(requestId);
    } else await commit(candidate, requestId, action);
  };

  context.subscriptions.push(vscode.commands.registerCommand("productQuality.open", () => {
    if (panel) { panel.reveal(); return; }
    load();
    panel = vscode.window.createWebviewPanel("productQuality", "Product Quality Workflow", vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
    });
    const nonce = randomBytes(24).toString("hex");
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "main.js"));
    const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "style.css"));
    const escape = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escape(panel.webview.cspSource)}; script-src 'nonce-${nonce}'; connect-src 'none';">
<link rel="stylesheet" href="${escape(style.toString())}"><title>Product Quality Workflow</title></head>
<body><header><h1>Product Quality Workflow</h1><p>Local-only. No AI services or remote document retrieval.</p></header>
<div id="error" role="alert" hidden></div><main id="app"><p>Loading saved workflow...</p></main>
<div id="announcement" class="sr-only" role="status" aria-live="polite"></div>
<script nonce="${nonce}" src="${escape(script.toString())}"></script></body></html>`;
    context.subscriptions.push(panel.onDidDispose(() => { panel = undefined; pending = undefined; }));
    context.subscriptions.push(panel.webview.onDidReceiveMessage((message: unknown) => {
      queue = queue.then(async () => {
        try { await handle(message); } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await panel?.webview.postMessage({ type: "error", message: reason,
            requestId: isRecord(message) ? message.requestId : undefined });
          void vscode.window.showErrorMessage(`Product Quality: ${reason}`);
        }
      });
    }));
  }));
}
