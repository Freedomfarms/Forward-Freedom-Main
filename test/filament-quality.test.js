import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPT_COOLDOWN,
  FRAME_WARMUP,
  PREMIUM_DPR_CAP,
  SLOW_FRAME_LIMIT,
  SLOW_FRAME_MS,
  createQualityState,
  isSoftwareRenderer,
  nextEffectiveCap,
  observeFrame,
} from "../src/visual/chiefIntelligence/filamentQuality.js";

test("hardware and unknown renderers keep the approved desktop quality", () => {
  for (const name of [
    "",
    "WebKit WebGL",
    "Apple GPU",
    "ANGLE (Apple, Apple M1, OpenGL 4.1)",
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (Intel, Intel(R) UHD Graphics (0x00009A78) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6)",
  ]) {
    const state = createQualityState(name);
    assert.equal(isSoftwareRenderer(name), false, name);
    assert.equal(state.antialias, true, name);
    assert.equal(state.dprCap, PREMIUM_DPR_CAP, name);
  }
});

test("software renderers start without multisampling and without a retina buffer", () => {
  for (const name of [
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "llvmpipe (LLVM 15.0.7, 256 bits)",
    "softpipe",
    "Microsoft Basic Render Driver",
  ]) {
    const state = createQualityState(name);
    assert.equal(isSoftwareRenderer(name), true, name);
    assert.equal(state.antialias, false, name);
    assert.equal(state.dprCap, 1, name);
  }
});

test("the buffer cap steps once, skips caps the screen cannot use, and does not bounce back", () => {
  assert.equal(nextEffectiveCap(1.5, 2), 1.25);
  assert.equal(nextEffectiveCap(1.5, 1), 0.75);
  assert.equal(nextEffectiveCap(1, 1), 0.75);
  assert.equal(nextEffectiveCap(0.5, 2), 0.5);

  const desktop = createQualityState("NVIDIA GeForce");
  for (let i = 0; i < FRAME_WARMUP; i += 1) {
    assert.equal(observeFrame(desktop, 80, 2), false);
  }
  for (let i = 0; i < SLOW_FRAME_LIMIT - 1; i += 1) {
    assert.equal(observeFrame(desktop, SLOW_FRAME_MS + 5, 2), false);
  }
  assert.equal(observeFrame(desktop, 18, 2), false);
  assert.equal(desktop.slowFrames, 0);
  desktop.slowFrames = 5;
  assert.equal(observeFrame(desktop, 16, 2, false), false);
  assert.equal(desktop.slowFrames, 5);
  assert.equal(observeFrame(desktop, 16, 2, true), false);
  assert.equal(desktop.slowFrames, 0);
  for (let i = 0; i < SLOW_FRAME_LIMIT - 1; i += 1) {
    observeFrame(desktop, 55, 2);
  }
  assert.equal(observeFrame(desktop, 55, 2), true);
  assert.equal(desktop.dprCap, 1.25);
  assert.equal(desktop.adaptations, 1);

  for (let i = 0; i < ADAPT_COOLDOWN; i += 1) {
    assert.equal(observeFrame(desktop, 55, 2), false);
  }
  assert.equal(desktop.dprCap, 1.25);

  const oneToOne = createQualityState("NVIDIA GeForce");
  oneToOne.warmup = 0;
  for (let i = 0; i < SLOW_FRAME_LIMIT; i += 1) observeFrame(oneToOne, 70, 1);
  assert.equal(oneToOne.dprCap, 0.75);

  const floor = createQualityState("SwiftShader");
  floor.warmup = 0;
  floor.dprCap = 0.5;
  for (let i = 0; i < SLOW_FRAME_LIMIT + 2; i += 1) {
    assert.equal(observeFrame(floor, 90, 2), false);
  }
  assert.equal(floor.dprCap, 0.5);
  assert.equal(floor.adaptations, 0);
});
