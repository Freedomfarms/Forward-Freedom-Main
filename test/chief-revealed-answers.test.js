// A voice-only answer that could not finish speaking stays visible after the
// conversation is closed and opened again. The reply itself stays in history.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  isRevealedAnswer,
  readRevealedAnswers,
  rememberRevealedAnswer,
  revealedAnswerKey,
} from "../src/utils/chiefRevealedAnswers.js";

const root = process.cwd();

function memoryStorage() {
  const bin = new Map();
  return {
    getItem(key) {
      return bin.has(key) ? bin.get(key) : null;
    },
    setItem(key, value) {
      bin.set(key, String(value));
    },
    dump() {
      return [...bin.values()].join("\n");
    },
  };
}

test("a failed or stopped voice answer stays readable after reload", () => {
  const storage = memoryStorage();
  const answer = "The pumps are holding pressure.";
  const first = rememberRevealedAnswer("user-1", "session-a", answer, storage);
  assert.equal(isRevealedAnswer(first, answer), true);
  assert.equal(isRevealedAnswer(first, `  ${answer}\n`), true);
  assert.equal(rememberRevealedAnswer("user-1", "session-a", answer, storage).length, 1);

  const reopened = readRevealedAnswers("user-1", "session-a", storage);
  assert.equal(isRevealedAnswer(reopened, answer), true);
  assert.equal(
    isRevealedAnswer(readRevealedAnswers("user-1", "session-b", storage), answer),
    false
  );
  assert.equal(
    isRevealedAnswer(readRevealedAnswers("user-2", "session-a", storage), answer),
    false
  );
  assert.equal(storage.dump().includes(answer), false);
  assert.equal(storage.dump().includes("responseMode"), false);
  assert.equal(revealedAnswerKey(""), "");
  assert.equal(rememberRevealedAnswer("user-1", "", answer, storage), null);
});

test("the home screen reloads revealed answers instead of clearing them", () => {
  const page = readFileSync(path.join(root, "src/components/chief/ChiefPage.jsx"), "utf8");
  const transcript = readFileSync(
    path.join(root, "src/components/chief/ChiefTranscript.jsx"),
    "utf8"
  );
  const select = page.slice(
    page.indexOf("function selectSession"),
    page.indexOf("function startNewConversation")
  );
  const stop = page.slice(
    page.indexOf("function stopSpeech"),
    page.indexOf("function applyVoiceSettings")
  );
  assert.match(page, /rememberRevealedAnswer/);
  assert.match(page, /readRevealedAnswers\(sessionUid, activeSessionId\)/);
  assert.match(page, /revealStoredAnswer\(played\.text, sessionIdNow\)/);
  assert.match(select, /readRevealedAnswers\(sessionUid, sessionId\)/);
  assert.doesNotMatch(select, /setRevealedAnswers\(\[\]\)/);
  assert.match(stop, /revealStoredAnswer\(answer\)/);
  assert.doesNotMatch(stop, /responseMode/);
  assert.match(transcript, /isRevealedAnswer\(revealedKeys, message\.text\)/);
  assert.match(transcript, /chief-sr/);
});
