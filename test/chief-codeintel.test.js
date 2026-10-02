// Read-only code intelligence. The GitHub client is injected. Tests never use
// a live token or the local filesystem as a tool.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { Effect } from "../server/chief/capabilities/descriptor.js";
import { createGithubReader } from "../server/chief/codeintel/github.js";
import { createCodeIntel } from "../server/chief/codeintel/index.js";
import { codeGuidance } from "../server/chief/context/assemble.js";
import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { EventBus, EventType } from "../server/chief/core/events.js";
import { MemoryAuditLog } from "../server/chief/security/audit.js";
import { loadCapabilityPolicy } from "../server/chief/security/grants.js";
import { createChiefTooling, createChiefTools } from "../server/chief/tools/builtin.js";
import { CHIEF_TOOL_INVENTORY } from "../server/chief/tools/inventory.js";
import { codeTraceDetail, TraceCollector } from "../server/chief/traces/collector.js";
import { MemoryTraceStore } from "../server/chief/traces/store.js";

const TOKEN = `ghp_${"a".repeat(36)}`;
const SOURCE = "export function runChiefTick() {\n  return true;\n}\n";

function codeEnv(token = TOKEN) {
  return {
    CHIEF_CODE_READ_TOKEN: token,
    CHIEF_CODE_REPOSITORY: "Freedomfarms/Forward-Freedom-Main",
    CHIEF_CODE_DEFAULT_REF: "main",
  };
}

function jsonResponse(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => String(text.length) },
    text: async () => text,
  };
}

function githubDouble({ tree = [], files = {}, search = { items: [] } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      authorization: init?.headers?.Authorization,
    });
    const href = String(url);
    if (href.includes("/git/trees/")) return jsonResponse({ truncated: false, tree });
    if (href.includes("/contents/")) {
      const marker = "/contents/";
      const start = href.indexOf(marker) + marker.length;
      const end = href.indexOf("?");
      const path = decodeURIComponent(href.slice(start, end === -1 ? href.length : end));
      const file = files[path];
      if (!file) return jsonResponse({ message: "Not Found" }, 404);
      if (file.dir) return jsonResponse([{ type: "dir", path }]);
      return jsonResponse({
        type: "file",
        encoding: "base64",
        size: Buffer.byteLength(file.content),
        content: Buffer.from(file.content).toString("base64"),
        path,
      });
    }
    if (href.includes("/search/code")) return jsonResponse(search);
    return jsonResponse({ message: "no" }, 404);
  };
  return { calls, fetchImpl };
}

function intelFor(double, env = codeEnv()) {
  return createCodeIntel({ env, fetchImpl: double.fetchImpl });
}

function policyWith(capabilities, deny = []) {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  for (const capability of capabilities) policy.grant("chief", capability);
  for (const capability of deny) policy.deny("chief", capability);
  return policy;
}

function tooling(codeintel, capabilities, deny = []) {
  return createChiefTooling({
    userId: "user-a",
    policy: policyWith(capabilities, deny),
    audit: new MemoryAuditLog(),
    stores: { codeintel },
  });
}

test("code capabilities are read-only and require code:read", () => {
  const tools = createChiefTools({
    codeintel: createCodeIntel({
      env: {},
      fetchImpl: async () => {
        throw new Error("no fetch");
      },
    }),
  });
  for (const name of ["code_tree", "code_read", "code_search"]) {
    const spec = tools.find((tool) => tool.spec.name === name).spec;
    assert.equal(spec.effect, Effect.READ);
    assert.equal(spec.confirmation, "none");
    assert.equal(spec.requiresConfirmation, false);
    assert.equal(spec.subsystem, "code");
    assert.deepEqual(spec.requiredCapabilities, [Capability.CODE_READ]);
    assert.deepEqual(CHIEF_TOOL_INVENTORY[name], [Capability.CODE_READ]);
    assert.equal(typeof spec.execute, "undefined");
  }
  assert.match(codeGuidance(["code_read", "code_tree", "code_search"]), /cannot edit files/);
  assert.equal(codeGuidance(["memory_read"]), "");
});

test("code:read is on the empty-grant baseline and an explicit deny wins", async () => {
  const policy = await loadCapabilityPolicy("user-a", {
    withUser: async (_userId, fn) => fn({ chiefCapabilityGrant: { findMany: async () => [] } }),
  });
  assert.equal(policy.check("chief", Capability.CODE_READ), true);
  assert.equal(policy.check("chief", Capability.FILE_READ), false);
  assert.equal(policy.check("chief", Capability.CODE_EXECUTE), false);

  const github = githubDouble({ files: { "server/index.js": { content: SOURCE } } });
  const blocked = await tooling(intelFor(github), [Capability.CODE_READ], [Capability.CODE_READ]);
  const denied = await blocked.executor.execute(
    { callId: "r", name: "code_read", arguments: { path: "server/index.js", userId: "user-b" } },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(denied.isError, true);
  assert.match(denied.output, /code:read/);
  assert.equal(github.calls.length, 0);
  assert.equal(denied.output.includes(TOKEN), false);
});

test("code_tree lists the configured repository and bounds the result", async () => {
  const tree = [
    { path: "server/chief/scheduler/tick.js", type: "blob", size: 10 },
    { path: ".env.local", type: "blob", size: 4 },
    { path: "docs", type: "tree" },
  ];
  for (let index = 0; index < 320; index += 1) {
    tree.push({ path: `src/file-${index}.js`, type: "blob", size: 1 });
  }
  const github = githubDouble({ tree });
  const ready = await tooling(intelFor(github), [Capability.CODE_READ]);
  const result = await ready.executor.execute(
    {
      callId: "t",
      name: "code_tree",
      arguments: {
        path: "server/chief",
        ref: "cursor/chief-settings-capabilities-e92a",
        userId: "user-b",
      },
    },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(result.isError, false);
  const body = JSON.parse(result.output);
  assert.equal(body.repository, "Freedomfarms/Forward-Freedom-Main");
  assert.equal(body.ref, "cursor/chief-settings-capabilities-e92a");
  assert.deepEqual(body.entries, [
    { path: "server/chief/scheduler/tick.js", type: "file", size: 10 },
  ]);
  assert.equal(body.truncated, false);
  assert.equal(result.output.includes(".env"), false);
  assert.equal(github.calls[0].method, "GET");
  assert.match(
    github.calls[0].url,
    /Freedomfarms%2FForward-Freedom-Main|Freedomfarms\/Forward-Freedom-Main/
  );
  assert.equal(github.calls[0].url.includes("Evil"), false);
  assert.equal(github.calls[0].authorization, `Bearer ${TOKEN}`);
  assert.equal(result.output.includes(TOKEN), false);

  const wide = githubDouble({
    tree: Array.from({ length: 305 }, (_item, index) => ({
      path: `src/file-${index}.js`,
      type: "blob",
      size: 1,
    })),
  });
  const bounded = await tooling(intelFor(wide), [Capability.CODE_READ]);
  const listed = await bounded.executor.execute(
    { callId: "w", name: "code_tree", arguments: {} },
    { userId: "user-a", agentId: "chief" }
  );
  const wideBody = JSON.parse(listed.output);
  assert.equal(wideBody.truncated, true);
  assert.equal(wideBody.total, 305);
  assert.equal(wideBody.entries.length, 300);
});

test("code_read returns a line range and refuses secrets, traversal, and other repositories", async () => {
  const lines = Array.from({ length: 250 }, (_item, index) => `const line${index} = ${index};`);
  const github = githubDouble({
    files: {
      "server/chief/scheduler/tick.js": { content: SOURCE },
      "src/wide.js": { content: lines.join("\n") },
      "src/secret-looking.js": { content: `const token = "${TOKEN}";\n` },
      "src/min.js": { content: "x".repeat(21_000) },
    },
  });
  const ready = await tooling(intelFor(github), [Capability.CODE_READ]);
  const context = { userId: "user-a", agentId: "chief" };
  const read = await ready.executor.execute(
    {
      callId: "r",
      name: "code_read",
      arguments: {
        path: "server/chief/scheduler/tick.js",
        ref: "main",
        userId: "user-b",
        url: "https://api.github.com/repos/Evil/Other/contents/README.md",
      },
    },
    context
  );
  assert.equal(read.isError, true);
  assert.match(read.output, /unsupported code argument/);
  assert.equal(github.calls.length, 0);

  const known = await ready.executor.execute(
    { callId: "k", name: "code_read", arguments: { path: "server/chief/scheduler/tick.js" } },
    context
  );
  assert.equal(known.isError, false);
  const knownBody = JSON.parse(known.output);
  assert.match(knownBody.content, /1\|export function runChiefTick/);
  assert.equal(knownBody.repository, "Freedomfarms/Forward-Freedom-Main");
  assert.equal(known.output.includes(TOKEN), false);
  assert.match(github.calls.at(-1).url, /\/repos\/Freedomfarms\/Forward-Freedom-Main\/contents\//);
  assert.equal(github.calls.at(-1).url.includes("Evil"), false);

  const whole = await ready.executor.execute(
    { callId: "wide", name: "code_read", arguments: { path: "src/wide.js" } },
    context
  );
  assert.equal(whole.isError, true);
  const wholeBody = JSON.parse(whole.output);
  assert.equal(wholeBody.error, "file exceeds the read limit");
  assert.equal(wholeBody.lines, 250);
  assert.equal(wholeBody.hint, "request start_line and end_line");
  assert.equal(whole.output.includes("const line0"), false);

  const range = await ready.executor.execute(
    {
      callId: "range",
      name: "code_read",
      arguments: { path: "src/wide.js", start_line: 1, end_line: 5 },
    },
    context
  );
  const rangeBody = JSON.parse(range.output);
  assert.equal(range.isError, false);
  assert.equal(rangeBody.startLine, 1);
  assert.equal(rangeBody.endLine, 5);
  assert.match(rangeBody.content, /1\|const line0/);
  assert.equal(rangeBody.content.includes("const line5"), false);

  const secret = await ready.executor.execute(
    { callId: "s", name: "code_read", arguments: { path: ".env.local" } },
    context
  );
  assert.equal(secret.isError, true);
  assert.equal(JSON.parse(secret.output).error, "that path is not available");
  assert.equal(secret.output.includes("SECRET"), false);

  const leaked = await ready.executor.execute(
    { callId: "leak", name: "code_read", arguments: { path: "src/secret-looking.js" } },
    context
  );
  assert.equal(leaked.isError, true);
  assert.equal(JSON.parse(leaked.output).error, "that path is not available");
  assert.equal(leaked.output.includes(TOKEN), false);

  const traversal = await ready.executor.execute(
    { callId: "trav", name: "code_read", arguments: { path: "../.env" } },
    context
  );
  assert.equal(JSON.parse(traversal.output).error, "invalid path");

  const hugeLine = await ready.executor.execute(
    {
      callId: "min",
      name: "code_read",
      arguments: { path: "src/min.js", start_line: 1, end_line: 1 },
    },
    context
  );
  assert.equal(hugeLine.isError, true);
  assert.equal(hugeLine.output.includes("x".repeat(100)), false);
  assert.equal(
    github.calls.every((call) => call.method === "GET" && !call.url.includes("Evil")),
    true
  );
});

test("an unauthorized code_read does not fetch", async () => {
  const github = githubDouble({ files: { "server/index.js": { content: SOURCE } } });
  const audit = new MemoryAuditLog();
  const ready = await createChiefTooling({
    userId: "user-a",
    policy: policyWith([]),
    audit,
    stores: { codeintel: intelFor(github) },
  });
  const denied = await ready.executor.execute(
    { callId: "r", name: "code_read", arguments: { path: "server/index.js" } },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(denied.isError, true);
  assert.match(denied.output, /code:read/);
  assert.equal(github.calls.length, 0);
  assert.equal(JSON.stringify(audit.entries).includes(SOURCE), false);
  assert.equal(JSON.stringify(audit.entries).includes(TOKEN), false);
});

test("code_search stays inside the repository and drops protected hits", async () => {
  const github = githubDouble({
    search: {
      items: [
        {
          path: "server/chief/scheduler/tick.js",
          repository: { full_name: "Freedomfarms/Forward-Freedom-Main" },
          text_matches: [{ fragment: "export function runChiefTick" }],
        },
        {
          path: ".env",
          repository: { full_name: "Freedomfarms/Forward-Freedom-Main" },
          text_matches: [{ fragment: "PLAID_SECRET=supersecretvalue" }],
        },
        {
          path: "stolen.js",
          repository: { full_name: "Evil/Other" },
          text_matches: [{ fragment: "nope" }],
        },
        {
          path: "server/leaked.js",
          repository: { full_name: "Freedomfarms/Forward-Freedom-Main" },
          text_matches: [{ fragment: `token ${TOKEN}` }],
        },
      ],
    },
  });
  const ready = await tooling(intelFor(github), [Capability.CODE_READ]);
  const found = await ready.executor.execute(
    { callId: "s", name: "code_search", arguments: { query: "runChiefTick", userId: "user-b" } },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(found.isError, false);
  const body = JSON.parse(found.output);
  assert.equal(body.contentSearch, true);
  assert.deepEqual(body.matches, [
    { path: "server/chief/scheduler/tick.js", text: "export function runChiefTick" },
  ]);
  assert.equal(found.output.includes(".env"), false);
  assert.equal(found.output.includes(TOKEN), false);
  assert.equal(found.output.includes("Evil"), false);
  assert.match(
    github.calls[0].url,
    /repo%3AFreedomfarms%2FForward-Freedom-Main|repo:Freedomfarms\/Forward-Freedom-Main/
  );

  const tooLong = await ready.executor.execute(
    { callId: "q", name: "code_search", arguments: { query: "a".repeat(161) } },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(JSON.parse(tooLong.output).error, "invalid query");

  const scoped = await ready.executor.execute(
    { callId: "scope", name: "code_search", arguments: { query: "repo:Evil/Other scheduler" } },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(JSON.parse(scoped.output).error, "invalid query");
  assert.equal(github.calls.length, 1);

  const branch = githubDouble({
    tree: [
      { path: "server/chief/scheduler/tick.js", type: "blob" },
      { path: ".env.local", type: "blob" },
      { path: "src/App.jsx", type: "blob" },
    ],
  });
  const names = await tooling(intelFor(branch), [Capability.CODE_READ]);
  const paths = await names.executor.execute(
    { callId: "p", name: "code_search", arguments: { query: "scheduler", ref: "feature/diamond" } },
    { userId: "user-a", agentId: "chief" }
  );
  const pathBody = JSON.parse(paths.output);
  assert.equal(pathBody.contentSearch, false);
  assert.deepEqual(pathBody.matches, [{ path: "server/chief/scheduler/tick.js" }]);
  assert.equal(
    branch.calls.some((call) => call.url.includes("/search/code")),
    false
  );
  assert.equal(
    branch.calls.every((call) => call.method === "GET"),
    true
  );
});

test("a code read trace records metadata and not source or the credential", async () => {
  const github = githubDouble({
    files: { "server/chief/scheduler/tick.js": { content: SOURCE } },
  });
  const bus = new EventBus();
  const traceStore = new MemoryTraceStore();
  const collector = new TraceCollector({ bus, store: traceStore, userId: "user-a" });
  collector.start();
  const ready = await createChiefTooling({
    userId: "user-a",
    policy: policyWith([Capability.CODE_READ]),
    audit: new MemoryAuditLog(),
    bus,
    stores: { codeintel: intelFor(github) },
  });
  const result = await ready.executor.execute(
    { callId: "r", name: "code_read", arguments: { path: "server/chief/scheduler/tick.js" } },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(result.isError, false);
  bus.publish(EventType.TOOL_CALL_END, {
    tool: "code_read",
    success: true,
    result: result.output,
    code: {
      ...JSON.parse(JSON.stringify(result)).traceMeta,
      content: SOURCE,
      token: TOKEN,
    },
  });
  await collector.finish({ outcome: "completed" });
  const step = traceStore.traces[0].steps.find((item) => item.name === "code_read");
  assert.equal(step.detail.success, true);
  assert.equal(step.detail.operation, "read");
  assert.equal(step.detail.repository, "Freedomfarms/Forward-Freedom-Main");
  assert.equal(step.detail.path, "server/chief/scheduler/tick.js");
  assert.equal(typeof step.detail.durationMs, "number");
  const dumped = JSON.stringify(traceStore.traces);
  assert.equal(dumped.includes("runChiefTick"), false);
  assert.equal(dumped.includes(TOKEN), false);
  assert.equal(Object.hasOwn(step.detail, "content"), false);
  assert.deepEqual(
    codeTraceDetail({ operation: "read", content: SOURCE, token: TOKEN, path: "server/index.js" }),
    { operation: "read", path: "server/index.js" }
  );
});

test("code intelligence has no write, deploy, or shell surface", () => {
  const source = readdirSync("server/chief/codeintel")
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(`server/chief/codeintel/${name}`, "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /child_process|node:fs|from ["']fs["']|vercel/i);
  assert.doesNotMatch(source, /method:\s*["'](POST|PUT|PATCH|DELETE)["']/);
  assert.doesNotMatch(source, /\/pulls|\/merges|git\/refs|createPullRequest|\bspawn\(/);
  const reader = createGithubReader({
    token: "t",
    owner: "Freedomfarms",
    repo: "Forward-Freedom-Main",
    fetchImpl: async () => {
      throw new Error("no");
    },
  });
  assert.deepEqual(Object.keys(reader).sort(), ["file", "search", "tree"]);
  const intel = createCodeIntel({
    env: {},
    fetchImpl: async () => {
      throw new Error("no");
    },
  });
  assert.deepEqual(Object.keys(intel).sort(), [
    "defaultRef",
    "enabled",
    "read",
    "repository",
    "search",
    "tree",
  ]);
});
