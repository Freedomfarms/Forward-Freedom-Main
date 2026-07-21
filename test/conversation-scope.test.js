import test from "node:test";
import assert from "node:assert/strict";
import {
  filterConversationsInScope,
  isConversationInScope,
  isRecoverableConversationError,
} from "../src/components/freedomOs/conversationScope.js";

test("CEO scope rejects sub-agent conversations and system threads", () => {
  assert.equal(
    isConversationInScope(
      { id: "1", ceoAgentConfigId: "ceo-1", agentConfigId: null, isSystem: false },
      { mode: "ceo" }
    ),
    true
  );
  assert.equal(
    isConversationInScope(
      { id: "2", ceoAgentConfigId: null, agentConfigId: "agent-1", isSystem: false },
      { mode: "ceo" }
    ),
    false
  );
  assert.equal(
    isConversationInScope(
      { id: "3", ceoAgentConfigId: "ceo-1", agentConfigId: null, isSystem: true },
      { mode: "ceo" }
    ),
    false
  );
});

test("sub-agent scope stays on one agent and never mixes CEO threads", () => {
  assert.equal(
    isConversationInScope(
      { id: "a", agentConfigId: "agent-1", ceoAgentConfigId: null, isSystem: false },
      { mode: "agent", agentId: "agent-1" }
    ),
    true
  );
  assert.equal(
    isConversationInScope(
      { id: "b", agentConfigId: "agent-2", ceoAgentConfigId: null, isSystem: false },
      { mode: "agent", agentId: "agent-1" }
    ),
    false
  );
  assert.equal(
    isConversationInScope(
      { id: "c", agentConfigId: null, ceoAgentConfigId: "ceo-1", isSystem: false },
      { mode: "agent", agentId: "agent-1" }
    ),
    false
  );
});

test("filterConversationsInScope drops foreign rows", () => {
  const rows = [
    { id: "ceo", ceoAgentConfigId: "ceo-1", agentConfigId: null, isSystem: false },
    { id: "agent", ceoAgentConfigId: null, agentConfigId: "agent-1", isSystem: false },
  ];
  assert.deepEqual(
    filterConversationsInScope(rows, { mode: "ceo" }).map((row) => row.id),
    ["ceo"]
  );
  assert.deepEqual(
    filterConversationsInScope(rows, { mode: "agent", agentId: "agent-1" }).map((row) => row.id),
    ["agent"]
  );
});

test("isRecoverableConversationError recognizes mismatch codes and messages", () => {
  assert.equal(
    isRecoverableConversationError({ payload: { code: "CONVERSATION_TARGET_MISMATCH" } }),
    true
  );
  assert.equal(
    isRecoverableConversationError({ message: "Conversation does not belong to this agent chat." }),
    true
  );
  assert.equal(isRecoverableConversationError({ message: "rate limited" }), false);
});
