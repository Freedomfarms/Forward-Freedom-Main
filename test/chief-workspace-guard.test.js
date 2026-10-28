import test from "node:test";
import assert from "node:assert/strict";

import {
  confirmManagedWorkspaceTool,
  planWorkspaceRestore,
  restoreWorkspaceWrites,
  snapshotGuardedMemories,
} from "../server/chief/managed/workspaceGuard.js";

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

test("a restore puts back only the unsafe write and keeps a concurrent edit", async () => {
  const events = [
    { type: "user.message", id: "user_1" },
    {
      type: "agent.tool_use",
      id: "write_1",
      name: "write",
      input: { file_path: "/decisions.md", content: NOTES },
    },
    { type: "agent.tool_result", tool_use_id: "write_1", is_error: false },
  ];
  const plan = planWorkspaceRestore({
    snapshot: snapshot(),
    events,
    userText: "Can you see the site code?",
  });
  const updates = [];
  const client = {
    async listMemories() {
      return [
        {
          id: "mem_decisions",
          path: "/decisions.md",
          content: "The user added a real decision while the reply was running.",
          content_sha256: "b".repeat(64),
        },
      ];
    },
    async updateMemory() {
      updates.push("update");
    },
  };
  const preserved = await restoreWorkspaceWrites({
    client,
    memoryStoreId: "store",
    snapshot: snapshot(),
    events,
    userText: "Can you see the site code?",
  });
  assert.equal(preserved[0].preserved, true);
  assert.equal(updates.length, 0);
  assert.equal(plan[0].writtenContent, NOTES);

  let calls = 0;
  const restoring = {
    async listMemories() {
      return [
        {
          id: "mem_decisions",
          path: "/decisions.md",
          content: NOTES,
          content_sha256: "c".repeat(64),
        },
      ];
    },
    async updateMemory(_store, _id, body) {
      calls += 1;
      assert.equal(body.content, PRIOR);
      assert.equal(body.precondition.content_sha256, "c".repeat(64));
      if (calls === 1) {
        const error = new Error("conflict");
        error.status = 409;
        throw error;
      }
    },
  };
  const conflict = await restoreWorkspaceWrites({
    client: restoring,
    memoryStoreId: "store",
    snapshot: snapshot(),
    events,
    userText: "Can you see the site code?",
  });
  assert.equal(conflict[0].conflict, true);
  assert.equal(calls, 1);
});

test("workspace confirmation allows mounted reads and refuses protected or host writes", () => {
  assert.equal(confirmManagedWorkspaceTool("read", { path: "/notes.md" }), "allow");
  assert.equal(
    confirmManagedWorkspaceTool("read", { file_path: "/mnt/memory/chief/decisions.md" }),
    "allow"
  );
  assert.equal(confirmManagedWorkspaceTool("grep", { pattern: "priority" }), "allow");
  assert.equal(confirmManagedWorkspaceTool("write", { path: "skills/note.md", content: "ok" }), "allow");
  assert.equal(confirmManagedWorkspaceTool("edit", { path: "./skills/note.md" }), "allow");

  for (const target of [
    "/etc/passwd",
    "/workspace/.env",
    "../.ssh/id_rsa",
    "C:/Windows/system32",
    "https://github.com/Freedomfarms/Forward-Freedom-Main",
    "/mnt/memory/../../etc/passwd",
  ]) {
    assert.equal(confirmManagedWorkspaceTool("write", { path: target, content: "x" }), "deny", target);
    assert.equal(confirmManagedWorkspaceTool("read", { path: target }), "deny", target);
  }
  for (const file of ["decisions.md", "requirements.md", "open-questions.md", "next-step.md"]) {
    assert.equal(
      confirmManagedWorkspaceTool("write", { file_path: `/mnt/memory/chief/${file}`, content: "x" }),
      "deny",
      file
    );
    assert.equal(confirmManagedWorkspaceTool("edit", { path: file }), "deny", file);
  }
  assert.equal(confirmManagedWorkspaceTool("bash", { command: "ls" }), "deny");
  assert.equal(confirmManagedWorkspaceTool("web_search", { query: "x" }), "deny");
  assert.equal(confirmManagedWorkspaceTool("write", {}), "deny");
});
