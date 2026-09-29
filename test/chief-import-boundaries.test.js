// Locks in the CHIEF (Module 03) import boundaries defined in eslint.config.js
// per docs/CHIEF_ARCHITECTURE.md §4. Uses the ESLint API against virtual file
// paths so the boundary is verified even before the CHIEF directories exist,
// and keeps protecting it as code lands.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ESLint } from "eslint";

const RULE_ID = "chief-boundaries/no-cross-module-imports";
const repoRoot = process.cwd();

const eslint = new ESLint({ cwd: repoRoot });

async function boundaryViolations(relativeFilePath, code) {
  const filePath = path.join(repoRoot, relativeFilePath);
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
  return (result?.messages || []).filter((message) => message.ruleId === RULE_ID);
}

async function assertBlocked(relativeFilePath, code) {
  const violations = await boundaryViolations(relativeFilePath, code);
  assert.ok(
    violations.length > 0,
    `expected boundary violation for ${relativeFilePath} but lint passed`
  );
}

async function assertAllowed(relativeFilePath, code) {
  const violations = await boundaryViolations(relativeFilePath, code);
  assert.deepEqual(
    violations.map((violation) => violation.message),
    [],
    `expected no boundary violation for ${relativeFilePath}`
  );
}

test("CHIEF server code cannot import Module 01 server code", async () => {
  await assertBlocked(
    "server/chief/runtime/turn.js",
    'import { brainTurn } from "../../brain/index.js";'
  );
  await assertBlocked("server/chief/index.js", 'import { runAgent } from "../agents/runner.js";');
  await assertBlocked(
    "server/chief/memory/extraction.js",
    'export { extract } from "../../memory/extraction.js";'
  );
});

test("CHIEF API handlers cannot import Module 01 code", async () => {
  await assertBlocked("api/chief/chat.js", 'import handler from "../../server/brain/index.js";');
  await assertBlocked(
    "api/cron/chief-dispatch.js",
    'import { runAgent } from "../../server/agents/runner.js";'
  );
  await assertBlocked("api/chief/approvals.js", 'import agents from "../agents.js";');
});

test("CHIEF's own subdirectories are not false positives", async () => {
  // server/chief/agents is CHIEF's agent hierarchy, not Module 01's
  // server/agents — the rule must resolve paths, not match names.
  await assertAllowed(
    "server/chief/runtime/turn.js",
    'import { BaseAgent } from "../agents/base.js";'
  );
  await assertAllowed("server/chief/index.js", 'import { registry } from "./core/registry.js";');
});

test("CHIEF may use shared platform infrastructure", async () => {
  await assertAllowed(
    "server/chief/index.js",
    'import { verifyAuth } from "../auth/verifyAuth.js";'
  );
  await assertAllowed(
    "server/chief/memory/store.js",
    'import { getPrisma } from "../../db/client.js";'
  );
});

test("dynamic imports are also gated", async () => {
  await assertBlocked(
    "server/chief/runtime/turn.js",
    'const mod = await import("../../brain/toolBelt.js");'
  );
});

test("CHIEF UI cannot import Module 01 UI or client plumbing", async () => {
  await assertBlocked(
    "src/components/chief/CommandCenter.jsx",
    'import FreedomOsHome from "../freedomOs/FreedomOsHome.jsx";'
  );
  await assertBlocked(
    "src/components/chief/CommandCenter.jsx",
    'import { fetchAgents } from "../../utils/agentsApi.js";'
  );
  await assertAllowed(
    "src/components/chief/CommandCenter.jsx",
    'import { CortexMap } from "../../third_party/cortex-map/index.js";'
  );
});

test("Module 01 server code cannot import CHIEF", async () => {
  await assertBlocked("server/agents/runner.js", 'import { chiefTurn } from "../chief/index.js";');
  await assertBlocked(
    "server/brain/index.js",
    'import { registry } from "../chief/core/registry.js";'
  );
});

test("Module 01 UI cannot import CHIEF UI or vendored code", async () => {
  await assertBlocked(
    "src/components/freedomOs/FreedomOsHome.jsx",
    'import CommandCenter from "../chief/CommandCenter.jsx";'
  );
  await assertBlocked(
    "src/components/freedomOs/AgentChat.jsx",
    'import { CortexMap } from "../../third_party/cortex-map/index.js";'
  );
});

test("vendored third_party code is only consumable from CHIEF UI", async () => {
  await assertBlocked(
    "src/utils/api.js",
    'import { CortexMap } from "../third_party/cortex-map/index.js";'
  );
  // The app shell is allowed to import the CHIEF UI entry (module hub
  // registration) — but not vendored code directly.
  await assertBlocked(
    "src/ForwardFreedomDashboard.jsx",
    'import { CortexMap } from "./third_party/cortex-map/index.js";'
  );
  await assertAllowed(
    "src/ForwardFreedomDashboard.jsx",
    'import ChiefCommandCenter from "./components/chief/CommandCenter.jsx";'
  );
});

test("vendored third_party code cannot reach into the application", async () => {
  await assertBlocked(
    "src/third_party/cortex-map/CortexMap.js",
    'import { api } from "../../utils/api.js";'
  );
  await assertAllowed(
    "src/third_party/cortex-map/CortexMap.js",
    'import { relaxLayout } from "./layout.js";'
  );
});

test("CHIEF model layer cannot reuse Module 01's LLM wrapper", async () => {
  // server/agents/llm.js is Module 01's Anthropic client; CHIEF's provider
  // layer must go through its own descriptors (server/chief/models/providers.js).
  await assertBlocked(
    "server/chief/models/providers.js",
    'import { createAnthropic } from "../../agents/llm.js";'
  );
  await assertAllowed(
    "server/chief/models/providers.js",
    'import { createXai } from "@ai-sdk/xai";'
  );
  await assertAllowed(
    "server/chief/models/engine.js",
    'import { ModelRegistry } from "../core/registry.js";'
  );
});

test("Phase 3 orchestration does not import a provider SDK", () => {
  const files = [
    "server/chief/runtime/turn.js",
    "server/chief/runtime/checkpoint.js",
    "server/chief/tools/executor.js",
    "server/chief/tools/builtin.js",
    "server/chief/tools/spec.js",
    "server/chief/security/taint.js",
    "server/chief/security/boundary.js",
    "server/chief/memory/facts.js",
    "server/chief/memory/graph.js",
    "api/chief/chat.js",
    "api/chief/approvals.js",
  ];
  for (const file of files) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    assert.doesNotMatch(source, /@ai-sdk\//, `${file} imports a provider SDK`);
    assert.doesNotMatch(source, /server\/(brain|agents|memory)\//, `${file} imports Module 01`);
    assert.doesNotMatch(source, /hermes|AIAgent|NousResearch/i, `${file} couples to Hermes`);
    assert.doesNotMatch(source, /createXai|@ai-sdk\/xai/, `${file} couples to the Grok SDK`);
  }
});

test("bare npm specifiers are never affected", async () => {
  await assertAllowed("server/chief/models/router.js", 'import { generateText } from "ai";');
  await assertAllowed(
    "src/components/chief/CommandCenter.jsx",
    'import { useState } from "react";'
  );
});
