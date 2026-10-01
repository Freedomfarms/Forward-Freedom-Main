import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BRIEF_ENTRY_MS,
  FULL_ENTRY_MS,
  REDUCED_ENTRY_MS,
  entryDurationMs,
  entryPresentation,
  markEntrySeen,
  readEntrySeen,
} from "../src/components/entry/entryTimeline.js";
import {
  createCurrent,
  fieldBudget,
  stepCurrent,
  visiblePopulation,
} from "../src/components/entry/entryField.js";

const gatewaySource = readFileSync(
  new URL("../src/components/entry/MadFuturicsGateway.jsx", import.meta.url),
  "utf8"
);
const fieldSource = readFileSync(
  new URL("../src/components/entry/EntryField.jsx", import.meta.url),
  "utf8"
);
const authSource = readFileSync(
  new URL("../src/components/AuthScreen.jsx", import.meta.url),
  "utf8"
);
const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const packageSource = readFileSync(new URL("../package.json", import.meta.url), "utf8");

test("the first visit plays the five second construction", () => {
  assert.equal(entryDurationMs(), FULL_ENTRY_MS);
  assert.equal(entryPresentation({ elapsedMs: 0 }).phase, "void");
  assert.equal(entryPresentation({ elapsedMs: 0 }).assemble, 0);
  assert.equal(entryPresentation({ elapsedMs: 0 }).wordmark, 0);
  assert.equal(entryPresentation({ elapsedMs: 0 }).interactive, false);
  assert.equal(entryPresentation({ elapsedMs: 500 }).phase, "void");
  assert.equal(entryPresentation({ elapsedMs: 1500 }).phase, "current");
  assert.equal(entryPresentation({ elapsedMs: 2500 }).phase, "expansion");
  const forming = entryPresentation({ elapsedMs: 3500 });
  assert.equal(forming.phase, "diamond");
  assert.ok(forming.assemble > 0.45 && forming.assemble < 0.55);
  const reveal = entryPresentation({ elapsedMs: 4500 });
  assert.equal(reveal.phase, "reveal");
  assert.equal(reveal.assemble, 1);
  assert.ok(reveal.wordmark > 0);
  const rest = entryPresentation({ elapsedMs: 5000 });
  assert.equal(rest.phase, "rest");
  assert.equal(rest.wordmark, 1);
  assert.equal(rest.command, 1);
  assert.equal(rest.interactive, true);
  assert.equal(rest.complete, true);
});

test("returning visitors and direct auth routes use the short activation", () => {
  assert.equal(entryDurationMs({ abbreviated: true }), BRIEF_ENTRY_MS);
  assert.ok(BRIEF_ENTRY_MS >= 750 && BRIEF_ENTRY_MS <= 1500);
  assert.equal(entryPresentation({ elapsedMs: 0, abbreviated: true }).phase, "void");
  const done = entryPresentation({ elapsedMs: BRIEF_ENTRY_MS, abbreviated: true });
  assert.equal(done.phase, "rest");
  assert.equal(done.interactive, true);
  assert.equal(done.assemble, 1);
  assert.match(gatewaySource, /variant !== "home"/);
  assert.match(appSource, /initialMode=\{screen === "signup" \? "register" : "login"\}/);
});

test("reduced motion settles the diamond and wordmark without the full boot", () => {
  assert.equal(entryDurationMs({ reducedMotion: true }), REDUCED_ENTRY_MS);
  const start = entryPresentation({ elapsedMs: 0, reducedMotion: true });
  assert.equal(start.phase, "rest");
  assert.equal(start.assemble, 1);
  assert.equal(start.wordmark, 0);
  assert.equal(start.drift, false);
  assert.equal(start.population, "reduced");
  const settled = entryPresentation({ elapsedMs: REDUCED_ENTRY_MS, reducedMotion: true });
  assert.equal(settled.wordmark, 1);
  assert.equal(settled.command, 1);
  assert.equal(settled.interactive, true);
});

test("the full entrance is remembered and the short one is not required to be", () => {
  const storage = new Map();
  const memory = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
  };
  assert.equal(readEntrySeen(memory), false);
  assert.equal(markEntrySeen(memory), true);
  assert.equal(readEntrySeen(memory), true);
  assert.equal(readEntrySeen(null), false);
});

test("the field ignites small, then fills, and the current moves upward", () => {
  assert.equal(fieldBudget(false), 700);
  assert.equal(fieldBudget(true), 240);
  assert.equal(visiblePopulation(700, "void"), 40);
  assert.equal(visiblePopulation(240, "void"), 40);
  assert.equal(visiblePopulation(700, "expansion"), 700);
  assert.equal(visiblePopulation(240, "reduced"), 36);
  const particles = createCurrent(40, 3);
  const before = particles.map((particle) => particle.y);
  stepCurrent(particles, 0.5, { energy: 1, assemble: 0, wordmark: 0 });
  const risen = particles.filter((particle, index) => particle.y > before[index]).length;
  assert.ok(risen > 30);
});

test("the gateway keeps authentication behavior and one canvas loop", () => {
  assert.match(gatewaySource, /MAD FUTURICS/);
  assert.match(gatewaySource, /ENTER THE SYSTEM/);
  assert.match(gatewaySource, /Freedom Diamond/);
  assert.match(authSource, /IDENTIFY YOURSELF/);
  assert.match(authSource, /signInWithGoogle/);
  assert.match(authSource, /signInWithEmail/);
  assert.match(authSource, /signUpWithEmail/);
  assert.match(authSource, /requestPasswordReset/);
  assert.match(authSource, /markPendingLegalConsent/);
  assert.match(authSource, /onModeChange/);
  assert.match(authSource, /variant=\{mode === "register" \? "signup" : "login"\}/);
  assert.match(appSource, /MadFuturicsBoot/);
  assert.doesNotMatch(appSource, /Powering Freedom/);
  assert.match(fieldSource, /visibilityState/);
  assert.match(fieldSource, /ResizeObserver/);
  assert.match(fieldSource, /devicePixelRatio/);
  assert.match(fieldSource, /formationFrame/);
  assert.doesNotMatch(packageSource, /"three"/);
  assert.doesNotMatch(fieldSource, /from "three"/);
});
