// A finished home reply must reach voice.speakAnswer(). The transcript still
// renders on its own. This does not boot the room.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CHIEF_STATUS } from "../src/utils/chiefProtocol.js";
import { normalizeChiefPreferences } from "../src/utils/chiefPreferences.js";
import { speakCompletedReply } from "../src/utils/chiefReplySpeech.js";

const root = process.cwd();

function voiceDouble() {
  const calls = [];
  return {
    calls,
    speakAnswer(text) {
      calls.push(text);
    },
  };
}

const finished = {
  streamText: "Everything is operational.",
  historyAnswer: "",
  finished: true,
  status: CHIEF_STATUS.READY,
  error: "",
  aborted: false,
  source: "text",
  preferences: normalizeChiefPreferences(null),
};

test("a completed CHIEF response invokes voice.speakAnswer() once", () => {
  const voice = voiceDouble();
  const spoken = speakCompletedReply(voice, finished);
  assert.equal(spoken, "Everything is operational.");
  assert.deepEqual(voice.calls, ["Everything is operational."]);

  const page = readFileSync(path.join(root, "src/components/chief/ChiefPage.jsx"), "utf8");
  const helper = readFileSync(path.join(root, "src/utils/chiefReplySpeech.js"), "utf8");
  assert.match(page, /speakCompletedReply\(voice,/);
  assert.equal((page.match(/speakCompletedReply\(/g) || []).length, 1);
  assert.equal((helper.match(/voice\.speakAnswer\(spoken\)/g) || []).length, 1);
  assert.doesNotMatch(page, /ChiefVoiceDock/);
});

test("empty, failed, and muted replies do not speak", () => {
  const voice = voiceDouble();
  assert.equal(speakCompletedReply(voice, { ...finished, streamText: "   " }), "");
  assert.equal(
    speakCompletedReply(voice, { ...finished, streamText: "", historyAnswer: "   " }),
    ""
  );
  assert.equal(speakCompletedReply(voice, { ...finished, finished: false }), "");
  assert.equal(speakCompletedReply(voice, { ...finished, aborted: true }), "");
  assert.equal(
    speakCompletedReply(voice, {
      ...finished,
      status: CHIEF_STATUS.ERROR,
      error: "CHIEF could not complete that request.",
    }),
    ""
  );
  assert.equal(speakCompletedReply(voice, { ...finished, error: "stopped" }), "");
  assert.equal(
    speakCompletedReply(voice, {
      ...finished,
      preferences: normalizeChiefPreferences({ conversation: { voiceResponses: false } }),
    }),
    ""
  );
  assert.equal(
    speakCompletedReply(voice, {
      ...finished,
      preferences: normalizeChiefPreferences({
        conversation: { autoSpeak: false, speechChoice: true },
      }),
    }),
    ""
  );
  assert.deepEqual(voice.calls, []);
});

test("a stored answer is spoken once when the stream text is empty", () => {
  const voice = voiceDouble();
  const spoken = speakCompletedReply(voice, {
    ...finished,
    streamText: "",
    historyAnswer: "Everything is operational.",
  });
  assert.equal(spoken, "Everything is operational.");
  assert.deepEqual(voice.calls, ["Everything is operational."]);
});

test("microphone replies still speak when typed auto-speak is off", () => {
  const voice = voiceDouble();
  const spoken = speakCompletedReply(voice, {
    ...finished,
    source: "voice",
    preferences: normalizeChiefPreferences({
      conversation: { autoSpeak: false, speechChoice: true },
    }),
  });
  assert.equal(spoken, "Everything is operational.");
  assert.deepEqual(voice.calls, ["Everything is operational."]);
});
