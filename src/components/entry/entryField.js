// One energy mass for the Mad Futurics gateway.
// Particles share streams: a bottom reservoir, a single rising ribbon,
// a collapse onto the Freedom Diamond, then late side currents.
// Motion is pure so it can be stepped without a canvas.

import { rotateView } from "../chief/chiefField.js";

export const DESKTOP_FIELD_COUNT = 1500;
export const MOBILE_FIELD_COUNT = 520;

const STREAMS = 8;
const CORE_SHARE = 0.16;
const FILAMENT_SHARE = 0.08;
const RIDGE_SHARE = 0.3;

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

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function smoothstep(edge0, edge1, value) {
  const span = edge1 - edge0;
  if (span === 0) return value >= edge1 ? 1 : 0;
  const t = clamp01((value - edge0) / span);
  return t * t * (3 - 2 * t);
}

function lerp(from, to, t) {
  return from + (to - from) * t;
}

export function fieldBudget(mobile) {
  return mobile ? MOBILE_FIELD_COUNT : DESKTOP_FIELD_COUNT;
}

export function motionWeights(seconds) {
  const t = Math.min(5, Math.max(0, Number(seconds) || 0));
  return {
    core: smoothstep(0, 0.22, t),
    ribbon: smoothstep(0.06, 0.85, t),
    head: smoothstep(0.08, 1.2, t),
    mass: smoothstep(0.85, 2.25, t),
    form: smoothstep(1.65, 3.55, t),
    coverage: smoothstep(3.1, 4.55, t),
  };
}

function spaceFor(view) {
  const pulse = Math.max(0, Math.min(1, Number(view?.pulse) || 0));
  const surge = view?.surge ? 1.045 : 1;
  const scale = (1 + pulse * 0.08) * surge;
  if (view?.mobile) {
    return {
      coreX: 0,
      coreY: 0.09,
      centerX: 0,
      centerY: 0.6,
      halfX: 0.38 * scale,
      halfY: 0.155 * scale,
    };
  }
  return {
    coreX: 0,
    coreY: 0.07,
    centerX: 0,
    centerY: 0.5,
    halfX: 0.32 * scale,
    halfY: 0.23 * scale,
  };
}

function arcPoint(amount) {
  const angle = -2.02 + (-5.22 - -2.02) * clamp01(amount);
  return {
    x: -0.01 + Math.cos(angle) * 0.5,
    y: 0.5 + Math.sin(angle) * 0.29,
  };
}

function spineAt(amount, space) {
  const arcStart = arcPoint(0);
  if (amount < 0.15) {
    const t = smoothstep(0, 1, amount / 0.15);
    return {
      x: lerp(space.coreX, arcStart.x, t),
      y: lerp(space.coreY, arcStart.y, t),
    };
  }
  return arcPoint((amount - 0.15) / 0.85);
}

function spineFrame(amount, space) {
  const here = spineAt(amount, space);
  const next = spineAt(Math.min(1, amount + 0.012), space);
  let tx = next.x - here.x;
  let ty = next.y - here.y;
  const length = Math.hypot(tx, ty) || 1;
  tx /= length;
  ty /= length;
  return { x: here.x, y: here.y, tx, ty, nx: -ty, ny: tx };
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

const CORNERS = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

export function createCurrent(count, seed = 1) {
  const total = Math.max(0, count | 0);
  const random = mulberry32(seed || 1);
  const particles = [];
  if (!total) return particles;

  const coreCount = Math.max(1, Math.round(total * CORE_SHARE));
  const filamentCount = Math.max(1, Math.round(total * FILAMENT_SHARE));
  const ridgeCount = Math.max(1, Math.round(total * RIDGE_SHARE));
  const bodyCount = Math.max(4, total - coreCount - filamentCount - ridgeCount);

  for (let index = 0; index < coreCount; index += 1) {
    particles.push({
      role: "core",
      stream: 0,
      lane: random() * 2 - 1,
      seed: random(),
      flow: 0,
      speed: 0.45 + random() * 0.7,
      depth: 0.45 + random() * 0.55,
      phase: random() * Math.PI * 2,
      shell: 0,
      kind: "core",
      dx: 0,
      dy: 1,
      side: 1,
      band: 0,
      jitter: random(),
    });
  }

  for (let index = 0; index < bodyCount; index += 1) {
    const stream = random() < 0.34 ? 0 : 1 + Math.floor(random() * (STREAMS - 1));
    let kind = "interior";
    let dx;
    let dy;
    let shell;
    if (index < 64) {
      kind = "corner";
      shell = 2;
      const corner = CORNERS[index % 4];
      dx = corner.x;
      dy = corner.y;
    } else if (random() < 0.52) {
      kind = "edge";
      shell = 2;
      const edge = diamondEdge(index, bodyCount);
      dx = edge.x;
      dy = edge.y;
    } else {
      shell = random() < 0.72 ? 0 : 1;
      const inward = random() < 0.55 ? 0.42 : 1;
      dx = (random() * 2 - 1) * inward;
      dy = (random() * 2 - 1) * inward;
      const limit = Math.abs(dx) + Math.abs(dy);
      if (limit > 0.9) {
        dx *= 0.9 / limit;
        dy *= 0.9 / limit;
      }
    }
    particles.push({
      role: "body",
      stream,
      lane: (random() * 2 - 1) * (stream === 0 ? 0.72 : 1),
      seed: random() ** 1.35,
      flow: 0,
      speed: 0.62 + random() * 0.85,
      depth: random(),
      phase: random() * Math.PI * 2,
      shell,
      kind,
      dx,
      dy,
      side: 1,
      band: 0,
      jitter: random() * 0.12,
    });
  }

  for (let index = 0; index < filamentCount; index += 1) {
    particles.push({
      role: "filament",
      stream: 0,
      lane: random() * 2 - 1,
      seed: random() ** 0.75,
      flow: 0,
      speed: 0.5 + random() * 0.8,
      depth: 0.35 + random() * 0.65,
      phase: random() * Math.PI * 2,
      shell: 2,
      kind: "filament",
      dx: 0,
      dy: 1,
      side: 1,
      band: 0,
      jitter: random(),
    });
  }

  for (let index = 0; index < ridgeCount; index += 1) {
    particles.push({
      role: "ridge",
      stream: index % 10,
      lane: random() * 2 - 1,
      seed: random(),
      flow: random() * 0.2,
      speed: 0.35 + random() * 0.9,
      depth: random(),
      phase: random() * Math.PI * 2,
      shell: 2,
      kind: "ridge",
      dx: 0,
      dy: 0,
      side: index % 2 === 0 ? -1 : 1,
      band: index % 5,
      jitter: random(),
    });
  }

  return particles;
}

export function stepCurrent(particles, dt, view = {}) {
  const step = Math.max(0, Math.min(0.05, Number(dt) || 0));
  if (!step || !particles?.length) return;
  const weights = motionWeights(view.seconds);
  const form = Math.max(weights.form, clamp01(view.assemble));
  const drive = 0.18 + weights.ribbon * 0.55 + weights.mass * 1.15;
  const calm = lerp(1, 0.16, smoothstep(0.72, 1, form));
  for (let index = 0; index < particles.length; index += 1) {
    const particle = particles[index];
    const roleScale = particle.role === "ridge" ? 0.55 : particle.role === "core" ? 1.4 : 1;
    particle.flow += step * particle.speed * drive * calm * roleScale;
    particle.phase += step * (0.8 + weights.mass * 1.6) * roleScale;
  }
}

function rotationFor(view, time) {
  const drift = view?.drift ? Math.sin(time * 0.38) * 0.05 : 0;
  const hover = view?.hover ? 0.026 : 0;
  return drift + hover;
}

function shade(particle, heat, lock) {
  const interior = particle.kind === "interior" && particle.shell === 0 && lock > 0.45;
  let red = 61;
  let green = 124;
  let blue = 255;
  if (heat > 0.7 || particle.role === "core" || (lock > 0.6 && particle.kind === "corner")) {
    red = 236;
    green = 246;
    blue = 255;
  } else if (lock > 0.62 && (particle.kind === "edge" || interior)) {
    red = 220;
    green = 236;
    blue = 255;
  } else if (particle.role === "filament") {
    red = 198;
    green = 226;
    blue = 255;
  } else if (particle.depth > 0.72) {
    red = 185;
    green = 215;
    blue = 255;
  } else if (particle.depth < 0.22) {
    red = 106;
    green = 92;
    blue = 255;
  }
  let alpha = 0.42 + particle.depth * 0.55;
  if (heat > 0.7 || particle.role === "core" || particle.kind === "corner")
    alpha = 0.8 + particle.depth * 0.2;
  if (interior) alpha = 0.55 + lock * 0.4;
  if (lock > 0.62 && particle.kind === "edge") alpha = 0.72 + particle.depth * 0.28;
  if (particle.role === "ridge") alpha *= 0.8;
  return { r: red, g: green, b: blue, a: Math.min(1, alpha) };
}

function precedence(particle) {
  if (particle.kind === "interior") return 0.58 + particle.shell * 0.1;
  if (particle.kind === "corner") {
    if (particle.dy > 0.4) return 0.02;
    if (particle.dy < -0.4) return 0.5;
    return 0.26;
  }
  return 0.06 + (1 - clamp01((particle.dy + 1) / 2)) * 0.52;
}

function diamondSlot(particle, space, rotation, form) {
  const shell = particle.shell === 0 ? 0.6 : particle.shell === 1 ? 0.82 : 1;
  const turned = rotateView(particle.dx * shell, particle.dy * shell, rotation);
  let x = space.centerX + turned.x * space.halfX;
  let y = space.centerY - turned.y * space.halfY;
  if (particle.kind === "interior") {
    const top = space.centerY + space.halfY * shell;
    const bottom = space.centerY - space.halfY * shell;
    const bands = 11;
    const span = top - bottom || 1;
    const step = Math.round(((y - bottom) / span) * bands) / bands;
    y = lerp(y, bottom + step * span, smoothstep(0.55, 0.95, form) * 0.55);
  }
  if (particle.kind === "corner") {
    const loosen = 1 - smoothstep(0.2, 0.85, form);
    x += Math.cos(particle.phase) * particle.jitter * space.halfX * loosen;
    y += Math.sin(particle.phase) * particle.jitter * space.halfY * loosen;
  }
  return { x, y };
}

function swirlPoint(x, y, space, form) {
  const amount = Math.sin(Math.PI * clamp01((form - 0.08) / 0.7)) * 0.28;
  if (amount <= 0) return { x, y };
  const dx = x - space.centerX;
  const dy = y - space.centerY;
  const sine = Math.sin(amount);
  const cosine = Math.cos(amount);
  return {
    x: space.centerX + dx * cosine - dy * sine * 0.5,
    y: space.centerY + dx * sine * 0.5 + dy * cosine,
  };
}

export function placeParticle(particle, view = {}, time = 0) {
  const weights = motionWeights(view.seconds);
  const form = Math.max(weights.form, clamp01(view.assemble));
  const space = spaceFor(view);
  const rotation = rotationFor(view, time);

  if (particle.role === "core") {
    const spin = particle.phase + particle.flow * 2.2;
    const stem = particle.seed * (0.05 + weights.head * 0.18) * (1 - smoothstep(0.08, 0.72, form));
    const frame = spineFrame(stem, space);
    const boil = Math.sqrt(particle.seed) * (0.018 + particle.depth * 0.04);
    const x = frame.x + Math.cos(spin) * boil;
    const y = frame.y + Math.sin(spin) * boil * 0.72;
    const color = shade(particle, 1, 0);
    return {
      x,
      y,
      tx: frame.tx,
      ty: frame.ty,
      nx: frame.nx,
      ny: frame.ny,
      visible: weights.core > 0.04,
      ...color,
      stretch: 0.0015,
      scatter: particle.depth > 0.75,
      lock: 0,
      copies: 2,
      spread: 0.008,
    };
  }

  if (particle.role === "filament") {
    const southY = space.centerY - space.halfY;
    const travel = (particle.seed + particle.flow * 0.45) % 1;
    const reach = Math.max(weights.mass * 0.85, form);
    const y = lerp(space.coreY, southY, travel * Math.max(reach, 0.001));
    const wave = Math.sin(travel * 14 + particle.phase) * (0.012 - form * 0.008);
    const x = space.centerX + wave + particle.lane * 0.006 * (1 - form * 0.7);
    const color = shade(particle, travel < 0.22 ? 0.9 : 0.45, form);
    return {
      x,
      y,
      tx: 0,
      ty: 1,
      nx: 1,
      ny: 0,
      visible: weights.mass > 0.28 && travel <= reach + 0.03,
      ...color,
      stretch: 0.002,
      scatter: false,
      lock: form,
      copies: 2,
      spread: 0.006,
    };
  }

  if (particle.role === "ridge") {
    const open = weights.coverage;
    const travel = (particle.seed * 0.85 + particle.flow * 0.35) % 1;
    const reach = space.halfX * 0.92 + travel * (1.04 - space.halfX);
    const crest = Math.sin(travel * Math.PI * 1.15) * (0.055 + (particle.band % 3) * 0.02);
    const y =
      space.centerY +
      (particle.band - 2) * 0.058 +
      crest +
      particle.lane * 0.016 +
      Math.sin(travel * 6.5 + particle.phase) * 0.012;
    const x = particle.side * reach;
    const color = shade(particle, particle.depth > 0.82 ? 0.55 : 0.12, form);
    return {
      x,
      y,
      tx: particle.side,
      ty: Math.cos(travel * Math.PI) * 0.35,
      nx: particle.side,
      ny: Math.cos(travel * Math.PI) * 0.2,
      visible: open > 0.04 && travel < open,
      ...color,
      stretch: 0.003,
      scatter: particle.depth > 0.92,
      lock: 0,
      copies: 5,
      spread: 0.018,
    };
  }

  const head = Math.max(0.04, weights.head);
  const cycle = (particle.seed + particle.flow * (0.35 + weights.mass * 0.45)) % 1;
  const along = cycle * (form > 0.8 ? 1 : head);
  const frame = spineFrame(along, space);
  const thick = (0.032 + weights.mass * 0.06) * (1 - form * 0.8);
  const flutter =
    Math.sin(particle.phase + along * 10 + particle.stream) * thick * 0.28 * (1 - form);
  let x = frame.x + frame.nx * (particle.lane * thick + flutter);
  let y = frame.y + frame.ny * (particle.lane * thick + flutter);
  const gather = weights.mass * (1 - form * 0.9);
  x = lerp(x, x * 0.4, gather * 0.72);
  y = lerp(y, space.centerY + (y - 0.4) * 0.72, gather * 0.4);
  const spun = swirlPoint(x, y, space, form * (1 - form * 0.15));
  x = spun.x;
  y = spun.y;
  const lock = smoothstep(precedence(particle) * 0.45, 0.18 + precedence(particle) * 0.82, form);
  const slot = diamondSlot(particle, space, rotation, form);
  x = lerp(x, slot.x, lock);
  y = lerp(y, slot.y, lock);
  if (lock > 0.9 && particle.kind === "edge") {
    const crawl = Math.sin(particle.phase) * 0.006 * (1 - weights.coverage * 0.5);
    x += frame.tx * crawl;
    y += frame.ty * crawl;
  }
  const streamOpen =
    particle.stream === 0 || weights.head > 0.22 + particle.stream * 0.07 || form > 0.32;
  const visible = weights.ribbon > 0.05 && streamOpen;
  const nearCore = Math.exp(-along * 6.5);
  const lead = Math.exp(-Math.abs(along / head - 1) * 3.2) * (1 - form);
  const color = shade(particle, Math.max(nearCore, lead), lock);
  const locked = lock > 0.55;
  return {
    x,
    y,
    tx: frame.tx,
    ty: frame.ty,
    nx: frame.nx,
    ny: frame.ny,
    visible,
    ...color,
    stretch: locked ? 0.001 : 0.002 + weights.mass * 0.004,
    scatter: particle.depth > 0.9 && lock < 0.4,
    lock,
    copies: locked ? 2 : 3,
    spread: locked ? 0.006 : thick * 0.28,
  };
}

export function sceneAnchors(view = {}, time = 0) {
  const weights = motionWeights(view.seconds);
  const form = Math.max(weights.form, clamp01(view.assemble));
  const space = spaceFor(view);
  return {
    weights,
    form,
    rotation: rotationFor(view, time),
    space,
    core: { x: space.coreX, y: space.coreY },
    focus: {
      x: space.centerX,
      y: lerp(space.coreY + 0.05, space.centerY, Math.max(weights.mass * 0.75, form)),
    },
  };
}

export function fieldPointToScreen(x, y, width, height) {
  return {
    sx: width * 0.5 + x * width * 0.5,
    sy: height * (1 - y),
  };
}

export function frameRings(view = {}, time = 0) {
  const anchors = sceneAnchors(view, time);
  const { weights, focus, core } = anchors;
  const rings = [];
  if (weights.mass > 0.16) {
    for (let index = 0; index < 4; index += 1) {
      const phase = (time * 0.17 + index * 0.25) % 1;
      rings.push({
        x: focus.x,
        y: focus.y,
        norm: 0.04 + phase * (0.26 + weights.coverage * 0.42),
        alpha: (1 - phase) ** 1.35 * 0.42 * Math.min(1, weights.mass * 1.2),
      });
    }
  }
  if (weights.core > 0.15) {
    for (let index = 0; index < 2; index += 1) {
      const phase = (time * 0.42 + index * 0.5) % 1;
      rings.push({
        x: core.x,
        y: core.y,
        norm: 0.015 + phase * 0.09,
        alpha: (1 - phase) * 0.4 * weights.core,
      });
    }
  }
  return rings;
}
