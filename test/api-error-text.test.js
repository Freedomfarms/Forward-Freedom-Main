import test from "node:test";
import assert from "node:assert/strict";

import {
  apiFailureMessage,
  describeBodylessHttpError,
  readApiErrorText,
} from "../src/utils/apiErrorText.js";

test("a JSON 403 is the application sentence, and an empty 403 stays an edge block", () => {
  assert.equal(
    readApiErrorText({ error: true, message: "Legal consent is required." }),
    "Legal consent is required."
  );
  assert.equal(
    readApiErrorText({ error: "This account has been disabled." }),
    "This account has been disabled."
  );
  assert.equal(readApiErrorText({ error: true }), "");
  assert.equal(readApiErrorText({}), "");

  assert.equal(
    apiFailureMessage(403, { error: "This account has been disabled." }),
    "This account has been disabled."
  );
  assert.equal(
    apiFailureMessage(403, { message: "Legal consent is required before continuing." }),
    "Legal consent is required before continuing."
  );
  assert.equal(apiFailureMessage(403, { error: true }), describeBodylessHttpError(403));
  assert.match(apiFailureMessage(403, {}), /HTTP 403/);
  assert.match(apiFailureMessage(403, {}), /Vercel Firewall/);
  assert.equal(
    apiFailureMessage(500, { error: "Freedom Financial access could not be saved." }),
    "Freedom Financial access could not be saved."
  );
  assert.match(apiFailureMessage(500, {}), /Server error \(500\)/);
});
