import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BRIEF_ENTRY_MS,
  FULL_ENTRY_MS,
  REDUCED_ENTRY_MS,
  entryDurationMs,
  entryPresentation,
  gatewayEntryClock,
  markEntrySeen,
  readEntrySeen,
} from "../src/components/entry/entryTimeline.js";
import {
  createCurrent,
  fieldBudget,
  motionWeights,
  placeParticle,
  stepCurrent,
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

test("home, login, and return visits use the full five second construction", () => {
  for (const label of ["home", "login", "signup"]) {
    const clock = gatewayEntryClock();
    const origin = entryPresentation(clock);
    assert.equal(clock.elapsedMs, 0, label);
    assert.equal(clock.abbreviated, false, label);
    assert.equal(clock.durationMs, FULL_ENTRY_MS, label);
    assert.equal(origin.phase, "void", label);
    assert.equal(origin.assemble, 0, label);
    assert.equal(origin.seconds, 0, label);
    assert.equal(origin.variant, "full", label);
  }
  assert.equal(entryPresentation({ elapsedMs: FULL_ENTRY_MS }).phase, "rest");
  assert.doesNotMatch(gatewaySource, /readEntrySeen/);
  assert.doesNotMatch(gatewaySource, /markEntrySeen/);
  assert.doesNotMatch(gatewaySource, /variant !== "home"/);
  assert.doesNotMatch(gatewaySource, /elapsedMs:\s*5000/);
  assert.match(gatewaySource, /gatewayEntryClock/);
  assert.match(authSource, /FreedomShell/);
  assert.match(authSource, /variant="auth"/);
  assert.doesNotMatch(authSource, /MadFuturicsGateway/);
  assert.match(appSource, /initialMode=\{screen === "signup" \? "register" : "login"\}/);
  assert.match(appSource, /MadFuturicsBoot/);
});

test("logout and a stored entry flag do not shorten the formation", () => {
  const storage = new Map();
  const memory = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
  };
  assert.equal(markEntrySeen(memory), true);
  assert.equal(readEntrySeen(memory), true);
  const clock = gatewayEntryClock();
  const origin = entryPresentation(clock);
  assert.equal(clock.durationMs, FULL_ENTRY_MS);
  assert.equal(clock.elapsedMs, 0);
  assert.equal(clock.abbreviated, false);
  assert.equal(origin.phase, "void");
  assert.equal(origin.assemble, 0);
  assert.doesNotMatch(gatewaySource, /localStorage/);
  assert.doesNotMatch(gatewaySource, /ENTRY_SEEN_KEY/);
});

test("boot and loading start at the origin instead of the finished field", () => {
  const clock = gatewayEntryClock({ reducedMotion: false });
  const origin = entryPresentation(clock);
  const finished = entryPresentation({ elapsedMs: 5000 });
  assert.equal(clock.elapsedMs, 0);
  assert.equal(clock.durationMs, FULL_ENTRY_MS);
  assert.equal(origin.phase, "void");
  assert.equal(origin.assemble, 0);
  assert.equal(origin.seconds, 0);
  assert.equal(finished.phase, "rest");
  assert.notEqual(origin.phase, finished.phase);
  assert.match(gatewaySource, /reducedMotion: boot \? false : reduced/);
  assert.match(gatewaySource, /applyElapsed\(0\)/);
  assert.match(gatewaySource, /showBootChrome/);
  assert.doesNotMatch(gatewaySource, /elapsedMs:\s*5000/);
  assert.doesNotMatch(gatewaySource, /elapsedMs:\s*boot \? 5000/);
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

test("the seen flag can still be stored and does not choose the clock", () => {
  const storage = new Map();
  const memory = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
  };
  assert.equal(readEntrySeen(memory), false);
  assert.equal(markEntrySeen(memory), true);
  assert.equal(readEntrySeen(memory), true);
  assert.equal(readEntrySeen(null), false);
  assert.equal(entryDurationMs({ abbreviated: true }), BRIEF_ENTRY_MS);
  assert.equal(gatewayEntryClock().abbreviated, false);
  assert.equal(gatewayEntryClock().durationMs, FULL_ENTRY_MS);
});

function placedAt(particles, seconds) {
  const view = entryPresentation({ elapsedMs: seconds * 1000 });
  return particles
    .map((particle) => placeParticle(particle, view, seconds))
    .filter((item) => item.visible);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
}

test("the field ignites as a bottom source before the ribbon rises", () => {
  assert.equal(fieldBudget(false), 1500);
  assert.equal(fieldBudget(true), 520);
  const particles = createCurrent(fieldBudget(false), 7);
  const opening = placedAt(particles, 0.4);
  const xs = opening.map((item) => item.x);
  const span = Math.max(...xs) - Math.min(...xs);
  assert.ok(opening.length > 200 && opening.length < 800);
  assert.ok(span < 0.55);
  assert.ok(mean(opening.map((item) => item.y)) < 0.25);
  const fresh = createCurrent(80, 3);
  const before = fresh.map((particle) => particle.flow);
  stepCurrent(fresh, 0.5, { seconds: 1.2 });
  const advanced = fresh.filter((particle, index) => particle.flow > before[index]).length;
  assert.ok(advanced > 70);
});

test("the ribbon forms the diamond before energy covers the screen", () => {
  const particles = createCurrent(fieldBudget(false), 7);
  let clock = 0;
  const stepTo = (seconds) => {
    while (clock < seconds - 1e-6) {
      stepCurrent(particles, 1 / 60, entryPresentation({ elapsedMs: clock * 1000 }));
      clock += 1 / 60;
    }
  };
  stepTo(1.15);
  const ribbon = placedAt(particles, 1.15);
  assert.ok(motionWeights(1.15).head > 0.9);
  assert.ok(mean(ribbon.map((item) => item.x)) < -0.1);
  assert.ok(Math.max(...ribbon.map((item) => item.y)) > 0.7);
  assert.equal(ribbon.filter((item) => Math.abs(item.x) > 0.9).length, 0);

  stepTo(2.9);
  const forming = placedAt(particles, 2.9);
  const formingSpan =
    Math.max(...forming.map((item) => item.x)) - Math.min(...forming.map((item) => item.x));
  assert.ok(motionWeights(2.9).form > 0.6);
  assert.ok(motionWeights(2.9).coverage < 0.05);
  assert.ok(formingSpan < 0.9);

  stepTo(4.6);
  const wide = placedAt(particles, 4.6);
  assert.ok(motionWeights(4.6).coverage > 0.9);
  assert.ok(wide.filter((item) => Math.abs(item.x) > 0.8).length > 40);

  const settled = createCurrent(fieldBudget(false), 4).filter(
    (particle) => particle.role === "body"
  );
  const formed = settled
    .map((particle) => placeParticle(particle, entryPresentation({ elapsedMs: 5000 }), 5))
    .filter((item) => item.visible);
  const onDiamond = formed.filter(
    (item) => Math.abs(item.x) < 0.42 && item.y > 0.2 && item.y < 0.82
  );
  assert.ok(onDiamond.length / formed.length > 0.9);
});

test("the gateway keeps authentication behavior and one canvas loop", () => {
  assert.match(gatewaySource, /FREEDOM OS/);
  assert.doesNotMatch(gatewaySource, /MAD FUTURICS/);
  assert.doesNotMatch(gatewaySource, /Mad Futurics/);
  assert.match(gatewaySource, /ENTER THE SYSTEM/);
  assert.match(gatewaySource, /Freedom Diamond/);
  assert.match(authSource, /IDENTIFY YOURSELF/);
  assert.match(authSource, /FreedomShell/);
  assert.match(authSource, /signInWithGoogle/);
  assert.match(authSource, /signInWithEmail/);
  assert.match(authSource, /signUpWithEmail/);
  assert.match(authSource, /requestPasswordReset/);
  assert.match(authSource, /markPendingLegalConsent/);
  assert.match(authSource, /onModeChange/);
  assert.match(authSource, /variant="auth"/);
  assert.doesNotMatch(authSource, /MadFuturicsGateway/);
  assert.match(appSource, /MadFuturicsBoot/);
  assert.doesNotMatch(appSource, /Powering Freedom/);
  assert.match(fieldSource, /visibilityState/);
  assert.match(fieldSource, /ResizeObserver/);
  assert.match(fieldSource, /devicePixelRatio/);
  assert.match(fieldSource, /formationFrame/);
  assert.match(fieldSource, /token !== loop/);
  assert.match(fieldSource, /token === loop/);
  assert.match(fieldSource, /cancelAnimationFrame\(frame\)/);
  assert.match(fieldSource, /observer\.disconnect\(\)/);
  assert.match(fieldSource, /removeEventListener\("visibilitychange", onVisible\)/);
  assert.match(fieldSource, /removeEventListener\("change", start\)/);
  assert.match(gatewaySource, /removeEventListener\("change", onChange\)/);
  assert.match(gatewaySource, /cancelAnimationFrame\(frame\)/);
  assert.doesNotMatch(fieldSource, /from "three"/);
  assert.doesNotMatch(gatewaySource, /from "three"/);
  assert.match(packageSource, /"three"/);
  const chiefPageSource = readFileSync(
    new URL("../src/components/chief/ChiefPage.jsx", import.meta.url),
    "utf8"
  );
  assert.match(chiefPageSource, /ApexWorld/);
  assert.doesNotMatch(chiefPageSource, /renderIntelligence/);
  assert.doesNotMatch(chiefPageSource, /ChiefField/);
  assert.match(
    readFileSync(new URL("../src/components/chief/chiefField.js", import.meta.url), "utf8"),
    /formationFrame/
  );
});
