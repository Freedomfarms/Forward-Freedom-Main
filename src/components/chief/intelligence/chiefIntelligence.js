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

// Independent orbits. speed sign is direction. tiltX / tiltZ are radians.
// wobble keeps the path from reading as a perfect ellipse.
export const ORBITS = Object.freeze([
  Object.freeze({
    radius: 0.58,
    tiltX: 0.35,
    tiltZ: 0.15,
    speed: 0.11,
    width: 1.6,
    alpha: 0.95,
    wobble: 0.045,
    phase: 0.2,
    color: Object.freeze([255, 236, 214]),
    sparks: 1,
  }),
  Object.freeze({
    radius: 0.66,
    tiltX: 1.05,
    tiltZ: 0.55,
    speed: -0.08,
    width: 1.8,
    alpha: 0.8,
    wobble: 0.06,
    phase: 1.4,
    color: Object.freeze([236, 214, 255]),
    sparks: 2,
  }),
  Object.freeze({
    radius: 0.72,
    tiltX: 0.72,
    tiltZ: -1.15,
    speed: 0.07,
    width: 1.45,
    alpha: 0.78,
    wobble: 0.07,
    phase: 2.2,
    color: Object.freeze([255, 228, 246]),
    sparks: 1,
  }),
  Object.freeze({
    radius: 0.78,
    tiltX: 1.35,
    tiltZ: 0.25,
    speed: -0.055,
    width: 2,
    alpha: 0.7,
    wobble: 0.055,
    phase: 0.8,
    color: Object.freeze([186, 130, 255]),
    sparks: 2,
  }),
  Object.freeze({
    radius: 0.84,
    tiltX: 0.18,
    tiltZ: 0.95,
    speed: 0.046,
    width: 1.35,
    alpha: 0.66,
    wobble: 0.05,
    phase: 3.1,
    color: Object.freeze([255, 244, 255]),
    sparks: 1,
  }),
  Object.freeze({
    radius: 0.9,
    tiltX: 1.55,
    tiltZ: -0.45,
    speed: -0.038,
    width: 1.2,
    alpha: 0.55,
    wobble: 0.065,
    phase: 4.4,
    color: Object.freeze([168, 112, 236]),
    sparks: 1,
  }),
  Object.freeze({
    radius: 0.96,
    tiltX: 0.95,
    tiltZ: 1.7,
    speed: 0.03,
    width: 1.05,
    alpha: 0.42,
    wobble: 0.04,
    phase: 5.2,
    color: Object.freeze([210, 186, 255]),
    sparks: 1,
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

export const NEBULA = Object.freeze([
  Object.freeze({ x: -0.42, y: 0.08, r: 0.95, drift: 0.08, color: Object.freeze([42, 8, 78]) }),
  Object.freeze({ x: 0.46, y: -0.12, r: 0.8, drift: 0.06, color: Object.freeze([24, 6, 52]) }),
  Object.freeze({ x: 0.02, y: 0.28, r: 0.62, drift: 0.1, color: Object.freeze([68, 18, 112]) }),
  Object.freeze({ x: -0.12, y: -0.34, r: 0.58, drift: 0.07, color: Object.freeze([32, 6, 64]) }),
  Object.freeze({ x: 0.2, y: 0.02, r: 0.4, drift: 0.12, color: Object.freeze([90, 30, 150]) }),
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

export function projectRing(orbit, angle, radiusScale = 1) {
  const radius = orbit.radius * radiusScale;
  const x = Math.cos(angle) * radius;
  const z0 = Math.sin(angle) * radius;
  const cosX = Math.cos(orbit.tiltX);
  const sinX = Math.sin(orbit.tiltX);
  const y1 = -z0 * sinX;
  const z1 = z0 * cosX;
  const cosZ = Math.cos(orbit.tiltZ);
  const sinZ = Math.sin(orbit.tiltZ);
  const x2 = x * cosZ - y1 * sinZ;
  const y2 = x * sinZ + y1 * cosZ;
  const perspective = 1 / (1.18 - z1 * 0.28);
  return { x: x2 * perspective, y: y2 * perspective, z: z1 };
}

export function sampleRing(orbit, time, motion, steps = 80) {
  const spin = time * orbit.speed * (Number(motion?.speed) || 0);
  const points = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2 + spin;
    const wobble = 1 + Math.sin(angle * 3 + orbit.phase) * orbit.wobble;
    points.push(projectRing(orbit, angle, wobble));
  }
  return points;
}

export function sparkAngles(orbit, time, motion) {
  const count = orbit.sparks || 0;
  const angles = [];
  const spin = time * orbit.speed * (Number(motion?.speed) || 0) * 1.35;
  for (let index = 0; index < count; index += 1) {
    angles.push(spin + orbit.phase + (index * Math.PI * 2) / count);
  }
  return angles;
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
    alpha: (0.12 + seedC * 0.5) * activity,
    size: 0.55 + seedA * 1.35,
  };
}

export const AMBIENT_COUNT = 64;
export const EASE = 0.06;
