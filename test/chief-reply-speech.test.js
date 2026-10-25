// A finished home reply must reach voice.speakAnswer() once when the response
// mode speaks. Typed and microphone input share that decision. The transcript
// still renders on its own. This does not boot the room.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CHIEF_STATUS, MISSING_CHIEF_ANSWER } from "../src/utils/chiefProtocol.js";
import {
  normalizeChiefPreferences,
  shouldShowAssistantText,
} from "../src/utils/chiefPreferences.js";
import {
  classifySettledDelivery,
  PLAYBACK_BLOCKED_MESSAGE,
  replySpeechText,
  speakCompletedReply,
} from "../src/utils/chiefReplySpeech.js";

const root = process.cwd();

function voiceDouble() {
  const calls = [];
  return {
    calls,
    speakAnswer(text) {
      calls.push(text);
      return { ok: true };
    },
  };
}

function modePreferences(responseMode, extra = {}) {
  return normalizeChiefPreferences({
    conversation: { responseMode, ...extra },
  });
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

test("a completed CHIEF response invokes voice.speakAnswer() once", async () => {
  const voice = voiceDouble();
  const delivery = speakCompletedReply(voice, finished);
  assert.equal(delivery.spoken, "Everything is operational.");
  await delivery.pending;
  assert.deepEqual(voice.calls, ["Everything is operational."]);

  const page = readFileSync(path.join(root, "src/components/chief/ChiefPage.jsx"), "utf8");
  const helper = readFileSync(path.join(root, "src/utils/chiefReplySpeech.js"), "utf8");
  assert.match(page, /speakCompletedReply\(voice,/);
  assert.equal((page.match(/speakCompletedReply\(/g) || []).length, 1);
  assert.equal((page.match(/streamChiefChat\(/g) || []).length, 1);
  assert.equal((helper.match(/voice\.speakAnswer\(spoken\)/g) || []).length, 1);
  assert.doesNotMatch(page, /ChiefVoiceDock/);
  assert.doesNotMatch(page, /\/api\/chief\/speak/);
  assert.equal(page.includes('from "./voice/useChiefVoice.js"'), false);
});

test("empty, failed, and muted replies do not speak", () => {
  const voice = voiceDouble();
  assert.equal(speakCompletedReply(voice, { ...finished, streamText: "   " }), null);
  assert.equal(
    speakCompletedReply(voice, { ...finished, streamText: "", historyAnswer: "   " }),
    null
  );
  assert.equal(speakCompletedReply(voice, { ...finished, finished: false }), null);
  assert.equal(speakCompletedReply(voice, { ...finished, aborted: true }), null);
  assert.equal(
    speakCompletedReply(voice, {
      ...finished,
      status: CHIEF_STATUS.ERROR,
      error: "CHIEF could not complete that request.",
    }),
    null
  );
  assert.equal(speakCompletedReply(voice, { ...finished, error: "stopped" }), null);
  assert.equal(speakCompletedReply(voice, { ...finished, turnStatus: "continuing" }), null);
  assert.equal(speakCompletedReply(voice, { ...finished, turnStatus: "aborted" }), null);
  assert.equal(speakCompletedReply(voice, { ...finished, turnStatus: "suspended" }), null);
  assert.equal(
    speakCompletedReply(voice, {
      ...finished,
      preferences: modePreferences("text"),
    }),
    null
  );
  assert.deepEqual(voice.calls, []);
});

test("a stored answer is spoken once when the stream text is empty", async () => {
  const voice = voiceDouble();
  const delivery = speakCompletedReply(voice, {
    ...finished,
    streamText: "",
    historyAnswer: "Everything is operational.",
  });
  assert.equal(delivery.spoken, "Everything is operational.");
  await delivery.pending;
  assert.deepEqual(voice.calls, ["Everything is operational."]);
});

test("typed and spoken input follow the same response mode", () => {
  const answer = "Everything is operational.";
  for (const source of ["text", "voice"]) {
    assert.equal(
      replySpeechText({ ...finished, source, preferences: modePreferences("text") }),
      "",
      source
    );
    assert.equal(
      replySpeechText({ ...finished, source, preferences: modePreferences("voice") }),
      answer,
      source
    );
    assert.equal(
      replySpeechText({ ...finished, source, preferences: modePreferences("both") }),
      answer,
      source
    );
    assert.equal(
      replySpeechText({
        ...finished,
        source,
        preferences: modePreferences("both", { voiceResponses: false }),
      }),
      answer,
      source
    );
    assert.equal(
      replySpeechText({
        ...finished,
        source,
        preferences: modePreferences("voice", { voiceResponses: false }),
      }),
      answer,
      source
    );
    assert.equal(
      replySpeechText({
        ...finished,
        source,
        preferences: modePreferences("text", { voiceResponses: false }),
      }),
      "",
      source
    );
  }

  const mutedVoice = modePreferences("voice", { voiceResponses: false });
  assert.equal(mutedVoice.conversation.responseMode, "voice");
  assert.equal(mutedVoice.conversation.voiceResponses, true);
  assert.equal(shouldShowAssistantText({ preferences: mutedVoice }), false);
  assert.equal(shouldShowAssistantText({ preferences: modePreferences("voice") }), false);
  assert.equal(
    shouldShowAssistantText({ preferences: modePreferences("voice"), reveal: true }),
    true
  );
  assert.equal(shouldShowAssistantText({ preferences: modePreferences("text") }), true);
  assert.equal(shouldShowAssistantText({ preferences: modePreferences("both") }), true);
});

test("the home path stops speech without starting the microphone", () => {
  const page = readFileSync(path.join(root, "src/components/chief/ChiefPage.jsx"), "utf8");
  const face = readFileSync(path.join(root, "src/components/chief/ChiefInterface.jsx"), "utf8");
  const mode = readFileSync(path.join(root, "src/components/chief/ChiefResponseMode.jsx"), "utf8");
  const settings = readFileSync(path.join(root, "src/components/chief/ChiefSettings.jsx"), "utf8");
  const voice = readFileSync(path.join(root, "src/components/chief/useChiefVoice.js"), "utf8");
  const stop = page.slice(
    page.indexOf("function stopSpeech"),
    page.indexOf("function applyVoiceSettings")
  );
  assert.match(stop, /voice\.stopSpeaking\(\)/);
  assert.doesNotMatch(stop, /toggleListening|stopActiveTurn|abortRef/);
  assert.match(page, /onStopSpeech=\{stopSpeech\}/);
  assert.match(page, /rememberRevealedAnswer/);
  assert.match(page, /speechEpoch\.current \+= 1/);
  assert.match(page, /if \(speechEpoch\.current !== epoch\) return/);
  assert.match(face, /<ChiefResponseMode/);
  assert.match(mode, /Response mode/);
  assert.match(mode, /Text \+ Voice/);
  assert.match(face, /chief-stop-speech/);
  assert.match(face, /onClick=\{\(\) => onStopSpeech\?\.\(\)\}/);
  assert.match(face, /onStopSpeech/);
  assert.match(settings, /<ChiefResponseMode/);
  assert.match(settings, /Voice responses/);
  assert.doesNotMatch(settings, /Automatically speak CHIEF responses/);
  assert.doesNotMatch(settings, /Show CHIEF response text/);
  assert.match(voice, /speakGenerationRef/);
  assert.match(voice, /reason: "aborted"/);
  assert.match(voice, /setPlayback\("preparing"\)/);
  assert.match(voice, /fetchChiefSpeech/);
  assert.match(page, /stopSpeaking\(\{ preserveHold: true \}\)/);
  assert.doesNotMatch(page, /finished without text to speak/);
  assert.match(page, /classifySettledDelivery/);
});

test("missing text, speech failure, and blocked playback stay distinct", () => {
  const answer = "Yes. The site shell is in src/App.jsx.";
  assert.deepEqual(classifySettledDelivery({ answer: "", settled: true, speak: true }), {
    action: "missing_answer",
    message: MISSING_CHIEF_ANSWER,
  });
  assert.equal(classifySettledDelivery({ answer, settled: false, speak: true }).action, "pending");
  assert.equal(classifySettledDelivery({ answer, settled: true, speak: false }).action, "show");
  assert.equal(classifySettledDelivery({ answer, settled: true, speak: true }).action, "speak");
  assert.equal(
    classifySettledDelivery({
      answer,
      settled: true,
      speak: true,
      playback: { ok: true },
    }).action,
    "spoken"
  );
  const blocked = classifySettledDelivery({
    answer,
    settled: true,
    speak: true,
    playback: { ok: false, code: "playback_blocked", error: PLAYBACK_BLOCKED_MESSAGE },
  });
  assert.equal(blocked.action, "blocked");
  assert.equal(blocked.message, PLAYBACK_BLOCKED_MESSAGE);
  assert.equal(blocked.text, answer);
  const failed = classifySettledDelivery({
    answer,
    settled: true,
    speak: true,
    playback: { ok: false, reason: "error", error: "ElevenLabs speech failed (502)." },
  });
  assert.equal(failed.action, "tts_failed");
  assert.equal(failed.message, "ElevenLabs speech failed (502).");
  assert.notEqual(failed.message, MISSING_CHIEF_ANSWER);
  assert.notEqual(blocked.message, failed.message);
});
