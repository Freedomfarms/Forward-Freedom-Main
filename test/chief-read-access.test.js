// One read dispatch for code, finance, and conversations.
// Grants still decide what is allowed. The adapter decides how it is read.

import test from "node:test";
import assert from "node:assert/strict";

import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { READ_RESOURCES, readResource } from "../server/chief/resources/access.js";

test("read resources expose list, get, and query and no writes", async () => {
  assert.equal(READ_RESOURCES.code.capability, Capability.CODE_READ);
  assert.deepEqual(Object.keys(READ_RESOURCES.code.operations).sort(), ["get", "list", "query"]);
  assert.equal(READ_RESOURCES.finance.capability, Capability.FINANCE_READ);
  assert.deepEqual(READ_RESOURCES.finance.operations, { get: "finance_summary" });
  assert.equal(READ_RESOURCES.conversations.capability, Capability.CONVERSATION_READ);
  assert.equal(READ_RESOURCES.conversations.operations.list, "conversation_search");
  assert.equal(READ_RESOURCES.conversations.operations.get, "conversation_retrieve");
  assert.equal(READ_RESOURCES.code.operations.write, undefined);
  assert.equal(READ_RESOURCES.finance.operations.delete, undefined);

  let retrieved = false;
  const denied = await readResource({
    resource: "finance",
    operation: "get",
    policy: { check: () => false },
    retrieve: async () => {
      retrieved = true;
      return { balance: 1 };
    },
  });
  assert.equal(denied.isError, true);
  assert.equal(retrieved, false);

  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("chief", Capability.CONVERSATION_READ);
  const allowed = await readResource({
    resource: "conversations",
    operation: "list",
    policy,
    agentId: "chief",
    retrieve: async () => ({ conversations: [{ sessionId: "a" }] }),
  });
  assert.deepEqual(allowed.conversations, [{ sessionId: "a" }]);

  const removed = await readResource({
    resource: "conversations",
    operation: "delete",
    policy,
    agentId: "chief",
    retrieve: async () => ({ deleted: true }),
  });
  assert.equal(removed.isError, true);
  assert.equal(removed.error, "unknown read");
});
