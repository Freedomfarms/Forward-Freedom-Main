import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CHIEF_INTRO_DEFAULT_MS,
  CHIEF_INTRO_SLOW_MS,
  buildIntroGeometry,
  chiefIntroPhaseLabel,
  clamp01,
  createChiefIntroRenderer,
  smoothstep,
} from "../src/visual/chiefIntro/chiefIntroRenderer.js";
import {
  hasChiefIntroPlayed,
  markChiefIntroPlayed,
} from "../src/visual/chiefIntro/chiefIntroSession.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ────────────────────────────────────────────────────────────────────────────
// Minimal DOM + scheduler harness so the ported renderer runs for real.
// ────────────────────────────────────────────────────────────────────────────

function makeContext() {
  const gradient = { addColorStop() {} };
  return {
    setTransform() {},
    clearRect() {},
    createRadialGradient: () => gradient,
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    ellipse() {},
    fill() {},
    stroke() {},
    save() {},
    restore() {},
  };
}

function makeElement(extra = {}) {
  return {
    style: {
      setProperty(name, value) {
        this[name] = String(value);
      },
    },
    inert: false,
    hidden: false,
    textContent: "",
    addEventListener() {},
    removeEventListener() {},
    ...extra,
  };
}

function makeHarness({ panels = 6, phase = true, dock = true, skip = true } = {}) {
  const canvas = makeElement({ width: 0, height: 0, getContext: () => makeContext() });
  const stage = makeElement({
    getBoundingClientRect: () => ({ width: 1200, height: 555, left: 0, top: 0 }),
  });
  const panelList = Array.from({ length: panels }, (_, i) =>
    makeElement({ offsetLeft: i % 2 === 0 ? 60 : 920, offsetWidth: 220 })
  );
  const phaseText = phase ? makeElement() : null;
  const dockEl = dock ? makeElement() : null;
  const skipEl = skip ? makeElement() : null;
  const root = makeElement({
    isConnected: true,
    dataset: {},
    querySelector(selector) {
      if (selector === ".fc-stage") return stage;
      if (selector === ".fc-canvas") return canvas;
      if (selector === ".fc-phase-text") return phaseText;
      if (selector === ".fc-dock") return dockEl;
      if (selector === ".fc-skip") return skipEl;
      return null;
    },
    querySelectorAll(selector) {
      return selector === ".fc-panel" ? panelList : [];
    },
  });
  return { root, stage, canvas, panelList, phaseText, dockEl, skipEl };
}

function installGlobals() {
  const saved = {};
  const frames = new Map();
  let frameId = 0;
  let clock = 0;
  const media = {
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  };
  const globalsToSet = {
    window: {
      matchMedia: () => media,
      devicePixelRatio: 2,
      addEventListener() {},
      removeEventListener() {},
    },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    performance: { now: () => clock },
    requestAnimationFrame: (cb) => {
      frameId += 1;
      frames.set(frameId, cb);
      return frameId;
    },
    cancelAnimationFrame: (id) => {
      frames.delete(id);
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  for (const [key, value] of Object.entries(globalsToSet)) {
    saved[key] = globalThis[key];
    globalThis[key] = value;
  }
  return {
    media,
    setClock(value) {
      clock = value;
    },
    // Advance the virtual clock and pump every pending animation frame once.
    step(toMs) {
      clock = toMs;
      const pending = [...frames.values()];
      frames.clear();
      for (const cb of pending) cb(clock);
    },
    // The renderer clamps a frame delta at 70ms (as the prototype does), so
    // real progress needs vsync-sized steps rather than one large jump.
    advanceTo(toMs) {
      while (clock < toMs) {
        this.step(Math.min(clock + 50, toMs));
      }
    },
    pendingFrames: () => frames.size,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Pure pieces of the port.
// ────────────────────────────────────────────────────────────────────────────

test("the port keeps the approved timings, easing, and phase script", () => {
  assert.equal(CHIEF_INTRO_DEFAULT_MS, 5800);
  assert.equal(CHIEF_INTRO_SLOW_MS, 8000);
  assert.equal(clamp01(-2), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(smoothstep(0.5), 0.5);
  assert.equal(smoothstep(1.4), 1);
  assert.equal(chiefIntroPhaseLabel(0), "AWAKENING");
  assert.equal(chiefIntroPhaseLabel(0.2), "INTELLIGENCE TAKING SHAPE");
  assert.equal(chiefIntroPhaseLabel(0.5), "CAPABILITIES UNFOLDING");
  assert.equal(chiefIntroPhaseLabel(0.9), "WELCOME TO FREEDOM OS");
  assert.equal(chiefIntroPhaseLabel(Infinity), "YOUR SPACE TO THINK");
});

test("the geometry is the prototype's exact deterministic arrangement", () => {
  const a = buildIntroGeometry();
  const b = buildIntroGeometry();
  assert.equal(a.stars.length, 100);
  assert.equal(a.sphere.length, 52);
  for (const strand of a.sphere) assert.equal(strand.length, 43);
  assert.equal(a.bolt.length, 8);
  assert.deepEqual(a.bolt[0], [0.25, -0.94]);
  assert.deepEqual(a.bolt[7], [-0.38, 0.97]);
  assert.equal(a.branches.length, 4);
  assert.deepEqual(
    a.branches.map((branch) => branch.at),
    [0.29, 0.17, 0.55, 0.63]
  );
  // Seeded LCG: two builds are identical, so the approved look is stable.
  assert.deepEqual(a.stars, b.stars);
  assert.deepEqual(a.sphere[0], b.sphere[0]);
  for (const s of a.stars) {
    assert.ok(s.r >= 0.3 && s.r <= 1.4);
    assert.ok(s.a >= 0.1 && s.a <= 0.6);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Renderer lifecycle against the mocked DOM.
// ────────────────────────────────────────────────────────────────────────────

test("the intro progresses through the approved choreography once", () => {
  const env = installGlobals();
  try {
    const dom = makeHarness();
    let readyCalls = 0;
    const renderer = createChiefIntroRenderer(dom.root, { onReady: () => readyCalls++ });
    assert.ok(renderer);

    // Awakening: progress near zero, panels withheld, dock inert, skip shown.
    assert.equal(dom.root.dataset.ready, "false");
    assert.equal(dom.dockEl.inert, true);
    assert.equal(dom.skipEl.hidden, false);
    assert.equal(dom.phaseText.textContent, "AWAKENING");
    assert.equal(dom.panelList[0].inert, true);
    assert.equal(dom.panelList[0].style.willChange, "transform,opacity");

    env.advanceTo(1300);
    assert.equal(dom.phaseText.textContent, "INTELLIGENCE TAKING SHAPE");
    assert.equal(dom.root.dataset.ready, "false");

    // Panel entrances: staggered, left/right alternating, in order.
    env.advanceTo(3400);
    assert.equal(dom.phaseText.textContent, "CAPABILITIES UNFOLDING");
    const first = Number(dom.panelList[0].style.opacity);
    const last = Number(dom.panelList[5].style.opacity);
    assert.ok(first > 0.9, `first panel ${first}`);
    assert.ok(last < first, `stagger ${last} < ${first}`);
    assert.equal(dom.panelList[0].inert, false);
    assert.match(dom.panelList[1].style.transform, /rotateY\(-/);

    // Settled: ready flips once, dock usable, skip hidden, ambient continues.
    env.advanceTo(6200);
    assert.equal(dom.root.dataset.ready, "true");
    assert.equal(readyCalls, 1);
    assert.equal(dom.dockEl.inert, false);
    assert.equal(dom.skipEl.hidden, true);
    assert.equal(dom.phaseText.textContent, "YOUR SPACE TO THINK");
    assert.equal(Number(dom.panelList[5].style.opacity), 1);
    assert.equal(dom.panelList[5].style.willChange, "auto");
    assert.ok(env.pendingFrames() > 0, "ambient loop keeps running after the intro");
    assert.ok(Number(dom.root.style["--progress"]) >= 1);

    // Replay restarts the sequence without a reload.
    renderer.replay();
    assert.equal(dom.root.dataset.ready, "false");
    assert.equal(dom.dockEl.inert, true);
    assert.equal(dom.skipEl.hidden, false);
    assert.equal(renderer.inspect().elapsed, 0);

    // Skip jumps straight to the settled composition.
    renderer.skip();
    assert.equal(dom.root.dataset.ready, "true");
    assert.equal(dom.dockEl.inert, false);
    assert.equal(renderer.inspect().elapsed, renderer.inspect().duration);

    // The slow pace keeps the same choreography at 8 seconds.
    renderer.setDuration(CHIEF_INTRO_SLOW_MS);
    assert.equal(renderer.inspect().duration, 8000);
    assert.equal(dom.root.dataset.ready, "false");

    renderer.destroy();
    assert.equal(renderer.inspect().raf, 0);
  } finally {
    env.restore();
  }
});

test("a settled start (second public page in the session) never replays", () => {
  const env = installGlobals();
  try {
    const dom = makeHarness();
    const renderer = createChiefIntroRenderer(dom.root, { startSettled: true });
    assert.equal(dom.root.dataset.ready, "true");
    assert.equal(renderer.inspect().elapsed, renderer.inspect().duration);
    env.step(500);
    assert.equal(dom.root.dataset.ready, "true");
    renderer.destroy();
  } finally {
    env.restore();
  }
});

test("the login backdrop runs without panels, dock, phase, or skip", () => {
  const env = installGlobals();
  try {
    const dom = makeHarness({ panels: 0, phase: false, dock: false, skip: false });
    const renderer = createChiefIntroRenderer(dom.root, {});
    assert.ok(renderer);
    env.advanceTo(6200);
    assert.equal(dom.root.dataset.ready, "true");
    assert.ok(Number(dom.root.style["--ignition"]) >= 1);
    renderer.destroy();
  } finally {
    env.restore();
  }
});

test("reduced motion settles immediately on a static frame", () => {
  const env = installGlobals();
  try {
    env.media.matches = true;
    const dom = makeHarness();
    const renderer = createChiefIntroRenderer(dom.root, {});
    assert.equal(dom.root.dataset.ready, "true");
    assert.equal(dom.skipEl.hidden, true);
    assert.equal(Number(dom.panelList[5].style.opacity), 1);
    env.step(16);
    // The reduced loop does not reschedule: one frame, then rest.
    env.step(32);
    assert.equal(env.pendingFrames(), 0);
    renderer.destroy();
  } finally {
    env.restore();
  }
});

test("the session flag is per-storage and failure-safe", () => {
  const storage = new Map();
  const memory = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
  };
  assert.equal(hasChiefIntroPlayed(memory), false);
  assert.equal(markChiefIntroPlayed(memory), true);
  assert.equal(hasChiefIntroPlayed(memory), true);
  assert.equal(hasChiefIntroPlayed(null), false);
  assert.equal(markChiefIntroPlayed(null), false);
  const throwing = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(hasChiefIntroPlayed(throwing), false);
  assert.equal(markChiefIntroPlayed(throwing), false);
});

// ────────────────────────────────────────────────────────────────────────────
// Integration invariants: scope, cleanup, and no protected calls.
// ────────────────────────────────────────────────────────────────────────────

test("the public intro stays scoped and leaves authentication intact", () => {
  const renderer = read("src/visual/chiefIntro/chiefIntroRenderer.js");
  const backdrop = read("src/visual/chiefIntro/ChiefIntroBackdrop.jsx");
  const home = read("src/components/entry/ChiefIntroHome.jsx");
  const shell = read("src/components/freedom/FreedomShell.jsx");
  const auth = read("src/components/AuthScreen.jsx");
  const css = read("src/visual/chiefIntro/chief-intro.css");
  const landing = read("src/components/FreedomOsLanding.jsx");

  // One renderer module, cleanup-complete, no React state per frame.
  assert.match(renderer, /ResizeObserver/);
  assert.match(renderer, /IntersectionObserver/);
  assert.match(renderer, /visibilitychange/);
  assert.match(renderer, /pagehide/);
  assert.match(renderer, /prefers-reduced-motion: reduce/);
  assert.match(renderer, /Math\.min\(window\.devicePixelRatio \|\| 1, 1\.5\)/);
  assert.match(renderer, /ro\.disconnect\(\)/);
  assert.match(renderer, /io\.disconnect\(\)/);
  assert.match(renderer, /listeners\.forEach/);
  assert.doesNotMatch(renderer, /useState|useEffect|setState/);
  assert.doesNotMatch(renderer, /from "three"/);

  // Both hosts mount the same renderer and share the per-tab session flag.
  for (const host of [backdrop, home]) {
    assert.match(host, /createChiefIntroRenderer/);
    assert.match(host, /hasChiefIntroPlayed/);
    assert.match(host, /markChiefIntroPlayed/);
    assert.match(host, /controller\.destroy\(\)/);
  }

  // The homepage keeps registration/sign-in routes and calls no CHIEF API.
  assert.match(home, /onSignIn/);
  assert.match(home, /onCreateAccount/);
  assert.match(home, /Replay/);
  assert.match(home, /Skip/);
  assert.doesNotMatch(home, /chiefApi|fetch\(|\/api\//);
  assert.match(landing, /ChiefIntroHome/);

  // Login keeps the real form on the real shell with the backdrop behind it.
  assert.match(shell, /ChiefIntroBackdrop/);
  assert.match(auth, /FreedomShell/);
  assert.match(auth, /signInWithEmail/);
  assert.match(auth, /signUpWithEmail/);
  assert.match(auth, /requestPasswordReset/);
  assert.doesNotMatch(auth, /createChiefIntroRenderer/);

  // CSS is scoped to the experience root; the standalone body reset stayed in
  // the reference folder.
  assert.doesNotMatch(css, /(^|\n)\s*body\s*\{/);
  assert.match(css, /\.fc-root \*/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);

  // The authenticated CHIEF face still owns its own renderer.
  const face = read("src/components/chief/ChiefInterface.jsx");
  assert.match(face, /ChiefIntelligenceCore/);
  assert.doesNotMatch(face, /ChiefIntroBackdrop|chiefIntroRenderer/);
});
