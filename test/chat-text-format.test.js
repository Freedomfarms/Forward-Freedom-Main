import test from "node:test";
import assert from "node:assert/strict";

import { parseChatEmphasis } from "../src/utils/chatTextFormat.js";

test("parseChatEmphasis turns ** into bold and __ into underline segments", () => {
  assert.deepEqual(
    parseChatEmphasis(
      "Got it — switching to a **federal reserve report**. __Who should receive this?__"
    ),
    [
      { type: "text", value: "Got it — switching to a " },
      { type: "bold", value: "federal reserve report" },
      { type: "text", value: ". " },
      { type: "underline", value: "Who should receive this?" },
    ]
  );
  assert.deepEqual(parseChatEmphasis("No emphasis here"), [
    { type: "text", value: "No emphasis here" },
  ]);
  assert.deepEqual(parseChatEmphasis(""), [{ type: "text", value: "" }]);
});
