import test from "node:test";
import assert from "node:assert/strict";

import { planWorkspaceRestore, snapshotGuardedMemories } from "../server/chief/managed/workspaceGuard.js";

const PRIOR = "Decisions made for this user. Do not paste an old chat transcript.";
const NOTES = "## Code access findings\nThe mode toggle was not in the bundle.";

function snapshot() {
  return snapshotGuardedMemories([
    {
      id: "mem_decisions",
      path: "/decisions.md",
      content: PRIOR,
      content_sha256: "a".repeat(64),
    },
  ]);
}

test("a code explanation that writes decisions.md without reading it is restored", () => {
  const events = [
    { type: "user.message", id: "user_1" },
    {
      type: "agent.tool_use",
      id: "write_1",
      name: "write",
      input: { file_path: "/mnt/memory/chief/decisions.md", content: NOTES },
    },
    { type: "agent.tool_result", tool_use_id: "write_1", is_error: false },
  ];
  const plan = planWorkspaceRestore({
    snapshot: snapshot(),
    events,
    userText: "You have access to code of this site?",
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].path, "decisions.md");
  assert.equal(plan[0].content, PRIOR);
  assert.equal(plan[0].memoryId, "mem_decisions");
});

test("a read followed by an edit keeps the file, and a replacement needs an explicit request", () => {
  const events = [
    { type: "user.message", id: "user_1" },
    {
      type: "agent.tool_use",
      id: "read_1",
      name: "read",
      input: { path: "/decisions.md" },
    },
    { type: "agent.tool_result", tool_use_id: "read_1", is_error: false, content: PRIOR },
    {
      type: "agent.tool_use",
      id: "edit_1",
      name: "edit",
      input: { file_path: "/decisions.md", old_string: "user", new_string: "account" },
    },
  ];
  assert.equal(
    planWorkspaceRestore({ snapshot: snapshot(), events, userText: "Please fix a typo." }).length,
    0
  );

  const replaced = [
    ...events,
    {
      type: "agent.tool_use",
      id: "write_2",
      name: "write",
      input: { file_path: "/decisions.md", content: NOTES },
    },
  ];
  assert.equal(
    planWorkspaceRestore({ snapshot: snapshot(), events: replaced, userText: "Please fix a typo." })
      .length,
    1
  );
  assert.equal(
    planWorkspaceRestore({
      snapshot: snapshot(),
      events: replaced,
      userText: "Replace the decision with the feeder note.",
    }).length,
    0
  );
});

test("a read in an earlier turn does not authorize a later replacement", () => {
  const events = [
    { type: "user.message", id: "user_old" },
    { type: "agent.tool_use", id: "read_old", name: "read", input: { path: "/decisions.md" } },
    { type: "agent.tool_result", tool_use_id: "read_old", is_error: false },
    { type: "user.message", id: "user_new" },
    {
      type: "agent.tool_use",
      id: "write_new",
      name: "write",
      input: { file_path: "/decisions.md", content: NOTES },
    },
  ];
  const plan = planWorkspaceRestore({
    snapshot: snapshot(),
    events,
    userText: "How much of the site can you see?",
  });
  assert.equal(plan.length, 1);
});
