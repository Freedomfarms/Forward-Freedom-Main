import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

process.env.FFF_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString("base64")}`;
process.env.FFF_ENCRYPTION_ACTIVE_VERSION = "1";

const { resetKeyProviderCache } = await import("../server/security/keyProvider.js");
resetKeyProviderCache();

const { encrypt } = await import("../server/security/envelope.js");
const { CREATION_STATE_SENTINEL } = await import("../server/agents/creationFlow.js");
const { decodeVisibleChatMessages } = await import("../server/agents/chatHistory.js");

test("decodeVisibleChatMessages hides creation-state rows and preserves order", () => {
  const rows = [
    {
      id: "3",
      role: "AGENT",
      contentCiphertext: encrypt("latest reply"),
      createdAt: new Date("2026-07-20T12:02:00Z"),
    },
    {
      id: "2",
      role: "AGENT",
      contentCiphertext: encrypt(`${CREATION_STATE_SENTINEL}{"v":1,"status":"active"}`),
      createdAt: new Date("2026-07-20T12:01:00Z"),
    },
    {
      id: "1",
      role: "USER",
      contentCiphertext: encrypt("hello"),
      createdAt: new Date("2026-07-20T12:00:00Z"),
    },
  ];

  assert.deepEqual(decodeVisibleChatMessages(rows, { limit: 50 }), [
    { id: "1", role: "user", text: "hello", createdAt: rows[2].createdAt },
    { id: "3", role: "agent", text: "latest reply", createdAt: rows[0].createdAt },
  ]);
});

test("decodeVisibleChatMessages respects the visible-message limit", () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    id: String(5 - index),
    role: index % 2 === 0 ? "AGENT" : "USER",
    contentCiphertext: encrypt(`m${5 - index}`),
    createdAt: new Date(Date.UTC(2026, 6, 20, 12, 5 - index)),
  }));

  const visible = decodeVisibleChatMessages(rows, { limit: 3 });
  assert.equal(visible.length, 3);
  assert.deepEqual(
    visible.map((row) => row.text),
    ["m3", "m4", "m5"]
  );
});
