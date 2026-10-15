const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

runTests({
  version: process.env.VSCODE_TEST_VERSION || "1.95.0",
  extensionDevelopmentPath: path.resolve(__dirname, ".."),
  extensionTestsPath: path.resolve(__dirname, "..", "tests", "host", "suite.cjs"),
  launchArgs: ["--disable-extensions", "--skip-welcome", "--skip-release-notes"]
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
