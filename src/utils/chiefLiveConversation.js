// Live CHIEF delivery. One turn, one cursor, one cue decision.
// This does not start an agent, a timer, or a second model. The page owns
// the clock and the voice queue. Nothing here is written into the answer.

import { CHIEF_STATUS } from "./chiefProtocol.js";

export const ACK_AFTER_MS = 5000;
export const PROGRESS_AFTER_MS = 15000;
export const CUE_COOLDOWN_MS = 12000;

const TOOL_STATUS = new Set([
  CHIEF_STATUS.TOOL,
  CHIEF_STATUS.FINANCE,
  CHIEF_STATUS.WEB_SEARCH,
  CHIEF_STATUS.MODULE_ACCESS,
  CHIEF_STATUS.MODULE_ACCESS_SET,
]);

const PRESET_ACK = Object.freeze({
  jarvis: "On it.",
  coach: "On it.",
  professional: "I'm on that.",
  friendly: "One moment.",
});

const TOOL_ACK = Object.freeze({
  [CHIEF_STATUS.WEB_SEARCH]: "I'm checking that now.",
  [CHIEF_STATUS.FINANCE]: "I'm checking your financial data.",
  [CHIEF_STATUS.MODULE_ACCESS]: "I'm checking Freedom Financial access.",
  [CHIEF_STATUS.MODULE_ACCESS_SET]: "I'm checking Freedom Financial access.",
  [CHIEF_STATUS.TOOL]: "I'm checking that now.",
});

const ABBREVIATION = /(?:^|[\s(["'])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|U\.S|U\.K)$/i;

const UNVERIFIED =
  /\$\s?\d|\b(?:dollars?|usd)\b|\b(?:the answer|the result|the total|the balance|the fix)\b|\btherefore\b|```/i;

export function isLiveToolStatus(status) {
  return TOOL_STATUS.has(status);
}

function wordCount(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function isAbbreviation(text, dotIndex) {
  return ABBREVIATION.test(text.slice(0, dotIndex));
}

function looksUnverified(segment) {
  return UNVERIFIED.test(segment);
}

function skipSpace(text, index) {
  let next = index;
  while (next < text.length && /\s/.test(text[next])) next += 1;
  return next;
}

function boundaryFrom(text, from, settled) {
  let index = from;
  while (index < text.length) {
    if (text.startsWith("```", index)) {
      const close = text.indexOf("```", index + 3);
      if (close === -1) return settled ? text.length : -1;
      index = close + 3;
      continue;
    }
    if (text.startsWith("\n\n", index)) return index;
    const ch = text[index];
    if ((ch === "." || ch === "!" || ch === "?") && !(ch === "." && isAbbreviation(text, index))) {
      const next = text[index + 1];
      if (next === undefined) {
        if (ch === "." && /\d/.test(text[index - 1] || "") && !settled) return -1;
        return index + 1;
      }
      if (/\s/.test(next)) return index + 1;
    }
    index += 1;
  }
  return settled ? text.length : -1;
}

// Sentences and blank-line phrases only. A short fragment stays put so the
// next sentence can complete it. Open tools, and conclusions that still
// depend on a tool, hold the cursor until the turn settles.
export function takeSpeakableSegments(text, cursor, options = {}) {
  const source = typeof text === "string" ? text : "";
  const start = Number.isInteger(cursor) && cursor > 0 ? Math.min(cursor, source.length) : 0;
  const toolsOpen = options.toolsOpen === true;
  const anyToolUsed = options.anyToolUsed === true;
  const settled = options.settled === true;
  if ((toolsOpen && !settled) || start >= source.length) {
    return { cursor: start, segments: [] };
  }
  const segments = [];
  let spokenThrough = start;
  let scan = start;
  while (scan <= source.length) {
    const end = boundaryFrom(source, scan, settled);
    if (end < 0) break;
    const trimmed = source.slice(spokenThrough, end).trim();
    const atEnd = end >= source.length;
    if (!trimmed) {
      spokenThrough = skipSpace(source, end);
      scan = spokenThrough;
      if (atEnd) break;
      continue;
    }
    if (wordCount(trimmed) < 3 && !(settled && atEnd)) {
      if (atEnd) break;
      scan = end;
      continue;
    }
    if (anyToolUsed && !settled && looksUnverified(trimmed)) break;
    segments.push(trimmed);
    spokenThrough = skipSpace(source, end);
    scan = spokenThrough;
    if (spokenThrough >= source.length) break;
  }
  return { cursor: spokenThrough, segments };
}

export function initialLiveState() {
  return {
    startedAt: null,
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

export function observeLiveTurn(state, turn) {
  const next = { ...state };
  const status = typeof turn?.status === "string" ? turn.status : "";
  if (status === CHIEF_STATUS.APPROVAL) {
    next.toolsOpen = true;
    return next;
  }
  if (TOOL_STATUS.has(status)) {
    if (!next.toolsOpen || next.toolStatus !== status) next.phase = "begin";
    next.toolsOpen = true;
    next.anyToolUsed = true;
    next.toolStatus = status;
    return next;
  }
  if (status === CHIEF_STATUS.WORKING && next.toolsOpen && next.toolStatus) {
    next.phase = "end";
    next.toolsOpen = false;
    return next;
  }
  if (status === CHIEF_STATUS.READY) next.toolsOpen = false;
  return next;
}

function progressLine(status, phase) {
  if (status === CHIEF_STATUS.WEB_SEARCH) {
    return phase === "end" ? "I've got a result. I'm reading it." : "I'm looking that up.";
  }
  if (status === CHIEF_STATUS.FINANCE) {
    return phase === "end"
      ? "I've got the financial result. I'm reading it."
      : "I'm checking your financial data.";
  }
  if (status === CHIEF_STATUS.MODULE_ACCESS || status === CHIEF_STATUS.MODULE_ACCESS_SET) {
    return phase === "end"
      ? "I've got the access result. I'm reading it."
      : "I'm checking Freedom Financial access.";
  }
  return phase === "end" ? "I've got a result. I'm reading it." : "I'm checking that now.";
}

function presetAck(preset) {
  return PRESET_ACK[preset] || PRESET_ACK.jarvis;
}

// Timing makes a cue eligible. It does not require one. A cue is skipped when
// the answer is already visible or speaking, when this line was already said,
// or when no new tool event has something useful to add.
export function nextConversationCue(state, input = {}) {
  const current = state || initialLiveState();
  if (current.stopped) return { cue: null, state: current };
  if (input.finished === true || input.status === CHIEF_STATUS.APPROVAL) {
    return { cue: null, state: current };
  }
  const visible = Number(input.visibleChars) > 0;
  if (visible || input.speaking === true || current.answerSpeaking) {
    return { cue: null, state: current };
  }
  const now = Number(input.now);
  const started = Number(current.startedAt);
  if (current.startedAt == null || !Number.isFinite(now) || !Number.isFinite(started)) {
    return { cue: null, state: current };
  }
  const elapsed = now - started;
  const speak = input.speak !== false;
  if (!current.lastCueAt) {
    if (elapsed < ACK_AFTER_MS) return { cue: null, state: current };
    const toolActive = TOOL_STATUS.has(current.toolStatus);
    const ended = toolActive && current.phase === "end";
    const text = ended
      ? progressLine(current.toolStatus, "end")
      : toolActive
        ? TOOL_ACK[current.toolStatus]
        : presetAck(input.preset);
    return {
      cue: { text, speak },
      state: {
        ...current,
        lastCueAt: now,
        lastCueText: text,
        lastProgressKey: toolActive ? `${ended ? "end" : "begin"}:${current.toolStatus}` : "",
      },
    };
  }
  if (elapsed < PROGRESS_AFTER_MS) return { cue: null, state: current };
  if (!current.toolStatus || !current.phase) return { cue: null, state: current };
  if (now - current.lastCueAt < CUE_COOLDOWN_MS) return { cue: null, state: current };
  const key = `${current.phase}:${current.toolStatus}`;
  if (key === current.lastProgressKey) return { cue: null, state: current };
  const text = progressLine(current.toolStatus, current.phase);
  if (!text || text === current.lastCueText) return { cue: null, state: current };
  return {
    cue: { text, speak },
    state: {
      ...current,
      lastCueAt: now,
      lastCueText: text,
      lastProgressKey: key,
    },
  };
}

export function speechSourceForTail(streamText, historyAnswer) {
  const streamed = typeof streamText === "string" ? streamText : "";
  const stored = typeof historyAnswer === "string" ? historyAnswer : "";
  if (!stored.trim()) return streamed;
  if (!streamed.trim()) return stored;
  if (stored.startsWith(streamed.trim())) return stored;
  return streamed;
}

export function createLiveDelivery() {
  let state = initialLiveState();
  return {
    start(now) {
      state = { ...initialLiveState(), startedAt: now, stopped: false };
    },
    stop() {
      state = { ...state, stopped: true };
    },
    get stopped() {
      return state.stopped;
    },
    observe(turn) {
      if (state.stopped) return;
      state = observeLiveTurn(state, turn);
    },
    segments(text, options) {
      const result = takeSpeakableSegments(text, state.cursor, {
        toolsOpen: state.toolsOpen,
        anyToolUsed: state.anyToolUsed,
        settled: options?.settled === true,
      });
      state = {
        ...state,
        cursor: result.cursor,
        answerSpeaking: state.answerSpeaking || result.segments.length > 0,
      };
      return result.segments;
    },
    cue(input) {
      const result = nextConversationCue(state, input);
      state = result.state;
      return result.cue;
    },
  };
}
