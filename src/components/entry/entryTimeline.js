// Pure clock for the Freedom OS gateway. Home, login, signup, boot, and
// return visits all play the 5 second construction from elapsed 0.
// `abbreviated` remains for compatibility and is not selected by the gateway.
// Reduced motion settles immediately.
// ENTRY_SEEN_KEY is retained for compatibility and does not choose the clock.

export const FULL_ENTRY_MS = 5000;
export const BRIEF_ENTRY_MS = 1100;
export const REDUCED_ENTRY_MS = 400;
export const ENTRY_SEEN_KEY = "madfuturics.entry.complete";

export function entryDurationMs({ reducedMotion = false, abbreviated = false } = {}) {
  if (reducedMotion) return REDUCED_ENTRY_MS;
  if (abbreviated) return BRIEF_ENTRY_MS;
  return FULL_ENTRY_MS;
}

export function readEntrySeen(storage) {
  try {
    return storage?.getItem(ENTRY_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markEntrySeen(storage) {
  try {
    storage?.setItem(ENTRY_SEEN_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

// One clock for every fresh gateway entry. The seen-flag is not an input:
// a stored `madfuturics.entry.complete` value must not shorten the sequence.
export function gatewayEntryClock({ reducedMotion = false } = {}) {
  const reduced = reducedMotion === true;
  return {
    elapsedMs: 0,
    abbreviated: false,
    reducedMotion: reduced,
    durationMs: entryDurationMs({ reducedMotion: reduced, abbreviated: false }),
  };
}

function easeOut(value) {
  const t = Math.min(1, Math.max(0, value));
  return 1 - (1 - t) ** 3;
}

function phaseForSeconds(seconds) {
  if (seconds < 1) return { phase: "void", local: seconds };
  if (seconds < 2) return { phase: "current", local: seconds - 1 };
  if (seconds < 3) return { phase: "expansion", local: seconds - 2 };
  if (seconds < 4) return { phase: "diamond", local: seconds - 3 };
  if (seconds < 5) return { phase: "reveal", local: seconds - 4 };
  return { phase: "rest", local: 1 };
}

export function entryPresentation({
  elapsedMs = 0,
  reducedMotion = false,
  abbreviated = false,
} = {}) {
  const durationMs = entryDurationMs({ reducedMotion, abbreviated });
  const elapsed = Math.max(0, Number(elapsedMs) || 0);

  if (reducedMotion) {
    const t = Math.min(1, elapsed / REDUCED_ENTRY_MS);
    return {
      variant: "reduced",
      durationMs,
      phase: "rest",
      seconds: 5,
      assemble: 1,
      wordmark: t,
      command: t,
      energy: 0.42,
      curl: 0,
      bottomGlow: 0.28,
      drift: false,
      interactive: t >= 1,
      population: "reduced",
      complete: t >= 1,
    };
  }

  const seconds = Math.min(5, (Math.min(elapsed, durationMs) / durationMs) * 5);
  const { phase, local } = phaseForSeconds(seconds);
  const assemble = phase === "diamond" ? local : seconds >= 4 ? 1 : 0;
  const wordmark = phase === "reveal" ? easeOut(local) : phase === "rest" ? 1 : 0;
  const command =
    phase === "rest" ? 1 : phase === "reveal" ? Math.max(0, (local - 0.55) / 0.45) : 0;
  let energy = 0.74;
  let curl = 0.35;
  if (phase === "void") {
    energy = 0.15 + local * 0.35;
    curl = local * 0.12;
  } else if (phase === "current") {
    energy = 0.52 + local * 0.28;
    curl = 0.16 + local * 0.34;
  } else if (phase === "expansion") {
    energy = 0.82 + local * 0.18;
    curl = 0.55 + local * 0.45;
  } else if (phase === "diamond") {
    energy = 1;
    curl = 1;
  } else if (phase === "reveal") {
    energy = 0.92 - local * 0.12;
    curl = 0.78 - local * 0.2;
  }
  const bottomGlow =
    phase === "void"
      ? 0.06 + local * 0.94
      : phase === "current"
        ? 1
        : phase === "expansion"
          ? 1
          : Math.max(0.34, 0.9 - Math.max(0, seconds - 3) * 0.18);

  return {
    variant: abbreviated ? "brief" : "full",
    durationMs,
    phase,
    seconds,
    assemble,
    wordmark,
    command,
    energy,
    curl,
    bottomGlow,
    drift: seconds >= 3.85,
    interactive: phase === "rest",
    population: phase,
    complete: phase === "rest",
  };
}
