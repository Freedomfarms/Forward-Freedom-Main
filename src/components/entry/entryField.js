// Directed energy current for the gateway. One set of particles, stepped
// outside the canvas so the motion can be tested without a browser.

export const DESKTOP_FIELD_COUNT = 700;
export const MOBILE_FIELD_COUNT = 240;
export const DESKTOP_DIAMOND_COUNT = 160;
export const MOBILE_DIAMOND_COUNT = 72;

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

export function fieldBudget(mobile) {
  return mobile ? MOBILE_FIELD_COUNT : DESKTOP_FIELD_COUNT;
}

export function diamondBudget(mobile) {
  return mobile ? MOBILE_DIAMOND_COUNT : DESKTOP_DIAMOND_COUNT;
}

export function visiblePopulation(total, population) {
  const count = Math.max(0, Number(total) || 0);
  if (population === "void") return Math.min(40, count);
  if (population === "reduced") return Math.min(36, count);
  if (population === "current") return Math.min(count, Math.max(40, Math.round(count * 0.46)));
  return count;
}

export function createCurrent(count, seed = 1, { spread = "bottom" } = {}) {
  const total = Math.max(0, count);
  const random = mulberry32(seed);
  const particles = [];
  for (let index = 0; index < total; index += 1) {
    const depth = random();
    particles.push({
      x: random() * 2 - 1,
      y: spread === "settled" ? 0.08 + random() * 0.84 : random() * 0.16,
      depth,
      speed: 0.08 + random() * 0.34,
      arc: (random() - 0.5) * (0.35 + depth * 0.9),
      phase: random() * Math.PI * 2,
      size: 0.45 + depth * 1.35,
      link: index % 17 === 0 ? (index + 5) % total : -1,
    });
  }
  return particles;
}

export function stepCurrent(particles, dt, { energy = 1, assemble = 0, wordmark = 0 } = {}) {
  const step = Math.max(0, Math.min(0.05, Number(dt) || 0));
  if (!step || !particles?.length) return;
  const lift = 0.55 + Math.max(0, Math.min(1, energy));
  const gather = Math.max(0, Math.min(1, assemble));
  const title = Math.max(0, Math.min(1, wordmark));

  for (let index = 0; index < particles.length; index += 1) {
    const particle = particles[index];
    const depthRate = 0.42 + particle.depth * 1.45;
    particle.y += particle.speed * depthRate * step * lift;
    particle.x += Math.sin(particle.phase + particle.y * 5.2) * particle.arc * step;
    if (gather > 0) {
      const pull = gather * step * (0.28 + particle.depth * 0.45);
      particle.x += -particle.x * pull * 0.65;
      particle.y += (0.58 - particle.y) * pull * 0.18;
    }
    if (title > 0 && index % 11 === 0) {
      particle.x += -particle.x * title * step * 0.45;
      particle.y += (0.8 - particle.y) * title * step * 0.4;
    }
    if (particle.y > 1.08) {
      particle.y = -0.03 - (particle.phase % 1) * 0.05;
    }
    if (particle.x > 1.25) particle.x = -1.15;
    if (particle.x < -1.25) particle.x = 1.15;
  }
}
