const { readFileSync } = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { runInNewContext } = require("node:vm");

function createHost(initial) {
  let saved = initial;
  let receiver, command, dispose;
  const writes = [];
  const waiters = [];
  let failPersistence = false;
  const uri = fsPath => ({ fsPath, toString: () => fsPath });
  const vscode = {
    Uri: { joinPath: (_base, ...parts) => uri(parts.join(path.sep)) },
    ViewColumn: { One: 1 },
    commands: { registerCommand: (_id, callback) => { command = callback; return {}; } },
    workspace: { fs: { writeFile: async (_uri, data) => { writes.push(Buffer.from(data).toString()); } } },
    window: {
      showSaveDialog: async () => uri("synthetic-export.json"),
      showWarningMessage: async () => "Reset workflow",
      showInformationMessage: () => undefined,
      showErrorMessage: () => undefined,
      createWebviewPanel: () => ({
        reveal: () => undefined,
        onDidDispose: callback => { dispose = callback; return {}; },
        webview: {
          cspSource: "test:", html: "", asWebviewUri: value => value,
          onDidReceiveMessage: callback => { receiver = callback; return {}; },
          postMessage: async message => { waiters.shift()(message); return true; }
        }
      })
    }
  };
  const modulePath = path.resolve(__dirname, "..", "..", "dist", "extension.js");
  const moduleRequire = createRequire(modulePath);
  const exported = {};
  runInNewContext(readFileSync(modulePath, "utf8"), {
    exports: exported, Buffer, require: id => id === "vscode" ? vscode : moduleRequire(id)
  });
  exported.activate({
    extensionUri: uri("extension"), subscriptions: [],
    workspaceState: {
      get: () => saved,
      update: async (_key, next) => {
        if (failPersistence) throw new Error("Synthetic persistence failure");
        saved = next;
      }
    }
  });
  command();
  return {
    send: message => new Promise(resolve => { waiters.push(resolve); receiver(message); }),
    saved: () => saved, writes,
    fail: value => { failPersistence = value; },
    reopen: () => { dispose(); command(); }
  };
}

module.exports = { createHost };
