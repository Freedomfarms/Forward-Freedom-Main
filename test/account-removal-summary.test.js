import test from "node:test";
import assert from "node:assert/strict";

import { connectionDeleteTarget } from "../src/utils/accountRemovalSummary.js";

test("connection delete uses a linked account when the institution still has one", () => {
  const linked = { id: "acct-1", plaidItemId: "item-1", name: "Discover It" };
  const target = connectionDeleteTarget(
    { itemId: "item-1", institutionName: "Discover", status: "requires_attention" },
    [linked, { id: "acct-2", plaidItemId: "item-2", name: "Checking" }]
  );

  assert.equal(target, linked);
});

test("connection delete still targets the institution when no accounts remain", () => {
  const target = connectionDeleteTarget(
    { itemId: "item-9", institutionName: "Discover", status: "requires_attention" },
    []
  );

  assert.deepEqual(target, {
    id: "item-9",
    plaidItemId: "item-9",
    name: "Discover",
    institution: "Discover",
  });
});

test("connection delete ignores an attention row without an item id", () => {
  assert.equal(connectionDeleteTarget({ institutionName: "Discover" }, []), null);
});
