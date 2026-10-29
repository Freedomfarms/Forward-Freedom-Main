import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { frontierActivity } from "../src/components/chief/frontier/frontierActivity.js";
import { createSpeechQueue } from "../src/components/chief/voice/speechQueue.js";
import {
  CHIEF_PERSONALITY_PRESET_KEY,
  readPersonalityPreset,
  writePersonalityPreset,
} from "../src/utils/chiefPersonality.js";
import {
  appendVisibleDelta,
  applyChiefEvent,
  CHIEF_STATUS,
  initialTurnState,
} from "../src/utils/chiefProtocol.js";
import {
  ACK_AFTER_MS,
  CUE_COOLDOWN_MS,
  createLiveDelivery,
  nextConversationCue,
  observeLiveTurn,
  PROGRESS_AFTER_MS,
  speechSourceForTail,
  takeSpeakableSegments,
} from "../src/utils/chiefLiveConversation.js";

const root = process.cwd();

function delta(state, text, extra = {}) {
  return applyChiefEvent(state, {
    msg: {
      type: "assistant_content_delta",
      phase: "final_answer",
      turn_id: "turn-1",
      delta: text,
      ...extra,
    },
  });
}

test("visible answer text merges snapshots without duplicating a reconnect", () => {
  assert.equal(appendVisibleDelta("", "Hello"), "Hello");
  assert.equal(appendVisibleDelta("Hello", ""), "Hello");
  assert.equal(appendVisibleDelta("Hello", "Hello"), "Hello");
  assert.equal(appendVisibleDelta("Hello", "Hello world"), "Hello world");
  assert.equal(appendVisibleDelta("Hello", " world"), "Hello world");
  assert.equal(appendVisibleDelta("Hello world", "world"), "Hello world");
  assert.equal(appendVisibleDelta("Hello world", "Hello"), "Hello world");
  assert.equal(appendVisibleDelta("Hi", "Higher"), "HiHigher");
  const overlap = "The accounts look steady";
  assert.equal(
    appendVisibleDelta(`${overlap} and ready`, `${overlap} and ready for review today.`),
    `${overlap} and ready for review today.`
  );

  let state = applyChiefEvent(initialTurnState("sess-1"), {
    msg: { type: "turn_started", turn_id: "turn-1" },
  });
  state = delta(state, "Hello");
  state = delta(state, "Hello");
  assert.equal(state.streamText, "Hello");
  assert.equal(state.finished, false);
  state = delta(state, "Hello world");
  assert.equal(state.streamText, "Hello world");
  state = applyChiefEvent(state, {
    msg: {
      type: "assistant_content_delta",
      phase: "reasoning",
      turn_id: "turn-1",
      delta: "private",
    },
  });
  assert.equal(state.streamText, "Hello world");
  state = applyChiefEvent(state, {
    msg: { type: "tool_call_begin", turn_id: "turn-1", name: "web_search" },
  });
  state = delta(state, " today.");
  assert.equal(state.streamText, "Hello world today.");
  assert.equal(state.status, CHIEF_STATUS.RESPONDING);
  assert.equal(state.finished, false);
  assert.equal(JSON.stringify(state).includes("private"), false);
});

test("speech waits for a stable sentence and withholds unverified conclusions", () => {
  assert.deepEqual(takeSpeakableSegments("Hello there", 0, {}), {
    cursor: 0,
    segments: [],
  });
  const first = takeSpeakableSegments("The accounts look steady. More is coming soon.", 0, {});
  assert.deepEqual(first.segments, ["The accounts look steady.", "More is coming soon."]);
  const second = takeSpeakableSegments(
    "The accounts look steady. More is coming soon.",
    first.cursor,
    {}
  );
  assert.deepEqual(second.segments, []);
  assert.deepEqual(takeSpeakableSegments("Dr. Smith is ready now.", 0, {}).segments, [
    "Dr. Smith is ready now.",
  ]);
  assert.deepEqual(takeSpeakableSegments("Yes.", 0, {}).segments, []);
  assert.deepEqual(takeSpeakableSegments("Yes.", 0, { settled: true }).segments, ["Yes."]);

  const held = takeSpeakableSegments("The total is $12. I can explain the rest now.", 0, {
    anyToolUsed: true,
  });
  assert.deepEqual(held, { cursor: 0, segments: [] });
  const released = takeSpeakableSegments("The total is $12. I can explain the rest now.", 0, {
    anyToolUsed: true,
    settled: true,
  });
  assert.equal(released.segments[0].includes("$12"), true);

  const open = takeSpeakableSegments("The accounts look steady.", 0, { toolsOpen: true });
  assert.deepEqual(open.segments, []);
  assert.equal(open.cursor, 0);
  const duringTool = createLiveDelivery();
  duringTool.start(0);
  duringTool.observe({ status: CHIEF_STATUS.TOOL, streamText: "" });
  duringTool.observe({ status: CHIEF_STATUS.RESPONDING, streamText: "The accounts look steady." });
  assert.deepEqual(duringTool.segments("The accounts look steady.", { settled: false }), []);
  duringTool.observe({ status: CHIEF_STATUS.WORKING, streamText: "The accounts look steady." });
  assert.deepEqual(duringTool.segments("The accounts look steady.", { settled: false }), [
    "The accounts look steady.",
  ]);

  const narrative = takeSpeakableSegments("I checked the files and the names match.", 0, {
    anyToolUsed: true,
    toolsOpen: false,
  });
  assert.deepEqual(narrative.segments, ["I checked the files and the names match."]);
  assert.deepEqual(
    takeSpeakableSegments("The total is $12 today.", 0, { anyToolUsed: false }).segments,
    ["The total is $12 today."]
  );
  const fenced = takeSpeakableSegments("Here is the change.\n\n```\nconst x = 1", 0, {});
  assert.deepEqual(fenced.segments, ["Here is the change."]);
  assert.equal(
    takeSpeakableSegments("Here is the change.\n\n```\nconst x = 1", fenced.cursor, {}).segments
      .length,
    0
  );
});

test("acknowledgements wait five seconds and progress follows a real tool change", () => {
  assert.equal(ACK_AFTER_MS, 5000);
  assert.equal(PROGRESS_AFTER_MS, 15000);
  assert.equal(CUE_COOLDOWN_MS, 12000);
  const started = initialCueState();
  assert.equal(cueAt(started, 4999).cue, null);
  const slow = cueAt(started, 5000);
  assert.deepEqual(slow.cue, { text: "On it.", speak: true });
  assert.equal(cueAt(slow.state, 10000).cue, null);
  assert.equal(cueAt(slow.state, 20000).cue, null);
  assert.equal(cueAt(started, 5000, { visibleChars: 12 }).cue, null);
  assert.equal(cueAt(started, 8000, { speaking: true }).cue, null);
  assert.equal(cueAt(started, 8000, { finished: true }).cue, null);
  assert.equal(
    cueAt(started, 5000, { preset: "professional", speak: false }).cue.text,
    "I'm on that."
  );
  assert.equal(cueAt(started, 5000, { preset: "friendly" }).cue.text, "One moment.");
  assert.equal(cueAt(started, 5000, { preset: "coach" }).cue.text, "On it.");

  let state = observeLiveTurn(started, { status: CHIEF_STATUS.WEB_SEARCH, streamText: "" });
  const checking = cueAt(state, 5000);
  assert.equal(checking.cue.text, "I'm checking that now.");
  assert.equal(checking.cue.speak, true);
  state = observeLiveTurn(checking.state, { status: CHIEF_STATUS.WORKING, streamText: "" });
  assert.equal(cueAt(state, 16000).cue, null);
  const progress = cueAt(state, 17000);
  assert.equal(progress.cue.text, "I've got a result. I'm reading it.");
  assert.equal(cueAt(progress.state, 30000).cue, null);
  assert.equal(/code review is complete|identified the issue/i.test(progress.cue.text), false);

  const finance = observeLiveTurn(initialCueState(), {
    status: CHIEF_STATUS.FINANCE,
    streamText: "",
  });
  assert.equal(cueAt(finance, 5000).cue.text, "I'm checking your financial data.");
  const approval = observeLiveTurn(finance, { status: CHIEF_STATUS.APPROVAL });
  assert.equal(cueAt(approval, 20000, { status: CHIEF_STATUS.APPROVAL }).cue, null);

  const delivery = createLiveDelivery();
  delivery.start(0);
  assert.equal(delivery.cue({ now: 1000, preset: "jarvis", speak: true, visibleChars: 0 }), null);
  delivery.observe({ status: CHIEF_STATUS.RESPONDING, streamText: "The accounts look steady." });
  assert.deepEqual(delivery.segments("The accounts look steady.", { settled: false }), [
    "The accounts look steady.",
  ]);
  assert.equal(delivery.cue({ now: 20000, preset: "jarvis", speak: true, visibleChars: 0 }), null);
  delivery.stop();
  assert.equal(delivery.cue({ now: 30000, preset: "jarvis", speak: true }), null);
});

test("the speech queue stays ordered and drops stale audio on cancel", async () => {
  const queue = createSpeechQueue();
  const order = [];
  const speak = (text) =>
    queue.enqueue(text, async (value) => {
      order.push(`start:${value}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${value}`);
      return { ok: true };
    });
  const played = await Promise.all([speak("a"), speak("b"), speak("c")]);
  assert.deepEqual(
    played.map((item) => item.ok),
    [true, true, true]
  );
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);

  const cancelled = createSpeechQueue();
  const heard = [];
  let release;
  const active = cancelled.enqueue("first", () => {
    heard.push("first");
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const queued = cancelled.enqueue("second", async () => {
    heard.push("second");
    return { ok: true };
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  cancelled.cancel();
  release({ ok: true });
  assert.equal((await active).reason, "aborted");
  assert.equal((await queued).reason, "aborted");
  assert.deepEqual(heard, ["first"]);

  const fresh = createSpeechQueue();
  const stale = fresh.enqueue("old", async () => ({ ok: true }));
  fresh.cancel();
  const next = fresh.enqueue("fresh", async (text) => {
    heard.push(text);
    return { ok: true };
  });
  assert.equal((await stale).reason, "aborted");
  assert.equal((await next).ok, true);
  assert.equal(heard.includes("fresh"), true);
  assert.equal(heard.includes("old"), false);

  const failing = createSpeechQueue();
  const calls = [];
  const first = failing.enqueue("bad", async () => ({ ok: false, reason: "error", error: "nope" }));
  const rest = failing.enqueue("later", async () => {
    calls.push("later");
    return { ok: true };
  });
  assert.equal((await first).reason, "error");
  assert.equal((await rest).reason, "error");
  assert.deepEqual(calls, []);
  assert.equal((await failing.enqueue("after", async () => ({ ok: true }))).reason, "error");
  failing.cancel();
  assert.equal((await failing.enqueue("again", async () => ({ ok: true }))).ok, true);
});

test("an acknowledgement speaks without settling the turn", () => {
  assert.equal(
    frontierActivity({ status: "On it.", turnStatus: "running", playback: "playing" }),
    "responding"
  );
  assert.equal(
    frontierActivity({ status: "On it.", turnStatus: "running", playback: "preparing" }),
    "responding"
  );
  assert.equal(
    frontierActivity({ status: "On it.", turnStatus: "running", playback: "idle" }),
    "thinking"
  );
  assert.equal(frontierActivity({ status: "On it.", playback: "idle" }), "idle");
  assert.equal(
    speechSourceForTail("Hello there friend.", "Hello there friend. And more."),
    "Hello there friend. And more."
  );
  assert.equal(
    speechSourceForTail("Hello there friend.", "Different answer."),
    "Hello there friend."
  );

  const storage = new Map();
  const bin = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  assert.equal(readPersonalityPreset(bin), "jarvis");
  writePersonalityPreset("professional", bin);
  assert.equal(storage.get(CHIEF_PERSONALITY_PRESET_KEY), "professional");
  assert.equal(readPersonalityPreset(bin), "professional");
  writePersonalityPreset("nope", bin);
  assert.equal(readPersonalityPreset(bin), "professional");
  assert.equal(
    readPersonalityPreset({
      getItem: () => {
        throw new Error("blocked");
      },
    }),
    "jarvis"
  );

  const page = readFileSync(path.join(root, "src/components/chief/ChiefPage.jsx"), "utf8");
  assert.match(page, /createLiveDelivery\(/);
  assert.match(page, /voice\.enqueueSpeech\(/);
  assert.match(page, /appendVisibleDelta\(/);
  assert.equal((page.match(/speakCompletedReply\(/g) || []).length, 1);
  assert.doesNotMatch(page, /setStreamText\(cue/);
  assert.match(page, /speakOnSettleRef\.current = false/);
  const voice = readFileSync(path.join(root, "src/components/chief/useChiefVoice.js"), "utf8");
  assert.match(voice, /enqueueSpeech/);
  assert.match(voice, /createSpeechQueue\(/);
  assert.match(voice, /fetchChiefSpeech/);
  assert.match(voice, /speakBrowserText/);
});

function initialCueState() {
  return {
    startedAt: 0,
    stopped: false,
    cursor: 0,
    toolsOpen: false,
    anyToolUsed: false,
    lastCueAt: 0,
    lastCueText: "",
    lastProgressKey: "",
    toolStatus: "",
    phase: "",
    answerSpeaking: false,
  };
}

function cueAt(state, now, extra = {}) {
  return nextConversationCue(state, {
    now,
    preset: "jarvis",
    speak: true,
    visibleChars: 0,
    ...extra,
  });
}
