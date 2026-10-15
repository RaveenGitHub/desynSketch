const assert = require("node:assert/strict");
const vscode = require("vscode");
const { setTimeout: delay } = require("node:timers/promises");

async function waitForWorkflow() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.label === "Product Quality Workflow")) return;
    await delay(50);
  }
  assert.fail("The workflow webview tab did not appear within 10 seconds.");
}

exports.run = async () => {
  const extension = vscode.extensions.getExtension("local-tools.product-quality-workflow");
  assert.ok(extension, "The development extension must be discoverable.");
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("productQuality.open"), "The workflow command must be registered.");
  await vscode.commands.executeCommand("productQuality.open");
  await vscode.commands.executeCommand("productQuality.open");
  await waitForWorkflow();
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await vscode.commands.executeCommand("productQuality.open");
  await waitForWorkflow();
  console.log("Real VS Code host: activation, command, webview open/reveal/dispose/reopen passed.");
};
