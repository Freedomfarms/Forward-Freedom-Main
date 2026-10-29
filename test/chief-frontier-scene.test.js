import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CHIEF_STATUS } from "../src/utils/chiefProtocol.js";
import {
  frontierActivity,
  frontierStatusCopy,
} from "../src/components/chief/frontier/frontierActivity.js";
import {
  IDLE_BREATH_PERIOD_MS,
  INNER_VIOLET,
  SHELL_BLUE,
  THINKING_RING,
  breathScale,
  createFrontierGeometry,
  createFrontierScene,
  interiorTint,
} from "../src/components/chief/frontier/frontierScene.js";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Frontier geometry keeps the reference seed, sphere, and bolt", () => {
  const reference = read("design-references/chief-frontier/chief.js");
  const scene = read("src/components/chief/frontier/frontierScene.js");
  assert.match(reference, /let seed=81/);
  assert.match(scene, /seed = 81/);
  assert.equal(scene.split("requestAnimationFrame").length - 1, 2);
  assert.equal(reference.split("requestAnimationFrame").length - 1, 2);
  assert.match(scene, /cancelAnimationFrame/);
  assert.match(scene, /prefers-reduced-motion/);

  const first = createFrontierGeometry();
  const second = createFrontierGeometry();
  assert.equal(first.stars.length, 100);
  assert.equal(first.sphere.length, 52);
  assert.equal(first.sphere[0].length, 43);
  assert.equal(first.bolt.length, 8);
  assert.deepEqual(first.bolt[0], [0.25, -0.94]);
  assert.deepEqual(first.bolt[7], [-0.38, 0.97]);
  assert.equal(first.branches.length, 4);
  assert.equal(first.stars[0].x, second.stars[0].x);
  assert.deepEqual(first.sphere[10][20], second.sphere[10][20]);
  assert.notEqual(first.sphere[0][0][0], first.sphere[1][0][0]);
});

test("the frontier scene draws a frame and cancels its loop", () => {
  const queued = [];
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
  };
  let cancelled = 0;
  const box = () => ({
    getBoundingClientRect() {
      return { x: 10, y: 20, left: 10, right: 810, top: 20, bottom: 620, width: 800, height: 600 };
    },
  });
  const gradient = { addColorStop() {} };
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "createRadialGradient") return () => gradient;
            return () => {};
          },
          set() {
            return true;
          },
        }
      );
    },
  };
  globalThis.window = {
    devicePixelRatio: 1,
    matchMedia() {
      return { matches: false, addEventListener() {}, removeEventListener() {} };
    },
    addEventListener() {},
    removeEventListener() {},
    visualViewport: null,
  };
  globalThis.document = {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.requestAnimationFrame = (fn) => {
    queued.push(fn);
    return queued.length;
  };
  globalThis.cancelAnimationFrame = () => {
    cancelled += 1;
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  try {
    const scene = createFrontierScene({
      canvas,
      anchor: box(),
      stage: box(),
      root: box(),
      reduced: false,
      paused: false,
    });
    assert.equal(queued.length, 1);
    queued[0](32);
    scene.setActivity("listening");
    scene.setPaused(true);
    scene.setReduced(true);
    scene.destroy();
    assert.equal(cancelled > 0, true);
    const before = queued.length;
    scene.setActivity("responding");
    assert.equal(queued.length, before);
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
    globalThis.ResizeObserver = previous.ResizeObserver;
  }
});

test("Frontier activity follows the live turn and keeps real status text", () => {
  assert.equal(frontierActivity({ listening: true, status: CHIEF_STATUS.WORKING }), "listening");
  assert.equal(
    frontierActivity({ scenePhase: "thinking", status: CHIEF_STATUS.WEB_SEARCH }),
    "thinking"
  );
  assert.equal(frontierActivity({ status: CHIEF_STATUS.TOOL }), "thinking");
  assert.equal(frontierActivity({ status: CHIEF_STATUS.FINANCE }), "thinking");
  assert.equal(
    frontierActivity({ scenePhase: "responding", status: CHIEF_STATUS.RESPONDING }),
    "responding"
  );
  assert.equal(frontierActivity({ assistantState: "speaking" }), "responding");
  assert.equal(frontierActivity({ status: CHIEF_STATUS.APPROVAL }), "idle");
  assert.equal(frontierActivity({ status: CHIEF_STATUS.ERROR }), "idle");
  assert.equal(frontierActivity({ status: CHIEF_STATUS.READY }), "idle");

  const searching = frontierStatusCopy("thinking", CHIEF_STATUS.WEB_SEARCH);
  assert.equal(searching.title, "Reasoning");
  assert.equal(searching.subtitle, CHIEF_STATUS.WEB_SEARCH);
  assert.equal(searching.label, "REASONING");
  assert.equal(
    frontierActivity({ status: CHIEF_STATUS.READY, turnStatus: "continuing" }),
    "thinking"
  );
  assert.equal(frontierActivity({ status: CHIEF_STATUS.READY, playback: "playing" }), "responding");
  assert.equal(frontierActivity({ status: CHIEF_STATUS.RESPONDING }), "responding");
  assert.equal(
    frontierActivity({ listening: true, playback: "playing", status: CHIEF_STATUS.RESPONDING }),
    "listening"
  );
  const ready = frontierStatusCopy("idle", CHIEF_STATUS.READY);
  assert.equal(ready.title, "Standing by");
  assert.equal(ready.presence, "Ready when you are.");
});

test("text, voice, and text-plus-voice map onto the four sphere activities", () => {
  assert.equal(frontierActivity({ status: CHIEF_STATUS.READY, playback: "idle" }), "idle");
  assert.equal(
    frontierActivity({ status: CHIEF_STATUS.WORKING, turnStatus: "running", playback: "idle" }),
    "thinking"
  );
  assert.equal(
    frontierActivity({ status: CHIEF_STATUS.TOOL, turnStatus: "running", playback: "idle" }),
    "thinking"
  );
  assert.equal(
    frontierActivity({
      status: CHIEF_STATUS.WEB_SEARCH,
      turnStatus: "continuing",
      playback: "idle",
    }),
    "thinking"
  );
  assert.equal(
    frontierActivity({ status: CHIEF_STATUS.RESPONDING, turnStatus: "running", playback: "idle" }),
    "responding"
  );
  assert.equal(frontierActivity({ listening: true, playback: "idle" }), "listening");
  assert.equal(frontierActivity({ playback: "preparing" }), "responding");
  assert.equal(frontierActivity({ playback: "playing" }), "responding");
  assert.equal(
    frontierActivity({ status: CHIEF_STATUS.READY, playback: "playing", turnStatus: "completed" }),
    "responding"
  );
  assert.equal(
    frontierActivity({ status: CHIEF_STATUS.READY, playback: "idle", turnStatus: "completed" }),
    "idle"
  );
  assert.equal(frontierActivity({ status: CHIEF_STATUS.ERROR, playback: "idle" }), "idle");
  assert.equal(
    frontierActivity({ listening: true, playback: "playing", status: CHIEF_STATUS.RESPONDING }),
    "listening"
  );
  assert.equal(
    frontierActivity({ status: "On it.", turnStatus: "running", playback: "playing" }),
    "responding"
  );
  assert.equal(
    frontierActivity({ status: "On it.", turnStatus: "running", playback: "idle" }),
    "thinking"
  );
  assert.equal(frontierActivity({ status: "On it.", turnStatus: "", playback: "idle" }), "idle");
  assert.equal(
    frontierActivity({
      status: "I've got a result. I'm reading it.",
      turnStatus: "running",
      playback: "idle",
    }),
    "thinking"
  );
});

test("idle breath is exactly five seconds and listening follows the microphone", () => {
  assert.equal(IDLE_BREATH_PERIOD_MS, 5000);
  assert.equal(breathScale(0, { activity: "idle", energy: 0.9 }), 1);
  assert.equal(breathScale(1250, { activity: "idle", energy: 0.15 }), 1.008);
  assert.equal(breathScale(1250, { activity: "idle", energy: 0.9 }), 1.008);
  assert.ok(Math.abs(breathScale(2500, { activity: "idle" }) - 1) < 1e-12);
  assert.equal(breathScale(3750, { activity: "idle" }), 0.992);
  assert.equal(breathScale(5000, { activity: "idle", energy: 0.9 }), 1);
  assert.notEqual(
    breathScale(1250, { activity: "thinking", energy: 0.85 }),
    breathScale(1250, { activity: "idle", energy: 0.85 })
  );
  assert.equal(breathScale(1250, { activity: "idle", reduced: true }), 1);

  const shell = interiorTint(SHELL_BLUE, 1, 0);
  assert.deepEqual(shell, [...SHELL_BLUE]);
  assert.deepEqual(interiorTint(SHELL_BLUE, 0, 1), [...SHELL_BLUE]);
  assert.deepEqual(interiorTint(SHELL_BLUE, 1, 1), [...INNER_VIOLET]);

  const sceneSource = read("src/components/chief/frontier/frontierScene.js");
  assert.doesNotMatch(sceneSource, /activity === "listening" \|\| activity === "responding"/);
  assert.match(
    read("src/components/chief/ChiefPage.jsx"),
    /audioLevelRef=\{voice\.audioLevelRef\}/
  );
  assert.match(read("src/components/chief/ChiefPage.jsx"), /statusForOpenTurn\(/);
  assert.match(read("src/components/chief/ChiefInterface.jsx"), /levelRef: audioLevelRef/);
});

test("the frontier canvas eases ring, violet, and microphone level by activity", () => {
  const queued = [];
  const styles = [];
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
  };
  const gradient = { addColorStop() {} };
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      const store = {};
      return new Proxy(store, {
        get(target, prop) {
          if (prop === "createRadialGradient") return () => gradient;
          if (prop in target) return target[prop];
          return () => {};
        },
        set(target, prop, value) {
          if (prop === "strokeStyle") styles.push(value);
          target[prop] = value;
          return true;
        },
      });
    },
  };
  const box = () => ({
    getBoundingClientRect() {
      return { x: 0, y: 0, left: 0, right: 900, top: 0, bottom: 700, width: 900, height: 700 };
    },
  });
  globalThis.window = {
    devicePixelRatio: 1,
    matchMedia() {
      return { matches: false, addEventListener() {}, removeEventListener() {} };
    },
    addEventListener() {},
    removeEventListener() {},
    visualViewport: null,
  };
  globalThis.document = {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.requestAnimationFrame = (fn) => {
    queued.push(fn);
    return queued.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };

  let now = 20;
  function pump(frames, stepMs) {
    for (let i = 0; i < frames; i += 1) {
      const fn = queued[queued.length - 1];
      now += stepMs;
      fn(now);
    }
  }

  function saw(rgb) {
    const needle = `${rgb[0]},${rgb[1]},${rgb[2]}`;
    return styles.some((style) => String(style).includes(needle));
  }

  try {
    const levelRef = { current: 0 };
    const scene = createFrontierScene({
      canvas,
      anchor: box(),
      stage: box(),
      root: box(),
      levelRef,
    });
    pump(8, 40);
    const idle = scene.inspect();
    assert.equal(idle.activity, "idle");
    assert.ok(idle.ringMix < 0.05, `idle ring ${idle.ringMix}`);
    assert.ok(idle.respondMix < 0.05, `idle violet ${idle.respondMix}`);
    assert.equal(saw(THINKING_RING), false);

    scene.setActivity("listening");
    levelRef.current = 0;
    pump(4, 40);
    assert.ok(scene.inspect().listenLevel < 0.08);
    levelRef.current = 1;
    pump(18, 40);
    const loud = scene.inspect();
    assert.equal(loud.activity, "listening");
    assert.ok(loud.listenLevel > 0.7, `mic level ${loud.listenLevel}`);
    assert.ok(loud.ringMix < 0.08, `listening ring ${loud.ringMix}`);
    assert.equal(saw(THINKING_RING), false);
    levelRef.current = 0;
    pump(18, 40);
    assert.ok(scene.inspect().listenLevel < 0.2, `mic decay ${scene.inspect().listenLevel}`);

    styles.length = 0;
    scene.setActivity("thinking");
    pump(20, 40);
    const thinking = scene.inspect();
    assert.ok(thinking.ringMix > 0.75, `thinking ring ${thinking.ringMix}`);
    assert.ok(thinking.respondMix < 0.08, `thinking violet ${thinking.respondMix}`);
    assert.equal(saw(THINKING_RING), true);
    assert.equal(saw(INNER_VIOLET), false);

    scene.setActivity("responding");
    pump(40, 40);
    styles.length = 0;
    pump(8, 40);
    const responding = scene.inspect();
    assert.ok(responding.respondMix > 0.8, `respond mix ${responding.respondMix}`);
    assert.ok(responding.ringMix < 0.05, `respond ring ${responding.ringMix}`);
    assert.equal(saw(THINKING_RING), false);
    assert.equal(saw(interiorTint(SHELL_BLUE, 1, responding.respondMix)), true);

    scene.setActivity("idle");
    scene.setReduced(true);
    scene.setPaused(true);
    pump(1, 40);
    const reduced = scene.inspect();
    assert.equal(reduced.paused, true);
    assert.equal(reduced.breath, 1);
    assert.equal(reduced.ringMix, 0);
    scene.destroy();
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
    globalThis.ResizeObserver = previous.ResizeObserver;
  }
});
