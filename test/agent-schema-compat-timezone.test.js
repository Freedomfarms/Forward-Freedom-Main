import test from "node:test";
import assert from "node:assert/strict";

import {
  isMissingAgentRunLineageColumnError,
  isMissingTimezoneColumnError,
} from "../server/agents/timezone.js";

test("isMissingTimezoneColumnError detects Prisma P2022 on timezone", () => {
  assert.equal(
    isMissingTimezoneColumnError({
      code: "P2022",
      message: "The column `timezone` does not exist in the current database.",
    }),
    true
  );
  assert.equal(
    isMissingTimezoneColumnError({
      code: "P2022",
      message: "The column `legalConsentAt` does not exist in the current database.",
    }),
    false
  );
});

test("isMissingAgentRunLineageColumnError detects lineage column gaps", () => {
  assert.equal(
    isMissingAgentRunLineageColumnError({
      code: "P2022",
      message: "The column `triggeredByConversationId` does not exist in the current database.",
    }),
    true
  );
  assert.equal(
    isMissingAgentRunLineageColumnError({
      code: "P2022",
      message: "The column `trigger` does not exist in the current database.",
    }),
    true
  );
  assert.equal(
    isMissingAgentRunLineageColumnError({
      code: "P2022",
      message: "The column `summary` does not exist in the current database.",
    }),
    false
  );
});
