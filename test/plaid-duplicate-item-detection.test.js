import test from "node:test";
import assert from "node:assert/strict";

import { detectDuplicatePlaidItem } from "../server/plaid/duplicateItemDetection.js";

test("duplicate detection matches existing Plaid account ids within the same institution", () => {
  const result = detectDuplicatePlaidItem({
    institutionId: "ins_1",
    incomingAccounts: [{ id: "acct-1", name: "Primary Checking", subtype: "checking" }],
    existingItems: [
      {
        itemId: "item-existing",
        institutionId: "ins_1",
        accounts: [{ plaidAccountId: "acct-1", name: "Primary Checking", plaidSubtype: "checking" }],
      },
    ],
  });

  assert.equal(result.isDuplicate, true);
  assert.equal(result.reason, "matching_account_id");
});

test("duplicate detection falls back to institution plus account name fingerprint", () => {
  const result = detectDuplicatePlaidItem({
    institutionId: "ins_1",
    incomingAccounts: [{ id: "acct-new", name: "Everyday Checking", subtype: "checking" }],
    existingItems: [
      {
        itemId: "item-existing",
        institutionId: "ins_1",
        accounts: [
          { plaidAccountId: "acct-old", name: "Everyday Checking", plaidSubtype: "checking" },
        ],
      },
    ],
  });

  assert.equal(result.isDuplicate, true);
  assert.equal(result.reason, "matching_institution_account_names");
});

test("duplicate detection ignores the currently repaired item", () => {
  const result = detectDuplicatePlaidItem({
    currentItemId: "item-existing",
    institutionId: "ins_1",
    incomingAccounts: [{ id: "acct-1", name: "Primary Checking", subtype: "checking" }],
    existingItems: [
      {
        itemId: "item-existing",
        institutionId: "ins_1",
        accounts: [{ plaidAccountId: "acct-1", name: "Primary Checking", plaidSubtype: "checking" }],
      },
    ],
  });

  assert.equal(result.isDuplicate, false);
});
