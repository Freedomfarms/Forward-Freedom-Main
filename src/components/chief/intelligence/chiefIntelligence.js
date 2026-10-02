// Motion model for the CHIEF room intelligence. No DOM and no network.
// The entry-gateway diamond stays in chiefField.js. This module is the room only.
//
// `amplitude` is optional. Null means no audio meter is connected, and the
// speaking preset supplies the pulse. A later voice path can pass 0–1.

import { fieldKindForStatus } from "../../../utils/chiefRoom.js";

export const CHIEF_VISUAL = Object.freeze({
  IDLE: "idle",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking",
  APPROVAL: "approval",
  ERROR: "error",
});

const MOTION_KEYS = ["speed", "intensity", "glow", "particle", "pulse", "wave"];

// speed is the environmental clock. Speaking is 3× idle.
// pulse is core radius travel, not opacity.
// wave, particle, and glow scale those layers without a second clock.
const PRESETS = Object.freeze({
  idle: Object.freeze({
    speed: 1,
    intensity: 0.72,
    glow: 0.62,
    particle: 0.42,
    pulse: 0.012,
    wave: 0.85,
  }),
  listening: Object.freeze({
    speed: 1.45,
    intensity: 0.82,
    glow: 0.74,
    particle: 0.62,
    pulse: 0.034,
    wave: 1,
  }),
  thinking: Object.freeze({
    speed: 2.05,
    intensity: 0.9,
    glow: 0.86,
    particle: 0.88,
    pulse: 0.02,
    wave: 1.25,
  }),
  speaking: Object.freeze({
    speed: 3,
    intensity: 1,
    glow: 1,
    particle: 1,
    pulse: 0.12,
    wave: 1.65,
  }),
  approval: Object.freeze({
    speed: 0.82,
    intensity: 0.66,
    glow: 0.56,
    particle: 0.36,
    pulse: 0.01,
    wave: 0.7,
  }),
  error: Object.freeze({
    speed: 0.4,
    intensity: 0.4,
    glow: 0.3,
    particle: 0.18,
    pulse: 0,
    wave: 0.35,
  }),
});

// Seven independent field lines. They are deliberately asymmetric: every
// ribbon has a different footprint, center, depth wave, deformation, and flow
// direction. A frozen frame should read as plasma, not nested ellipses.
export const ENERGY_RIBBONS = Object.freeze([
  Object.freeze({
    radiusX: 0.66,
    radiusY: 0.56,
    offsetX: -0.04,
    offsetY: -0.01,
    tilt: 0.36,
    pitch: 0.54,
    depth: 0.28,
    depthFrequency: 1,
    speed: 0.11,
    width: 1.65,
    alpha: 1,
    turbulence: 0.075,
    harmonic: 3,
    phase: 0.2,
    color: Object.freeze([255, 190, 224]),
    nodes: 2,
  }),
  Object.freeze({
    radiusX: 0.62,
    radiusY: 0.72,
    offsetX: 0.04,
    offsetY: 0.02,
    tilt: -0.48,
    pitch: 0.78,
    depth: 0.34,
    depthFrequency: 1,
    speed: -0.082,
    width: 1.95,
    alpha: 0.9,
    turbulence: 0.105,
    harmonic: 4,
    phase: 1.35,
    color: Object.freeze([238, 218, 255]),
    nodes: 2,
  }),
  Object.freeze({
    radiusX: 0.78,
    radiusY: 0.52,
    offsetX: 0.02,
    offsetY: -0.05,
    tilt: 0.86,
    pitch: 0.5,
    depth: 0.26,
    depthFrequency: 2,
    speed: 0.068,
    width: 0.85,
    alpha: 0.55,
    turbulence: 0.09,
    harmonic: 5,
    phase: 2.25,
    color: Object.freeze([255, 222, 182]),
    nodes: 1,
  }),
  Object.freeze({
    radiusX: 0.68,
    radiusY: 0.7,
    offsetX: -0.025,
    offsetY: 0.05,
    tilt: 1.32,
    pitch: 0.72,
    depth: 0.36,
    depthFrequency: 1,
    speed: -0.056,
    width: 2.1,
    alpha: 0.8,
    turbulence: 0.12,
    harmonic: 3,
    phase: 0.78,
    color: Object.freeze([190, 128, 255]),
    nodes: 2,
  }),
  Object.freeze({
    radiusX: 0.86,
    radiusY: 0.66,
    offsetX: -0.05,
    offsetY: 0.035,
    tilt: -1.02,
    pitch: 0.9,
    depth: 0.33,
    depthFrequency: 1,
    speed: 0.045,
    width: 1.25,
    alpha: 0.72,
    turbulence: 0.08,
    harmonic: 6,
    phase: 3.12,
    color: Object.freeze([255, 244, 255]),
    nodes: 1,
  }),
  Object.freeze({
    radiusX: 0.72,
    radiusY: 0.82,
    offsetX: 0.055,
    offsetY: -0.02,
    tilt: 0.48,
    pitch: 1,
    depth: 0.38,
    depthFrequency: 2,
    speed: -0.037,
    width: 0.75,
    alpha: 0.42,
    turbulence: 0.11,
    harmonic: 4,
    phase: 4.38,
    color: Object.freeze([170, 108, 236]),
    nodes: 1,
  }),
  Object.freeze({
    radiusX: 0.94,
    radiusY: 0.72,
    offsetX: 0.01,
    offsetY: 0.03,
    tilt: -0.24,
    pitch: 0.52,
    depth: 0.3,
    depthFrequency: 1,
    speed: 0.029,
    width: 0.65,
    alpha: 0.32,
    turbulence: 0.095,
    harmonic: 5,
    phase: 5.16,
    color: Object.freeze([214, 184, 255]),
    nodes: 1,
  }),
]);

export const WAVES = Object.freeze([
  Object.freeze({
    y: -0.04,
    amp: 0.15,
    freq: 1.15,
    speed: 0.18,
    layer: "back",
    alpha: 0.42,
    width: 1.7,
  }),
  Object.freeze({
    y: 0.1,
    amp: 0.26,
    freq: 0.72,
    speed: -0.14,
    layer: "back",
    alpha: 0.28,
    width: 2.3,
  }),
  Object.freeze({
    y: -0.2,
    amp: 0.1,
    freq: 1.7,
    speed: 0.24,
    layer: "back",
    alpha: 0.2,
    width: 1.1,
  }),
  Object.freeze({
    y: 0.02,
    amp: 0.08,
    freq: 2.1,
    speed: 0.32,
    layer: "front",
    alpha: 0.34,
    width: 1.15,
  }),
  Object.freeze({
    y: -0.16,
    amp: 0.18,
    freq: 0.9,
    speed: -0.12,
    layer: "front",
    alpha: 0.22,
    width: 1.45,
  }),
  Object.freeze({
    y: 0.24,
    amp: 0.14,
    freq: 1.35,
    speed: 0.16,
    layer: "front",
    alpha: 0.16,
    width: 1,
  }),
]);

export const PLASMA_LAYERS = Object.freeze([
  Object.freeze({
    x: -0.58,
    y: -0.08,
    radiusX: 0.78,
    radiusY: 0.5,
    phase: 0.4,
    drift: 0.045,
    alpha: 0.24,
    color: Object.freeze([76, 20, 138]),
  }),
  Object.freeze({
    x: 0.56,
    y: 0.02,
    radiusX: 0.72,
    radiusY: 0.62,
    phase: 1.7,
    drift: -0.038,
    alpha: 0.22,
    color: Object.freeze([96, 28, 164]),
  }),
  Object.freeze({
    x: -0.18,
    y: 0.48,
    radiusX: 0.9,
    radiusY: 0.42,
    phase: 2.8,
    drift: 0.052,
    alpha: 0.2,
    color: Object.freeze([64, 14, 120]),
  }),
  Object.freeze({
    x: 0.12,
    y: -0.5,
    radiusX: 0.82,
    radiusY: 0.38,
    phase: 4.1,
    drift: -0.042,
    alpha: 0.17,
    color: Object.freeze([112, 34, 174]),
  }),
  Object.freeze({
    x: 0.36,
    y: 0.3,
    radiusX: 0.58,
    radiusY: 0.44,
    phase: 5.2,
    drift: 0.061,
    alpha: 0.15,
    color: Object.freeze([164, 58, 194]),
  }),
  Object.freeze({
    x: -0.24,
    y: 0.04,
    radiusX: 0.48,
    radiusY: 0.3,
    phase: 0.96,
    drift: -0.07,
    alpha: 0.17,
    color: Object.freeze([142, 42, 202]),
  }),
  Object.freeze({
    x: 0.22,
    y: -0.09,
    radiusX: 0.42,
    radiusY: 0.28,
    phase: 3.72,
    drift: 0.075,
    alpha: 0.14,
    color: Object.freeze([188, 62, 206]),
  }),
]);

export function visualStateForStatus(status) {
  const kind = fieldKindForStatus(status);
  if (kind === "error") return CHIEF_VISUAL.ERROR;
  if (kind === "approval") return CHIEF_VISUAL.APPROVAL;
  if (kind === "responding") return CHIEF_VISUAL.SPEAKING;
  if (kind === "ready") return CHIEF_VISUAL.IDLE;
  return CHIEF_VISUAL.THINKING;
}

export function motionPreset(state) {
  return PRESETS[state] || PRESETS.idle;
}

export function easeMotion(current, target, amount) {
  const next = {};
  const step = amount >= 1 ? 1 : amount;
  for (const key of MOTION_KEYS) {
    const from = Number(current?.[key]) || 0;
    const to = Number(target?.[key]) || 0;
    next[key] = from + (to - from) * step;
  }
  return next;
}

export function resolveAmplitude(amplitude) {
  if (amplitude == null || amplitude === "") return null;
  const value = Number(amplitude);
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function organicWave(time) {
  return Math.sin(time * 2.35) * 0.7 + Math.sin(time * 4.6 + 1.2) * 0.3;
}

// Core scale only. Orbits are not scaled, so the center breathes inside a stable field.
// Null amplitude uses the full preset pulse. 0 holds the core still (a quiet voice later).
export function coreScale(time, motion, amplitude) {
  const pulse = Number(motion?.pulse) || 0;
  if (pulse <= 0) return 1;
  const amp = resolveAmplitude(amplitude);
  const depth = amp == null ? 1 : amp;
  if (pulse < 0.04) return 1 + Math.sin(time * 0.42) * pulse * depth;
  return 1 + organicWave(time) * pulse * depth;
}

export function ribbonPoint(ribbon, parameter, time, motion) {
  const speed = Number(motion?.speed) || 0;
  const flow = time * ribbon.speed * speed;
  const angle = parameter * Math.PI * 2;
  const turbulence = ribbon.turbulence * (0.72 + (Number(motion?.wave) || 0) * 0.2);
  const radial =
    1 +
    Math.sin(angle * ribbon.harmonic + ribbon.phase + flow * 0.8) * turbulence +
    Math.sin(angle * 2 - ribbon.phase * 0.7 - flow * 0.45) * turbulence * 0.55;
  const slip = Math.sin(angle * 3 + ribbon.phase - flow) * turbulence * 0.24;
  const x0 = Math.cos(angle + slip) * ribbon.radiusX * radial + ribbon.offsetX;
  const y0 =
    Math.sin(angle) *
      ribbon.radiusY *
      (1 + Math.cos(angle * (ribbon.harmonic - 1) - flow) * turbulence * 0.58) +
    ribbon.offsetY;
  const z0 =
    Math.sin(angle * ribbon.depthFrequency + ribbon.phase + flow * 0.62) * ribbon.depth +
    Math.cos(angle * 2 - ribbon.phase) * turbulence * 0.8;
  const cosPitch = Math.cos(ribbon.pitch);
  const sinPitch = Math.sin(ribbon.pitch);
  const y1 = y0 * cosPitch - z0 * sinPitch;
  const z1 = y0 * sinPitch + z0 * cosPitch;
  const cosTilt = Math.cos(ribbon.tilt);
  const sinTilt = Math.sin(ribbon.tilt);
  const x2 = x0 * cosTilt - y1 * sinTilt;
  const y2 = x0 * sinTilt + y1 * cosTilt;
  const perspective = 1 / (1.28 - z1 * 0.22);
  return {
    x: x2 * perspective,
    y: y2 * perspective,
    z: z1,
    energy:
      0.58 +
      Math.sin(angle * 3 + ribbon.phase + flow * 1.6) * 0.28 +
      Math.sin(angle * 7 - ribbon.phase - flow * 0.9) * 0.14,
  };
}

export function sampleRibbon(ribbon, time, motion, steps = 112) {
  const points = [];
  for (let index = 0; index <= steps; index += 1) {
    points.push(ribbonPoint(ribbon, index / steps, time, motion));
  }
  return points;
}

export function ribbonNodeParameters(ribbon, time, motion) {
  const count = ribbon.nodes || 0;
  const parameters = [];
  const flow = time * Math.abs(ribbon.speed) * (Number(motion?.speed) || 0) * 0.42;
  for (let index = 0; index < count; index += 1) {
    parameters.push((flow + ribbon.phase / (Math.PI * 2) + index / count) % 1);
  }
  return parameters;
}

function unitHash(index) {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

export function ambientParticle(index, time, motion) {
  const speed = Number(motion?.speed) || 0;
  const activity = Number(motion?.particle) || 0;
  const seedA = unitHash(index + 1);
  const seedB = unitHash(index + 17);
  const seedC = unitHash(index + 43);
  const direction = seedC > 0.5 ? 1 : -1;
  const angle = seedA * Math.PI * 2 + time * (0.025 + seedB * 0.04) * speed * direction;
  const radius = 0.18 + seedB * 0.92;
  const drift = Math.sin(time * 0.12 * speed + seedA * 6.2) * 0.035 * speed;
  return {
    x: Math.cos(angle) * (radius + drift),
    y: Math.sin(angle) * (radius * (0.48 + seedC * 0.55) + drift * 0.6),
    z: seedC * 2 - 1,
    alpha: (0.12 + seedC * 0.5) * activity,
    size: 0.55 + seedA * 1.35,
  };
}

export function intelligenceParticle(index, time, motion, fieldScale = 1) {
  const seedA = unitHash(index + 101);
  const seedB = unitHash(index + 509);
  const seedC = unitHash(index + 911);
  const seedD = unitHash(index + 1301);
  const speed = Number(motion?.speed) || 0;
  const activity = Number(motion?.particle) || 0;
  const angle = seedA * Math.PI * 2;
  const radius = Math.pow(seedB, 1.35) * 0.88 * fieldScale;
  const depth = (seedC * 2 - 1) * (0.42 + radius * 0.85);
  const swirl = time * (0.012 + seedD * 0.024) * speed * (seedC > 0.5 ? 1 : -1);
  const turbulence =
    Math.sin(time * 0.18 * speed + seedD * 11 + radius * 20) * (0.008 + radius * 0.035);
  const lobe = 0.78 + Math.sin(angle * 3 + seedC * 5.2) * 0.2;
  const concentration = 1 - Math.min(1, radius / 0.34);
  const cluster = index % 3;
  const clusterX = (cluster === 0 ? -0.055 : cluster === 1 ? 0.045 : 0.018) * concentration;
  const clusterY = (cluster === 0 ? 0.018 : cluster === 1 ? -0.038 : 0.052) * concentration;
  const micro = seedD < 0.72;
  return {
    x: Math.cos(angle + swirl + depth * 0.34) * (radius * lobe + turbulence) + clusterX,
    y:
      Math.sin(angle + swirl * 0.72) *
        (radius * (0.62 + seedD * 0.26) + turbulence * 0.6) +
      Math.sin(angle * 2 + seedC * 4) * radius * 0.08 +
      clusterY,
    z: depth,
    alpha: (micro ? 0.28 + seedD * 0.46 : 0.48 + seedD * 0.62) * (0.7 + activity * 0.5),
    size: micro
      ? 0.18 + seedA * 0.62
      : 0.62 + seedA * 1.42 + (1 - Math.min(1, radius * 1.35)) * seedC * 0.46,
    warm: seedD > 0.962,
    hot: seedC > 0.88,
  };
}

export const AMBIENT_COUNT = 180;
export const INTELLIGENCE_PARTICLE_COUNT = 3200;
export const EASE = 0.06;
