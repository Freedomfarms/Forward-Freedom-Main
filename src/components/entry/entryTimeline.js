// Pure clock for the Mad Futurics gateway. First visit plays the 5 second
// construction. Login, signup, and return visits compress it. Reduced motion
// settles immediately.

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
      energy: 0.16,
      bottomGlow: 0.22,
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
  let energy = 0.7;
  if (phase === "void") energy = 0.2 + local * 0.28;
  else if (phase === "current") energy = 0.48 + local * 0.24;
  else if (phase === "expansion") energy = 0.74 + local * 0.26;
  else if (phase === "diamond") energy = 1;
  else if (phase === "reveal") energy = 0.9 - local * 0.16;
  const bottomGlow =
    phase === "void"
      ? 0.35 + local * 0.65
      : phase === "current"
        ? 1
        : Math.max(0.22, 0.85 - Math.max(0, seconds - 2) * 0.16);

  return {
    variant: abbreviated ? "brief" : "full",
    durationMs,
    phase,
    seconds,
    assemble,
    wordmark,
    command,
    energy,
    bottomGlow,
    drift: seconds >= 3.85,
    interactive: phase === "rest",
    population: phase,
    complete: phase === "rest",
  };
}
