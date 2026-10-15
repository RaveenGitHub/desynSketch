const js = require("@eslint/js");
const ts = require("typescript-eslint");
const globals = require("globals");

module.exports = [
  { ignores: ["dist/**", "node_modules/**", ".vscode-test/**", "test-results/**", "playwright-report/**"] },
  js.configs.recommended,
  ...ts.configs.recommended.map(config => ({ ...config, files: ["src/**/*.ts"] })),
  {
    files: ["**/*.{js,cjs,ts}"],
    languageOptions: { globals: globals.node },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_" }] }
  },
  {
    files: ["src/**/*.ts"],
    rules: { "no-unused-vars": "off", "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] }
  },
  {
    files: ["media/*.js"],
    languageOptions: { globals: { ...globals.browser, acquireVsCodeApi: "readonly" } }
  },
  {
    files: ["tests/ui/*.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } }
  }
];
