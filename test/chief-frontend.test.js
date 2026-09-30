// CHIEF V1 conversation UI protocol. These checks stay on the pure helpers so
// they do not boot Firebase. The component files are scanned as source.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  CHIEF_STATUS,
  applyChiefEvent,
  approvalSubmission,
  conversationLabel,
  consumeSseBuffer,
  formatChiefTime,
  initialTurnState,
  messageSubmission,
  modelSubmission,
  publicTranscriptMessages,
} from "../src/utils/chiefProtocol.js";

const repoRoot = process.cwd();

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("conversation labels fall back without inventing a title", () => {
  assert.equal(conversationLabel({ title: "  Freedom OS  " }), "Freedom OS");
  assert.equal(
    conversationLabel({ title: null, createdAt: "2026-09-30T15:00:00.000Z" }),
    "Conversation · Sep 30"
  );
  assert.equal(conversationLabel({ title: "   " }), "Conversation");
});

test("relative times stay short", () => {
  const updated = "2026-09-30T12:00:00.000Z";
  const now = new Date(updated).getTime();
  assert.equal(formatChiefTime(updated, now + 20_000), "now");
  assert.equal(formatChiefTime(updated, now + 5 * 60_000), "5m");
  assert.equal(formatChiefTime(updated, now + 2 * 60 * 60_000), "2h");
  assert.equal(formatChiefTime(updated, now + 3 * 24 * 60 * 60_000), "3d");
  assert.equal(formatChiefTime(updated, now + 10 * 24 * 60 * 60_000), "Sep 30");
});

test("streaming hides reasoning and keeps one session id", () => {
  let state = initialTurnState(null);
  state = applyChiefEvent(state, {
    msg: {
      type: "assistant_content_delta",
      phase: "reasoning",
      delta: "hidden thought",
      session_id: "sess-1",
    },
  });
  assert.equal(state.streamText, "");
  assert.equal(state.sessionId, "sess-1");

  state = applyChiefEvent(state, {
    msg: {
      type: "assistant_content_delta",
      phase: "commentary",
      delta: "also hidden",
      session_id: "sess-1",
    },
  });
  assert.equal(state.streamText, "");

  state = applyChiefEvent(state, {
    msg: {
      type: "assistant_content_delta",
      phase: "final_answer",
      delta: "Hello",
      session_id: "sess-1",
    },
  });
  assert.equal(state.status, CHIEF_STATUS.RESPONDING);
  assert.equal(state.streamText, "Hello");
  assert.equal(state.sessionId, "sess-1");

  state = applyChiefEvent(state, {
    msg: { type: "token_count", info: { total_tokens: 99 } },
  });
  assert.equal(state.streamText, "Hello");
  assert.equal(JSON.stringify(state).includes("total_tokens"), false);

  state = applyChiefEvent(state, {
    msg: { type: "session_configured", session_id: "sess-1", status: "completed" },
  });
  assert.equal(state.finished, true);
  assert.equal(state.status, CHIEF_STATUS.READY);
  assert.equal(state.sessionId, "sess-1");
});

test("tool status stays in natural language and drops arguments", () => {
  const finance = applyChiefEvent(initialTurnState("sess-1"), {
    msg: {
      type: "tool_call_begin",
      name: "finance_summary",
      arguments: { accountId: "secret" },
    },
  });
  assert.equal(finance.status, CHIEF_STATUS.FINANCE);
  assert.equal(JSON.stringify(finance).includes("secret"), false);
  assert.equal(JSON.stringify(finance).includes("finance_summary"), false);

  const other = applyChiefEvent(initialTurnState("sess-1"), {
    msg: { type: "tool_call_begin", name: "mcp_invoke", arguments: { raw: true } },
  });
  assert.equal(other.status, CHIEF_STATUS.TOOL);
  assert.equal(JSON.stringify(other).includes("mcp_invoke"), false);
});

test("approval events keep only the decision id", () => {
  let state = applyChiefEvent(initialTurnState("sess-1"), {
    msg: {
      type: "exec_approval_request",
      id: "ap-1",
      turn_id: "turn-1",
      reason: "policy",
      calls: [{ name: "finance_summary", arguments: { secret: 1 } }],
    },
  });
  assert.equal(state.status, CHIEF_STATUS.APPROVAL);
  assert.deepEqual(state.approval, { id: "ap-1", turnId: "turn-1" });
  assert.equal(JSON.stringify(state).includes("secret"), false);
  assert.equal(JSON.stringify(state).includes("policy"), false);

  state = applyChiefEvent(state, {
    msg: { type: "session_configured", session_id: "sess-1", status: "suspended" },
  });
  assert.equal(state.finished, false);
  assert.equal(state.status, CHIEF_STATUS.APPROVAL);
  assert.equal(state.sessionId, "sess-1");
  assert.deepEqual(state.approval, { id: "ap-1", turnId: "turn-1" });
});

test("history transcript shows user and assistant text only", () => {
  const visible = publicTranscriptMessages([
    { role: "user", text: "How are the accounts?" },
    { role: "tool", text: 'finance_summary {"secret":1}' },
    { role: "assistant", text: null },
    { role: "assistant", text: "Here's what I found." },
    { role: "system", text: "internal" },
  ]);
  assert.deepEqual(
    visible.map((message) => ({ role: message.role, text: message.text })),
    [
      { role: "user", text: "How are the accounts?" },
      { role: "assistant", text: "Here's what I found." },
    ]
  );
});

test("chat and approval submissions match the existing ops", () => {
  const message = messageSubmission("Hello");
  assert.equal(message.op.type, "message");
  assert.deepEqual(message.op.message, { text: "Hello" });
  assert.equal("session_id" in message, false);

  const denied = approvalSubmission("ap-1", "deny");
  assert.equal(denied.op.type, "exec_approval");
  assert.equal(denied.op.id, "ap-1");
  assert.deepEqual(denied.op.decision, { denied: { rejection: "Not approved." } });
  assert.equal(approvalSubmission("ap-1", "approve").op.decision, "approved");
});

test("set_model submissions name a route and do not carry a message", () => {
  const submission = modelSubmission("claude-sonnet-4-6");
  assert.equal(submission.op.type, "set_model");
  assert.equal(submission.op.route, "claude-sonnet-4-6");
  assert.equal(submission.op.message, undefined);
});

test("SSE frames can split across chunks", () => {
  const partial = consumeSseBuffer("", 'data: {"msg":{"type":"turn_started"}}\n');
  assert.deepEqual(partial.events, []);
  const rest = consumeSseBuffer(partial.buffer, "\n");
  assert.equal(rest.events[0].msg.type, "turn_started");
  assert.equal(rest.buffer, "");
});

test("CHIEF UI does not reuse Freedom OS agent chat or agentsApi", () => {
  const files = readdirSync(path.join(repoRoot, "src/components/chief")).filter((name) =>
    name.endsWith(".jsx")
  );
  assert.ok(files.includes("ChiefPage.jsx"));
  for (const name of files) {
    const source = read(`src/components/chief/${name}`);
    assert.equal(source.includes("freedomOs"), false, name);
    assert.equal(source.includes("agentsApi"), false, name);
    assert.equal(source.includes("useFreedomOsBootstrap"), false, name);
    assert.equal(source.includes("session_search"), false, name);
    assert.equal(source.includes("ForwardFreedomDashboard"), false, name);
  }

  const api = read("src/utils/chiefApi.js");
  assert.match(api, /submission: messageSubmission/);
  assert.match(api, /session_id: sessionId/);
  assert.equal(api.includes("agentsApi"), false);
  assert.match(read("src/ForwardFreedomDashboard.jsx"), /APP_TABS\.CHIEF/);
  assert.match(read("src/data/constants.jsx"), /CHIEF: "CHIEF"/);
  assert.match(read("server/index.js"), /\/api\/chief\/chat/);
});
