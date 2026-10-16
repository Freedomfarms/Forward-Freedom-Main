import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPT_COOLDOWN,
  DPR_FLOOR,
  FRAME_WARMUP,
  PREMIUM_DPR_CAP,
  SLOW_FRAME_LIMIT,
  SLOW_FRAME_MS,
  SUSPENDED_FRAME_MS,
  createQualityState,
  drawingBufferSize,
  isSoftwareRenderer,
  measureFrame,
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

test("drawing buffers use the css size once at desktop, phone, and after rotation", () => {
  const desktop = drawingBufferSize(1920, 1080, 1, 1.5);
  assert.deepEqual([desktop.dpr, desktop.bufferWidth, desktop.bufferHeight], [1, 1920, 1080]);
  const retina = drawingBufferSize(1920, 1080, 2, 1.5);
  assert.deepEqual([retina.dpr, retina.bufferWidth, retina.bufferHeight], [1.5, 2880, 1620]);
  const phone = drawingBufferSize(390, 844, 3, 1.5);
  assert.deepEqual([phone.dpr, phone.bufferWidth, phone.bufferHeight], [1.5, 585, 1266]);
  const turned = drawingBufferSize(844, 390, 3, 1.5);
  assert.deepEqual([turned.bufferWidth, turned.bufferHeight], [1266, 585]);

  const fractional = drawingBufferSize(390.4, 844.6, 3, 0.75);
  const again = drawingBufferSize(fractional.cssWidth, fractional.cssHeight, 3, 0.75);
  assert.deepEqual(again, fractional);
  assert.deepEqual([fractional.cssWidth, fractional.cssHeight], [390, 845]);
  assert.equal(fractional.bufferWidth, Math.floor(390 * 0.75));
  assert.equal(fractional.bufferHeight, Math.floor(845 * 0.75));
  assert.notEqual(fractional.bufferWidth, Math.floor(fractional.bufferWidth * 0.75));
});

test("an approved hardware name still steps down to the floor and does not recover", () => {
  const hardware = createQualityState("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11)");
  assert.equal(hardware.antialias, true);
  assert.equal(hardware.dprCap, PREMIUM_DPR_CAP);
  hardware.warmup = 0;
  const seen = [hardware.dprCap];
  while (hardware.dprCap > DPR_FLOOR) {
    const before = hardware.dprCap;
    for (let i = 0; i < SLOW_FRAME_LIMIT - 1; i += 1) {
      assert.equal(observeFrame(hardware, 70, 2), false);
    }
    assert.equal(observeFrame(hardware, 70, 2), true);
    assert.ok(hardware.dprCap < before);
    seen.push(hardware.dprCap);
    for (let i = 0; i < 30; i += 1) observeFrame(hardware, 12, 2, true);
    assert.equal(hardware.dprCap, seen.at(-1));
  }
  assert.deepEqual(seen, [1.5, 1.25, 1, 0.75, 0.5]);
  assert.equal(observeFrame(hardware, 90, 3), false);
  assert.equal(hardware.adaptations, 4);
});

test("warmup, the 12-frame streak, and cooldown ignore spikes and suspension", () => {
  assert.equal(measureFrame(0, 80, true), null);
  assert.equal(measureFrame(SUSPENDED_FRAME_MS, 20, false), null);
  assert.equal(measureFrame(16, 1500, true), null);
  assert.deepEqual(measureFrame(16, null, false), { sample: 16, confirmed: true });
  assert.deepEqual(measureFrame(16, null, true), { sample: 16, confirmed: false });
  assert.deepEqual(measureFrame(16, 55, true), { sample: 55, confirmed: true });

  const state = createQualityState("Apple GPU");
  for (let i = 0; i < FRAME_WARMUP; i += 1) observeFrame(state, 200, 2);
  assert.equal(state.dprCap, PREMIUM_DPR_CAP);

  for (let burst = 0; burst < 5; burst += 1) {
    for (let i = 0; i < SLOW_FRAME_LIMIT - 1; i += 1) observeFrame(state, 80, 2, true);
    observeFrame(state, 12, 2, true);
  }
  assert.equal(state.dprCap, PREMIUM_DPR_CAP);

  const noTimer = createQualityState("Apple GPU");
  noTimer.warmup = 0;
  for (let i = 0; i < 40; i += 1) {
    observeFrame(
      noTimer,
      i % 3 === 0 ? 80 : 16,
      2,
      measureFrame(i % 3 === 0 ? 80 : 16, null, false).confirmed
    );
  }
  assert.equal(noTimer.dprCap, PREMIUM_DPR_CAP);

  for (let i = 0; i < SLOW_FRAME_LIMIT; i += 1) observeFrame(state, 80, 2, true);
  assert.equal(state.dprCap, 1.25);
  const duringCooldown = state.dprCap;
  for (let i = 0; i < ADAPT_COOLDOWN; i += 1) observeFrame(state, 80, 2, true);
  assert.equal(state.dprCap, duringCooldown);
});
