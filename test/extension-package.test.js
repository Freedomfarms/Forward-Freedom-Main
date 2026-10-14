import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const extensionRoot = new URL("../extension/", import.meta.url);
const packagedUrl = new URL("../extension/dist/content.js", import.meta.url);

function read(url) {
  return readFileSync(url, "utf8");
}

function packagedFiles(manifest) {
  const files = [];
  for (const entry of manifest.content_scripts ?? []) {
    files.push(...(entry.js ?? []), ...(entry.css ?? []));
  }
  if (manifest.background?.service_worker) files.push(manifest.background.service_worker);
  if (manifest.options_ui?.page) files.push(manifest.options_ui.page);
  return files;
}

function runPackaged(code, { href, document }) {
  const sent = [];
  const sandbox = {
    URL,
    document,
    location: { href },
    window: {
      clearTimeout() {},
      setTimeout(callback) {
        callback();
        return 1;
      },
    },
    chrome: {
      runtime: {
        sendMessage(message) {
          sent.push(message);
        },
      },
    },
    MutationObserver: class {
      observe() {}
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sent;
}

test("extension build emits a classic content script the manifest can load", () => {
  const before = read(packagedUrl);
  const result = spawnSync(process.execPath, ["scripts/build-extension.mjs"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const after = read(packagedUrl);
  assert.equal(
    after,
    before,
    "extension/dist/content.js drifted from the source. Run npm run build:extension and commit the result."
  );

  assert.equal(/\bimport\s*(?:\(|["'{*])/.test(after), false);
  assert.equal(/^\s*export\s/m.test(after), false);
  assert.equal(after.includes("import.meta"), false);
  assert.equal(after.includes("./src/extract.js"), false);
  assert.equal(after.includes("external-capture"), false);
  assert.equal(after.includes("authorization"), false);
  assert.doesNotThrow(() => new vm.Script(after));
  assert.throws(
    () => new vm.Script(read(new URL("content.js", extensionRoot))),
    /import statement outside a module/
  );

  const manifest = JSON.parse(read(new URL("manifest.json", extensionRoot)));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.content_scripts[0].js, ["dist/content.js"]);
  assert.equal(Object.hasOwn(manifest.content_scripts[0], "type"), false);
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.background.service_worker, "background.js");
  for (const file of packagedFiles(manifest)) {
    assert.equal(existsSync(join(extensionRoot.pathname, file)), true, file);
  }
  assert.equal(existsSync(join(extensionRoot.pathname, "options.js")), true);

  const claude = runPackaged(after, {
    href: "https://claude.ai/chat/2222222222222222",
    document: {
      title: "Bridge",
      documentElement: {},
      querySelector(selector) {
        if (selector === "h1, title") return { textContent: "Bridge" };
        return null;
      },
      querySelectorAll(selector) {
        if (selector === "[data-testid='user-message'], [data-testid='assistant-message']") {
          return [
            {
              getAttribute(name) {
                if (name === "data-testid") return "user-message";
                if (name === "data-message-id") return "m-user";
                return null;
              },
              textContent: "Where is the lighthouse?",
            },
            {
              getAttribute(name) {
                if (name === "data-testid") return "assistant-message";
                if (name === "data-message-id") return "m-assistant";
                return null;
              },
              textContent: "Use the archive.",
            },
          ];
        }
        return [];
      },
    },
  });
  assert.equal(claude.length, 1);
  assert.equal(claude[0].type, "page");
  assert.equal(claude[0].snapshot.provider, "claude");
  assert.equal(claude[0].snapshot.externalId, "2222222222222222");
  assert.equal(claude[0].snapshot.title, "Bridge");
  assert.equal(claude[0].snapshot.streaming, false);
  assert.equal(claude[0].snapshot.messages.length, 2);
  assert.equal(claude[0].snapshot.messages[0].role, "user");
  assert.equal(claude[0].snapshot.messages[0].externalId, "m-user");
  assert.equal(claude[0].snapshot.messages[0].text, "Where is the lighthouse?");
  assert.equal(claude[0].snapshot.messages[1].role, "assistant");
  assert.equal(claude[0].snapshot.messages[1].externalId, "m-assistant");

  const chatgpt = runPackaged(after, {
    href: "https://chatgpt.com/c/3333333333333333",
    document: {
      title: "Other",
      documentElement: {},
      querySelector() {
        return null;
      },
      querySelectorAll(selector) {
        if (selector === "[data-message-author-role]") {
          return [
            {
              getAttribute(name) {
                if (name === "data-message-author-role") return "user";
                if (name === "data-message-id") return "u1";
                return null;
              },
              textContent: "Hello archive",
            },
            {
              getAttribute(name) {
                if (name === "data-message-author-role") return "assistant";
                if (name === "data-message-id") return "a1";
                return null;
              },
              textContent: "Hello back",
            },
          ];
        }
        return [];
      },
    },
  });
  assert.equal(chatgpt.length, 1);
  assert.equal(chatgpt[0].snapshot.provider, "chatgpt");
  assert.equal(chatgpt[0].snapshot.externalId, "3333333333333333");
  assert.equal(chatgpt[0].snapshot.messages.length, 2);
  assert.equal(chatgpt[0].snapshot.messages[1].externalId, "a1");

  const login = runPackaged(after, {
    href: "https://claude.ai/login",
    document: {
      title: "Login",
      documentElement: {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    },
  });
  assert.equal(login.length, 1);
  assert.equal(login[0].snapshot.recognized, false);
  assert.equal(login[0].snapshot.messages.length, 0);
});
