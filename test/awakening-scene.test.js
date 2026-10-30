import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  OPENING_DURATION,
  mountAwakeningScene,
  openingAt,
  readAwakeningSession,
  resetAwakeningSessionForTests,
} from "../src/components/awakening/awakeningScene.js";

const sceneSource = readFileSync(
  new URL("../src/components/awakening/awakeningScene.js", import.meta.url),
  "utf8"
);

function makeContext() {
  const gradient = { addColorStop() {} };
  return new Proxy(
    {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      shadowBlur: 0,
      shadowColor: "",
      globalAlpha: 1,
      globalCompositeOperation: "",
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === "createRadialGradient") return () => gradient;
        return () => {};
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    }
  );
}

function createClassList() {
  const names = new Set();
  return {
    names,
    add(name) {
      names.add(name);
    },
    remove(...removed) {
      removed.forEach((name) => names.delete(name));
    },
    toggle(name, force) {
      const next = force === undefined ? !names.has(name) : Boolean(force);
      if (next) names.add(name);
      else names.delete(name);
      return next;
    },
    contains(name) {
      return names.has(name);
    },
  };
}

function createNode(tag) {
  const node = {
    tagName: tag.toUpperCase(),
    id: "",
    children: [],
    parentNode: null,
    attrs: {},
    dataset: {},
    style: {
      setProperty(name, value) {
        this[name] = String(value);
      },
    },
    classList: null,
    hidden: false,
    inert: false,
    textContent: "",
    listeners: [],
    offsetTop: 0,
    offsetHeight: 800,
    offsetLeft: 0,
    offsetWidth: 200,
    width: 0,
    height: 0,
    get className() {
      return [...node.classList.names].join(" ");
    },
    set className(value) {
      node.classList.names.clear();
      String(value)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((name) => node.classList.names.add(name));
    },
    set innerHTML(html) {
      node.children = [];
      const pattern = /<button\b([^>]*)>/g;
      let match = pattern.exec(html);
      while (match) {
        const button = createNode("button");
        const className = /class="([^"]*)"/.exec(match[1]);
        if (className) button.className = className[1];
        const label = /aria-label="([^"]*)"/.exec(match[1]);
        if (label) button.attrs["aria-label"] = label[1];
        button.offsetTop = 400;
        button.offsetLeft = 80;
        button.offsetWidth = 240;
        button.offsetHeight = 132;
        node.append(button);
        match = pattern.exec(html);
      }
    },
    append(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    addEventListener(type, fn, options) {
      node.listeners.push({ type, fn, options });
    },
    removeEventListener(type, fn) {
      node.listeners = node.listeners.filter((entry) => entry.type !== type || entry.fn !== fn);
    },
    setAttribute(name, value) {
      node.attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete node.attrs[name];
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null;
    },
    matches(selector) {
      return matches(node, selector);
    },
    contains(other) {
      let current = other;
      while (current) {
        if (current === node) return true;
        current = current.parentNode;
      }
      return false;
    },
    focus() {},
    click() {
      node.listeners.filter((entry) => entry.type === "click").forEach((entry) => entry.fn({}));
    },
    getBoundingClientRect() {
      return node.rect || { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 };
    },
    querySelector(selector) {
      return node.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const found = [];
      const visit = (current) => {
        for (const child of current.children) {
          if (matches(child, selector)) found.push(child);
          visit(child);
        }
      };
      visit(node);
      return found;
    },
    getContext() {
      return makeContext();
    },
    showModal() {
      node.open = true;
    },
    close() {
      node.open = false;
      node.listeners.filter((entry) => entry.type === "close").forEach((entry) => entry.fn({}));
    },
  };
  node.classList = createClassList();
  return node;
}

function matches(node, selector) {
  return selector.split(",").some((part) => matchesCompound(node, part.trim()));
}

function matchesCompound(node, compound) {
  const parts = compound.split(/\s+/).filter(Boolean);
  if (!matchesSimple(node, parts[parts.length - 1])) return false;
  let ancestor = node.parentNode;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (ancestor && !matchesSimple(ancestor, parts[index])) ancestor = ancestor.parentNode;
    if (!ancestor) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}

function matchesSimple(node, selector) {
  if (selector.startsWith("#")) return node.id === selector.slice(1);
  if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
  if (selector.startsWith("[")) {
    const name = selector.slice(1, -1);
    return name.startsWith("data-")
      ? node.dataset[name.slice(5)] !== undefined
      : node.getAttribute(name) !== null;
  }
  return node.tagName === selector.toUpperCase();
}

function add(parent, tag, className = "", props = {}) {
  const node = createNode(tag);
  if (className) node.className = className;
  Object.assign(node, props);
  parent.append(node);
  return node;
}

function buildPage() {
  const root = createNode("div");
  root.className = "fos-awaken";
  const canvas = add(root, "canvas");
  canvas.id = "universe";
  const header = add(root, "header");
  add(header, "nav", "topnav");
  add(header, "button", "motion", { id: "motion", textContent: "Ⅱ" });
  const progress = add(header, "div", "progress");
  add(progress, "i");
  const rail = add(root, "nav", "rail");
  for (let index = 0; index < 4; index += 1) add(rail, "a");

  const hero = add(root, "section", "chapter hero", {
    id: "home",
    offsetTop: 0,
    offsetHeight: 1600,
  });
  add(hero, "div", "scene", { offsetHeight: 800 });
  const copy = add(hero, "div", "hero-copy");
  add(copy, "span", "", { dataset: { intro: "eyebrow" } });
  add(copy, "a", "meet", { dataset: { intro: "meet" }, attrs: { href: "#intelligence" } });
  add(hero, "div", "hero-index");
  add(hero, "div", "orb-note");
  add(hero, "div", "core-label");
  add(hero, "div", "hero-bottom");
  add(hero, "h1", "", { id: "hero-title" });
  const opening = add(hero, "div", "opening", { id: "opening", hidden: true });
  add(opening, "span", "", { id: "opening-phase" });
  add(opening, "b", "", { id: "opening-second" });
  add(opening, "i", "", { id: "opening-progress" });
  add(opening, "button", "opening-skip", { id: "skip-intro" });

  const intelligence = add(root, "section", "chapter intelligence", {
    id: "intelligence",
    offsetTop: 1600,
    offsetHeight: 4200,
  });
  add(intelligence, "div", "scene", { offsetHeight: 800 });
  add(intelligence, "div", "section-title");
  add(intelligence, "div", "", { id: "panels" });
  add(intelligence, "div", "mind-label");
  const track = add(intelligence, "div", "track");
  add(track, "span", "", { id: "count" });
  add(track, "span", "", { id: "cap-name" });
  add(track, "div", "segments");

  const freedom = add(root, "section", "chapter freedom", {
    id: "freedom",
    offsetTop: 5800,
    offsetHeight: 1800,
  });
  add(freedom, "div", "scene", { offsetHeight: 800 });
  add(freedom, "div", "freedom-copy");
  add(freedom, "div", "principles");
  add(freedom, "div", "flag-caption");
  add(freedom, "a", "next");

  const entry = add(root, "section", "chapter entry", {
    id: "entry",
    offsetTop: 7600,
    offsetHeight: 1400,
    rect: { left: 0, top: 4200, width: 800, height: 700, right: 800, bottom: 4900 },
  });
  add(entry, "div", "entry-space", {
    rect: { left: 120, top: 80, width: 360, height: 280, right: 480, bottom: 360 },
  });

  const dialog = add(root, "dialog", "", { id: "detail" });
  add(dialog, "button", "close");
  add(dialog, "button", "back");
  add(dialog, "p", "", { id: "detail-kicker" });
  add(dialog, "h2", "", { id: "detail-title" });
  add(dialog, "p", "detail-copy");
  add(dialog, "small", "", { id: "example-label" });
  add(dialog, "p", "", { id: "example-text" });
  return root;
}

function installGlobals({ reduced = false, hash = "", restored = false } = {}) {
  const saved = {};
  const frames = new Map();
  const timers = new Map();
  let frameId = 0;
  let clock = 0;
  const scrolls = [];
  const media = {
    matches: reduced,
    addEventListener(type, fn) {
      media.listeners.push({ type, fn });
    },
    removeEventListener(type, fn) {
      media.listeners = media.listeners.filter((entry) => entry.fn !== fn || entry.type !== type);
    },
    listeners: [],
  };
  const documentNode = {
    hidden: false,
    activeElement: null,
    documentElement: {
      style: {},
      scrollHeight: 12000,
      classList: createClassList(),
    },
    body: { style: {}, classList: createClassList() },
    listeners: [],
    addEventListener(type, fn, options) {
      documentNode.listeners.push({ type, fn, options });
    },
    removeEventListener(type, fn) {
      documentNode.listeners = documentNode.listeners.filter(
        (entry) => entry.type !== type || entry.fn !== fn
      );
    },
  };
  const windowNode = {
    devicePixelRatio: 2,
    innerWidth: 1280,
    innerHeight: 800,
    scrollY: 0,
    location: { hash },
    matchMedia: () => media,
    scrollTo({ top }) {
      scrolls.push(top);
      windowNode.scrollY = top;
    },
    listeners: [],
    addEventListener(type, fn, options) {
      windowNode.listeners.push({ type, fn, options });
    },
    removeEventListener(type, fn) {
      windowNode.listeners = windowNode.listeners.filter(
        (entry) => entry.type !== type || entry.fn !== fn
      );
    },
    requestAnimationFrame(callback) {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    setTimeout(callback) {
      frameId += 1;
      timers.set(frameId, callback);
      return frameId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const performanceNode = {
    now: () => clock,
    getEntriesByType: () => [{ type: restored ? "back_forward" : "navigate" }],
  };
  for (const [key, value] of Object.entries({
    window: windowNode,
    document: documentNode,
    performance: performanceNode,
  })) {
    saved[key] = globalThis[key];
    globalThis[key] = value;
  }
  return {
    media,
    scrolls,
    window: windowNode,
    document: documentNode,
    step(ms) {
      clock = ms;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(clock);
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

test("the six second opening keeps the prototype reveal curve", () => {
  assert.equal(OPENING_DURATION, 6000);
  const start = openingAt(0);
  assert.equal(start.p, 0);
  assert.equal(start.eyebrow, 0);
  assert.equal(start.bolt, 0);
  const middle = openingAt(3000);
  assert.equal(middle.p, 0.5);
  assert.ok(middle.wake > 0.9);
  assert.ok(middle.bolt > 0.9);
  const done = openingAt(6000);
  assert.equal(done.p, 1);
  assert.equal(done.size, 1);
  assert.equal(done.meet, 1);
  assert.equal(done.backdrop, 1);
  assert.match(sceneSource, /let seed=81/);
  assert.match(sceneSource, /\{length:52\}/);
  assert.match(sceneSource, /length:100/);
  assert.doesNotMatch(sceneSource, /DESIGN PREVIEW|No information was sent/);
  assert.equal(sceneSource.split("requestAnimationFrame").length - 1, 2);
});

test("a fresh load plays once, then a remount continues instead of replaying", () => {
  const env = installGlobals();
  try {
    const first = mountAwakeningScene(buildPage(), {});
    assert.equal(first.inspect().introDone, false);
    assert.equal(first.inspect().introElapsed, 0);
    assert.equal(first.inspect().strands, 52);
    assert.equal(first.inspect().stars, 100);
    assert.equal(env.pendingFrames(), 1);
    env.step(16);
    env.step(6016);
    assert.equal(first.inspect().introDone, true);
    assert.equal(first.inspect().introElapsed, 6000);
    assert.equal(readAwakeningSession().introDone, true);
    env.window.scrollY = 0;
    env.window.listeners.find((entry) => entry.type === "scroll").fn();
    assert.equal(first.inspect().introElapsed, 6000);

    const second = mountAwakeningScene(buildPage(), {});
    assert.equal(second.inspect().introDone, true);
    assert.equal(second.inspect().introElapsed, 6000);
    assert.equal(env.pendingFrames(), 1);
    second.destroy();
    assert.equal(env.pendingFrames(), 0);
    assert.equal(env.window.listeners.length, 0);
    assert.equal(env.document.listeners.length, 0);
    assert.equal(env.document.documentElement.style.overflowY ?? "", "");
  } finally {
    resetAwakeningSessionForTests();
    env.restore();
  }
});

test("skip, pause, hidden tabs, reduced motion, and login deep links stay immediate", () => {
  const playing = installGlobals();
  try {
    const root = buildPage();
    const live = mountAwakeningScene(root, {});
    playing.step(16);
    playing.step(1216);
    assert.ok(live.inspect().introElapsed >= 1200);
    assert.equal(live.inspect().introDone, false);
    root.querySelector("#motion").click();
    const pausedAt = live.inspect().introElapsed;
    playing.step(1800);
    assert.equal(live.inspect().paused, true);
    assert.equal(live.inspect().introElapsed, pausedAt);
    root.querySelector("#motion").click();
    playing.document.hidden = true;
    playing.document.listeners.find((entry) => entry.type === "visibilitychange").fn();
    assert.equal(playing.pendingFrames(), 0);
    playing.document.hidden = false;
    playing.document.listeners.find((entry) => entry.type === "visibilitychange").fn();
    root.querySelector("#skip-intro").click();
    assert.equal(live.inspect().introDone, true);
    assert.equal(live.inspect().introElapsed, 6000);
    assert.equal(root.classList.contains("intro-active"), false);
  } finally {
    resetAwakeningSessionForTests();
    playing.restore();
  }

  const reduced = installGlobals({ reduced: true });
  try {
    const scene = mountAwakeningScene(buildPage(), {});
    assert.equal(scene.inspect().introDone, true);
    assert.equal(scene.inspect().paused, true);
    assert.equal(scene.inspect().introElapsed, 6000);
  } finally {
    resetAwakeningSessionForTests();
    reduced.restore();
  }

  const deepLink = installGlobals();
  try {
    const scene = mountAwakeningScene(buildPage(), { skipIntro: true, scrollToEntry: true });
    assert.equal(scene.inspect().introDone, true);
    assert.ok(deepLink.scrolls.length > 0);
    assert.ok(deepLink.scrolls[0] > 1000);
  } finally {
    resetAwakeningSessionForTests();
    deepLink.restore();
  }
});

test("the public page still opens after the top header is removed", () => {
  const env = installGlobals();
  try {
    const root = buildPage();
    root.children = root.children.filter((child) => child.tagName !== "HEADER");
    const scene = mountAwakeningScene(root, { skipIntro: true });
    assert.equal(scene.inspect().introDone, true);
    assert.equal(root.querySelector("#motion"), null);
    assert.equal(root.querySelector(".topnav"), null);
    env.step(32);
    assert.equal(scene.inspect().paused, false);
  } finally {
    resetAwakeningSessionForTests();
    env.restore();
  }
});
