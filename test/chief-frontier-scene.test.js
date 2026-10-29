import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CHIEF_STATUS } from "../src/utils/chiefProtocol.js";
import {
  frontierActivity,
  frontierStatusCopy,
} from "../src/components/chief/frontier/frontierActivity.js";
import {
  createFrontierGeometry,
  createFrontierScene,
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
  assert.match(scene, /Math\.min\(rect\.width \* 0\.5, scene\.height \* 0\.31\)/);
  assert.doesNotMatch(scene, /roomBelow/);

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
  const observed = [];
  globalThis.ResizeObserver = class {
    observe(node) {
      observed.push(node);
    }
    disconnect() {}
  };
  const anchor = box();
  const stage = box();
  const root = box();
  try {
    const scene = createFrontierScene({
      canvas,
      anchor,
      stage,
      root,
      reduced: false,
      paused: false,
    });
    assert.equal(observed.includes(root), true);
    assert.equal(observed.includes(stage), true);
    assert.equal(observed.includes(anchor), true);
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
