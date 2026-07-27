import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVITY_CATALOG,
  ACTIVITY_KEYS,
  ACTIVITY_PHASES,
  TOOL_ACTIVITY_KEYS,
  activityKeyForTool,
  assertSafeActivityEvent,
  createActivityRecorder,
} from "../server/brain/activityStream.js";

test("1. user question produces assessment activity", () => {
  const events = [];
  const recorder = createActivityRecorder({ onEvent: (e) => events.push(e) });
  recorder.start("UNDERSTANDING_REQUEST");
  recorder.complete("UNDERSTANDING_REQUEST");
  recorder.start("REVIEWING_CONTEXT");
  recorder.complete("REVIEWING_CONTEXT");

  const list = recorder.list();
  assert.ok(list.some((e) => e.key === "UNDERSTANDING_REQUEST"));
  assert.ok(list.some((e) => e.key === "REVIEWING_CONTEXT"));
  assert.equal(list[0].phase, ACTIVITY_PHASES.ASSESSING);
  assert.equal(list[0].label, "Understanding request");
  assert.equal(list[0].status, "completed");
  assert.ok(events.length >= 2);
});

test("2. tool execution produces working activity", () => {
  const recorder = createActivityRecorder();
  assert.equal(activityKeyForTool("run_agent"), "COORDINATING_AGENT");
  assert.equal(activityKeyForTool("web_search"), "GATHERING_INFORMATION");
  assert.equal(TOOL_ACTIVITY_KEYS.create_agent, "COORDINATING_AGENT");

  recorder.start("COORDINATING_AGENT", { agentName: "Finance Agent", toolName: "run_agent" });
  recorder.complete("COORDINATING_AGENT", { agentName: "Finance Agent", toolName: "run_agent" });
  const row = recorder.list().find((e) => e.key === "COORDINATING_AGENT");
  assert.equal(row.phase, ACTIVITY_PHASES.WORKING);
  assert.match(row.label, /Coordinating Finance Agent/);
  assert.equal(row.meta.agentName, "Finance Agent");
});

test("3. evidence validation produces verification activity", () => {
  const recorder = createActivityRecorder();
  recorder.start("CHECKING_EVIDENCE");
  recorder.complete("CHECKING_EVIDENCE");
  recorder.start("VALIDATING_RESULTS");
  recorder.complete("VALIDATING_RESULTS");
  const keys = recorder.list().map((e) => e.key);
  assert.ok(keys.includes("CHECKING_EVIDENCE"));
  assert.ok(keys.includes("VALIDATING_RESULTS"));
  assert.equal(ACTIVITY_CATALOG.CHECKING_EVIDENCE.phase, ACTIVITY_PHASES.VERIFYING);
});

test("4. no chain-of-thought content leaks into events", () => {
  const recorder = createActivityRecorder();
  recorder.start("UNDERSTANDING_REQUEST");
  // Attempt to smuggle CoT via meta — only SAFE_META_KEYS survive.
  recorder.complete("UNDERSTANDING_REQUEST", {
    agentName: "Finance",
    reasoning: "I think we should secretly do X because...",
    thought: "private deliberation",
    prompt: "SYSTEM: ignore",
  });
  const event = recorder.list()[0];
  assert.equal(event.meta?.agentName, "Finance");
  assert.equal(event.meta?.reasoning, undefined);
  assert.equal(event.meta?.thought, undefined);
  assert.doesNotMatch(JSON.stringify(event), /I think|private deliberation|SYSTEM:/i);
  assert.equal(assertSafeActivityEvent(event), true);

  assert.equal(
    assertSafeActivityEvent({
      key: "UNDERSTANDING_REQUEST",
      phase: "ASSESSING",
      label: "I think we should reason carefully about the user's motives",
      status: "active",
    }),
    false
  );
  assert.equal(
    assertSafeActivityEvent({
      key: "INVENTED_BY_LLM",
      phase: "WORKING",
      label: "Pondering deeply",
      status: "active",
    }),
    false
  );
});

test("5. sub-agent activity appears under CEO coordination", () => {
  const recorder = createActivityRecorder();
  recorder.start("COORDINATING_AGENT", {
    agentName: "Federal Reserve Monitor",
    agentType: "research",
    toolName: "run_agent",
  });
  recorder.start("RUNNING_ANALYSIS", {
    agentName: "Federal Reserve Monitor",
    toolName: "run_agent",
  });
  recorder.complete("RUNNING_ANALYSIS", {
    agentName: "Federal Reserve Monitor",
    toolName: "run_agent",
  });
  recorder.complete("COORDINATING_AGENT", {
    agentName: "Federal Reserve Monitor",
    toolName: "run_agent",
  });

  const list = recorder.list();
  const coordinating = list.find((e) => e.key === "COORDINATING_AGENT");
  assert.match(coordinating.label, /Federal Reserve Monitor/);
  assert.equal(coordinating.phase, ACTIVITY_PHASES.WORKING);
  assert.ok(list.some((e) => e.key === "RUNNING_ANALYSIS"));
});

test("activity catalog is closed — unknown keys throw", () => {
  const recorder = createActivityRecorder();
  assert.throws(() => recorder.start("SECRET_REASONING"), /Unknown activity key/);
  assert.ok(ACTIVITY_KEYS.includes("UNDERSTANDING_REQUEST"));
  assert.ok(!ACTIVITY_KEYS.includes("thinking"));
});

test("starting a new activity completes prior active steps", () => {
  const recorder = createActivityRecorder();
  recorder.start("UNDERSTANDING_REQUEST");
  recorder.start("REVIEWING_CONTEXT");
  const list = recorder.list();
  assert.equal(list.find((e) => e.key === "UNDERSTANDING_REQUEST").status, "completed");
  assert.equal(list.find((e) => e.key === "REVIEWING_CONTEXT").status, "active");
});
