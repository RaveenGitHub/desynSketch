const { test } = require("node:test");
const assert = require("node:assert/strict");
const { listFiles } = require("@vscode/vsce");
const path = require("node:path");

test("VSIX includes runtime and documentation, not development tools or tests", async () => {
  const files = (await listFiles({ cwd: path.resolve(__dirname, "..") })).map(file => file.replaceAll("\\", "/"));
  for (const file of ["package.json", "README.md", "dist/extension.js", "media/main.js", "media/style.css", "docs/workflow-design.md"]) {
    assert.ok(files.includes(file), `${file} must be packaged.`);
  }
  const forbidden = files.filter(file => /^(?:tests|scripts|src|node_modules|\.github|\.vscode-test|test-results|playwright-report)\//.test(file) ||
    /\.test\.js$/.test(file) || /^(?:eslint|playwright)\.config\.js$/.test(file));
  assert.deepEqual(forbidden, [], "Development/test files must not be distributed.");
});
