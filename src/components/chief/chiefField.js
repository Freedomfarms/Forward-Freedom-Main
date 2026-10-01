// Tunable presentation for the Freedom diamond. This is not a physics engine.
// Real CHIEF status selects a preset. Corners stay on the four vertices.
// Change CHIEF_FIELD after seeing the field on screen.

import { fieldKindForStatus } from "../../utils/chiefRoom.js";

export const CHIEF_FIELD = Object.freeze({
  desktopPoints: 420,
  mobilePoints: 180,
  edgePoints: 36,
  ease: 0.08,
  color: Object.freeze({
    ready: "#8feaff",
    working: "#eaf7ff",
    approval: "#ffd38a",
    error: "#ff8f8f",
  }),
  ready: Object.freeze({
    spread: 1,
    orbit: 0.045,
    speed: 0.32,
    filament: 0,
    down: 0,
    gather: 0,
    alpha: 0.78,
    lift: false,
    warm: false,
    alarm: false,
  }),
  working: Object.freeze({
    spread: 1.42,
    orbit: 0.16,
    speed: 0.62,
    filament: 0.34,
    down: 0,
    gather: 0,
    alpha: 0.92,
    lift: true,
    warm: false,
    alarm: false,
  }),
  responding: Object.freeze({
    spread: 1.08,
    orbit: 0.06,
    speed: 0.48,
    filament: 0.05,
    down: 0.28,
    gather: 0,
    alpha: 0.88,
    lift: true,
    warm: false,
    alarm: false,
  }),
  approval: Object.freeze({
    spread: 1,
    orbit: 0.015,
    speed: 0.18,
    filament: 0,
    down: 0,
    gather: 0,
    alpha: 0.84,
    lift: false,
    warm: true,
    alarm: false,
  }),
  error: Object.freeze({
    spread: 1,
    orbit: 0,
    speed: 0.12,
    filament: 0,
    down: 0,
    gather: 0.62,
    alpha: 0.42,
    lift: false,
    warm: false,
    alarm: true,
  }),
});

const MOTION_KEYS = ["spread", "orbit", "speed", "filament", "down", "gather", "alpha"];
const CORNERS = Object.freeze([
  Object.freeze({ x: 0, y: -1, corner: "n" }),
  Object.freeze({ x: 1, y: 0, corner: "e" }),
  Object.freeze({ x: 0, y: 1, corner: "s" }),
  Object.freeze({ x: -1, y: 0, corner: "w" }),
]);

export function fieldMotionForStatus(status) {
  const kind = fieldKindForStatus(status);
  if (kind === "error") return CHIEF_FIELD.error;
  if (kind === "approval") return CHIEF_FIELD.approval;
  if (kind === "responding") return CHIEF_FIELD.responding;
  if (kind === "ready") return CHIEF_FIELD.ready;
  return CHIEF_FIELD.working;
}

export function easeMotion(current, target, amount) {
  const next = {};
  const step = amount >= 1 ? 1 : amount;
  for (const key of MOTION_KEYS) {
    const from = Number(current?.[key]) || 0;
    const to = Number(target?.[key]) || 0;
    next[key] = from + (to - from) * step;
  }
  next.lift = target?.lift === true;
  next.warm = target?.warm === true;
  next.alarm = target?.alarm === true;
  return next;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function diamondEdge(index, count) {
  const segment = (index / count) * 4;
  const side = Math.floor(segment) % 4;
  const along = segment - Math.floor(segment);
  if (side === 0) return { x: along, y: -1 + along };
  if (side === 1) return { x: 1 - along, y: along };
  if (side === 2) return { x: -along, y: 1 - along };
  return { x: -1 + along, y: -along };
}

function nearestCorner(point) {
  let best = CORNERS[0];
  let bestDistance = Infinity;
  for (const corner of CORNERS) {
    const distance = (point.x - corner.x) ** 2 + (point.y - corner.y) ** 2;
    if (distance < bestDistance) {
      best = corner;
      bestDistance = distance;
    }
  }
  return best;
}

export function createDiamondPoints(count, seed = 1) {
  const total = Math.max(CORNERS.length, count);
  const random = mulberry32(seed);
  const points = CORNERS.map((corner) => ({
    x: corner.x,
    y: corner.y,
    corner: corner.corner,
    edge: false,
    layer: 1,
    phase: 0,
  }));
  const edgeCount = Math.min(CHIEF_FIELD.edgePoints, Math.max(0, total - points.length));
  for (let index = 0; index < edgeCount; index += 1) {
    const edge = diamondEdge(index, edgeCount);
    points.push({
      x: edge.x,
      y: edge.y,
      corner: null,
      edge: true,
      layer: 0.82,
      phase: random() * Math.PI * 2,
    });
  }
  while (points.length < total) {
    const x = random() * 2 - 1;
    const y = random() * 2 - 1;
    if (Math.abs(x) + Math.abs(y) > 0.96) continue;
    points.push({
      x,
      y,
      corner: null,
      edge: false,
      layer: 0.25 + random() * 0.75,
      phase: random() * Math.PI * 2,
    });
  }
  return points;
}

export function pointFrame(point, motion, time = 0) {
  if (point?.corner) {
    return { x: point.x, y: point.y, alpha: 1, size: 2.6, corner: true };
  }
  const gather = Number(motion?.gather) || 0;
  if (gather > 0) {
    const corner = nearestCorner(point);
    return {
      x: point.x + (corner.x - point.x) * gather,
      y: point.y + (corner.y - point.y) * gather,
      alpha: (Number(motion.alpha) || 0) * (0.4 + point.layer * 0.6),
      size: 0.7 + point.layer,
      corner: false,
    };
  }
  const hold = point.edge ? 0.72 : 0;
  const spread = 1 + ((Number(motion.spread) || 1) - 1) * (1 - hold);
  const filament = (Number(motion.filament) || 0) * (point.edge ? 0.15 : 1);
  const orbit =
    Math.sin(time * (Number(motion.speed) || 0) + point.phase) * (Number(motion.orbit) || 0);
  const angle = Math.atan2(point.y, point.x) + orbit;
  const radius = Math.hypot(point.x, point.y) * spread;
  const reach = filament * (0.25 + point.layer * 0.85);
  const wobble =
    Math.sin(time * (Number(motion.speed) || 0) * 1.6 + point.phase * 2) * filament * 0.22;
  return {
    x: Math.cos(angle) * (radius + reach) + wobble * point.y,
    y:
      Math.sin(angle) * (radius + reach) +
      (Number(motion.down) || 0) * (0.35 + point.layer) +
      wobble * point.x,
    alpha: (Number(motion.alpha) || 0) * (0.28 + point.layer * 0.72),
    size: 0.7 + point.layer * 1.5,
    corner: false,
  };
}

export function pointColor(posed, motion) {
  if (motion?.alarm) return CHIEF_FIELD.color.error;
  if (motion?.warm && posed.y > 0.02) return CHIEF_FIELD.color.approval;
  if (motion?.lift) return CHIEF_FIELD.color.working;
  return CHIEF_FIELD.color.ready;
}
