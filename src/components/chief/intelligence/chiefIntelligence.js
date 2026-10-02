// Motion model for the CHIEF room intelligence. No DOM and no network.
// The entry-gateway diamond stays in chiefField.js. This module is the room only.
//
// Text status and voice share this one state system. `phase` selects a preset
// directly. `amplitude` is optional: null means no audio meter is connected,
// and the speaking preset supplies the pulse. A later voice path passes 0–1
// into the same core. There is no second visual behavior for voice.

import { fieldKindForStatus } from "../../../utils/chiefRoom.js";

export const CHIEF_VISUAL = Object.freeze({
  IDLE: "idle",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking",
  APPROVAL: "approval",
  ERROR: "error",
});

const MOTION_KEYS = [
  "speed",
  "intensity",
  "glow",
  "particle",
  "pulse",
  "wave",
  "outflow",
  "density",
  "organize",
  "flicker",
  "spin",
  "body",
  "contract",
];

// speed is the shared clock. Speaking stays at least 2.9× idle.
// pulse is core radius travel, not opacity.
// body is the resting scale. contract pulls particles inward.
// outflow sends energy out from the nucleus. wave is internal current strength.
const PRESETS = Object.freeze({
  idle: Object.freeze({
    speed: 1,
    intensity: 0.72,
    glow: 0.62,
    particle: 0.55,
    pulse: 0.012,
    wave: 0.85,
    outflow: 0.12,
    density: 0.84,
    organize: 0.22,
    flicker: 0.7,
    spin: 0.28,
    body: 1,
    contract: 0.08,
  }),
  listening: Object.freeze({
    speed: 1.45,
    intensity: 0.82,
    glow: 0.74,
    particle: 0.68,
    pulse: 0.034,
    wave: 1,
    outflow: 0.05,
    density: 0.88,
    organize: 0.9,
    flicker: 0.18,
    spin: 0.2,
    body: 1.035,
    contract: 0.55,
  }),
  thinking: Object.freeze({
    speed: 2.05,
    intensity: 0.92,
    glow: 0.9,
    particle: 0.9,
    pulse: 0.02,
    wave: 1.25,
    outflow: 0.12,
    density: 1.16,
    organize: 0.38,
    flicker: 0.22,
    spin: 0.86,
    body: 0.955,
    contract: 0.78,
  }),
  speaking: Object.freeze({
    speed: 3,
    intensity: 1,
    glow: 1,
    particle: 1,
    pulse: 0.12,
    wave: 1.45,
    outflow: 1,
    density: 1.04,
    organize: 0.52,
    flicker: 0.1,
    spin: 0.34,
    body: 1.02,
    contract: 0.04,
  }),
  approval: Object.freeze({
    speed: 0.82,
    intensity: 0.66,
    glow: 0.56,
    particle: 0.4,
    pulse: 0.01,
    wave: 0.7,
    outflow: 0.08,
    density: 0.74,
    organize: 0.3,
    flicker: 0.12,
    spin: 0.16,
    body: 0.98,
    contract: 0.12,
  }),
  error: Object.freeze({
    speed: 0.4,
    intensity: 0.4,
    glow: 0.3,
    particle: 0.22,
    pulse: 0,
    wave: 0.35,
    outflow: 0,
    density: 0.55,
    organize: 0.08,
    flicker: 0.04,
    spin: 0.06,
    body: 0.94,
    contract: 0.2,
  }),
});

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

// Resting size lives on `body`. This is only the breath around that size.
// Null amplitude uses the full preset pulse. 0 holds the core still.
export function coreScale(time, motion, amplitude) {
  const pulse = Number(motion?.pulse) || 0;
  if (pulse <= 0) return 1;
  const amp = resolveAmplitude(amplitude);
  const depth = amp == null ? 1 : amp;
  if (pulse < 0.04) return 1 + Math.sin(time * 0.42) * pulse * depth;
  return 1 + organicWave(time) * pulse * depth;
}

function unitHash(index) {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

// Most particles sit inside the core. A thin near shell and a sparse outer
// dusting support it. Radii are in core-local units, where 1 is the body edge.
export const CORE_PARTICLE_COUNT = 4800;

export function createCoreParticles(count = CORE_PARTICLE_COUNT) {
  const total = Math.max(1, count | 0);
  const directions = new Float32Array(total * 3);
  const radii = new Float32Array(total);
  const seeds = new Float32Array(total * 4);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < total; index += 1) {
    const shellRoll = unitHash(index + 1);
    let shell = 0;
    let radius = 0.08 + Math.pow(unitHash(index + 3), 1.2) * 0.68;
    if (shellRoll >= 0.82 && shellRoll < 0.95) {
      shell = 1;
      radius = 0.84 + unitHash(index + 5) * 0.14;
    } else if (shellRoll >= 0.95) {
      shell = 2;
      radius = 1.18 + unitHash(index + 7) * 0.42;
    }
    const y = total === 1 ? 0 : 1 - (index / (total - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * index;
    directions[index * 3] = Math.cos(theta) * ring;
    directions[index * 3 + 1] = y;
    directions[index * 3 + 2] = Math.sin(theta) * ring;
    radii[index] = radius;
    seeds[index * 4] = unitHash(index + 11);
    seeds[index * 4 + 1] = unitHash(index + 13) * 2 - 1;
    seeds[index * 4 + 2] = 0.35 + unitHash(index + 17) * 0.9;
    seeds[index * 4 + 3] = shell;
  }
  return { directions, radii, seeds, count: total };
}

export const EASE = 0.06;
