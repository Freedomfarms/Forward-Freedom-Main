import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canAutoSpeak,
  followManagedTurn,
  followWaitMs,
  isRetryableFollowError,
} from "../src/utils/chiefFollow.js";

test("a long continuation is followed until it settles and is spoken once", async () => {
  let streams = 0;
  let waits = 0;
  let spoken = 0;
  const result = await followManagedTurn({
    sessionId: "session-1",
    isCurrent: () => true,
    wait: async () => {
      waits += 1;
      return false;
    },
    onUpdate: (turn) => {
      assert.equal(turn.turnStatus, "continuing");
      assert.equal(spoken, 0);
    },
    stream: async ({ resume }) => {
      streams += 1;
      if (streams === 1) assert.equal(resume, false);
      else assert.equal(resume, true);
      if (streams < 80) {
        return {
          sessionId: "session-1",
          turnStatus: "continuing",
          streamText: "",
          finished: false,
        };
      }
      return {
        sessionId: "session-1",
        turnStatus: "completed",
        streamText: "The feeder plan is ready.",
        finished: true,
        status: "Ready",
      };
    },
    readHistory: async () => ({ turnStatus: "continuing", messages: [] }),
  });
  assert.equal(result.reason, "settled");
  assert.ok(waits > 75);
  assert.equal(result.turn.finished, true);
  if (
    canAutoSpeak({
      epoch: 1,
      currentEpoch: 1,
      speak: true,
      sessionId: result.turn.sessionId,
      activeSessionId: "session-1",
    })
  ) {
    spoken += 1;
  }
  assert.equal(spoken, 1);
  assert.equal(
    canAutoSpeak({
      epoch: 1,
      currentEpoch: 2,
      speak: false,
      sessionId: "session-1",
      activeSessionId: "other",
    }),
    false
  );
});

test("a dropped connection retries the same session and still settles once", async () => {
  let streams = 0;
  const result = await followManagedTurn({
    sessionId: "session-1",
    isCurrent: () => true,
    wait: async () => false,
    stream: async ({ resume, sessionId }) => {
      streams += 1;
      assert.equal(sessionId, "session-1");
      if (streams < 3) {
        const error = new Error("network down");
        throw error;
      }
      assert.equal(resume, true);
      return {
        sessionId,
        turnStatus: "completed",
        streamText: "Ready.",
        finished: true,
      };
    },
    readHistory: async () => ({ turnStatus: "continuing", messages: [] }),
  });
  assert.equal(streams, 3);
  assert.equal(result.reason, "settled");
  assert.equal(result.turn.streamText, "Ready.");
});

test("stopping or switching cancels the follow before speech", async () => {
  let current = true;
  const result = await followManagedTurn({
    sessionId: "session-1",
    isCurrent: () => current,
    wait: async () => {
      current = false;
      return true;
    },
    stream: async () => ({
      sessionId: "session-1",
      turnStatus: "continuing",
      streamText: "",
      finished: false,
    }),
    readHistory: async () => ({ turnStatus: "continuing", messages: [] }),
  });
  assert.equal(result.reason, "cancelled");
  assert.equal(
    canAutoSpeak({
      aborted: true,
      epoch: 1,
      currentEpoch: 1,
      speak: false,
      sessionId: "session-1",
      activeSessionId: "session-1",
    }),
    false
  );
});

test("a terminal request is not retried as a dropped connection", async () => {
  const denied = Object.assign(new Error("archived"), { status: 409 });
  const result = await followManagedTurn({
    sessionId: "session-1",
    isCurrent: () => true,
    wait: async () => false,
    stream: async () => {
      throw denied;
    },
    readHistory: async () => ({ turnStatus: "continuing", messages: [] }),
  });
  assert.equal(result.reason, "error");
  assert.equal(isRetryableFollowError(denied), false);
  assert.equal(isRetryableFollowError(Object.assign(new Error("busy"), { status: 503 })), true);
  assert.equal(followWaitMs(100), 4000);
  assert.equal(followWaitMs(2500), 300);
});

test("the open page does not give up on a long reply", () => {
  const page = readFileSync(
    new URL("../src/components/chief/ChiefPage.jsx", import.meta.url),
    "utf8"
  );
  assert.equal(page.includes("CONTINUATION_POLL_LIMIT"), false);
  assert.equal(page.includes("Use Play response when it appears."), false);
  assert.match(page, /followManagedTurn/);
  assert.match(page, /canAutoSpeak/);
});
