// The CHIEF document needs the microphone for tap-to-talk. Camera,
// geolocation, and payment stay disabled. API responses are not the
// document, so they keep the microphone disabled.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const helpers = readFileSync(new URL("../server/http/responseHelpers.js", import.meta.url), "utf8");

function documentPolicy() {
  const block = vercel.headers.find(
    (entry) => entry.source === "/((?!api/).*)" && Array.isArray(entry.headers)
  );
  assert.ok(block, "document header block missing");
  const header = block.headers.find((item) => item.key === "Permissions-Policy");
  assert.ok(header, "document Permissions-Policy missing");
  return header.value;
}

test("the CHIEF document allows its own microphone and still denies the other sensors", () => {
  const policy = documentPolicy();
  assert.match(policy, /microphone=\(self\)/);
  assert.doesNotMatch(policy, /microphone=\(\)/);
  assert.match(policy, /camera=\(\)/);
  assert.match(policy, /geolocation=\(\)/);
  assert.match(policy, /payment=\(\)/);
});

test("API responses keep the microphone disabled", () => {
  assert.match(
    helpers,
    /Permissions-Policy", "camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)"/
  );
});
