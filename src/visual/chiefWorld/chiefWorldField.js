// Spatial layout for the home field.
// These coordinates are latent. The scene does not draw them as objects.
// Anchors and links become visible only as light while CHIEF is thinking.
// Activity lanes are used only when a real status or entity is present.

export const PRESENCE_ORIGIN = Object.freeze([0.04, 1.12, -1.55]);

export const ACTIVITY_LANES = Object.freeze({
  research: Object.freeze({ position: Object.freeze([2.45, 1.18, -2.55]) }),
  finance: Object.freeze({ position: Object.freeze([1.7, 0.68, -0.85]) }),
  systems: Object.freeze({ position: Object.freeze([-2.25, 1.02, -1.7]) }),
  tools: Object.freeze({ position: Object.freeze([0.42, 1.52, -4.55]) }),
  hold: Object.freeze({ position: Object.freeze([0.12, 0.82, -1.15]) }),
});

export const FIELD_ANCHORS = Object.freeze([
  Object.freeze([-2.15, 0.92, -1.55]),
  Object.freeze([-0.32, 1.38, -3.55]),
  Object.freeze([0.55, 0.66, -0.35]),
  Object.freeze([2.35, 1.12, -2.45]),
  Object.freeze([0.72, 1.72, -5.7]),
  Object.freeze([-1.25, 1.58, -4.85]),
]);

export const FIELD_LINKS = Object.freeze([
  Object.freeze([0, 1]),
  Object.freeze([1, 4]),
  Object.freeze([1, 2]),
  Object.freeze([2, 3]),
  Object.freeze([4, 5]),
  Object.freeze([5, 0]),
  Object.freeze([1, 3]),
]);

export function createAtmospherePositions(count, random = Math.random) {
  const total = Math.max(0, count | 0);
  const positions = new Float32Array(total * 3);
  for (let index = 0; index < total; index += 1) {
    positions[index * 3] = (random() - 0.5) * 14;
    positions[index * 3 + 1] = random() * 3.4 - 0.3;
    positions[index * 3 + 2] = 1.2 - random() * 12;
  }
  return positions;
}

export function createAtmosphereSeeds(count, random = Math.random) {
  const total = Math.max(0, count | 0);
  const seeds = new Float32Array(total);
  for (let index = 0; index < total; index += 1) seeds[index] = random() * Math.PI * 2;
  return seeds;
}

export function placeEntity(entity) {
  if (Array.isArray(entity?.position) && entity.position.length >= 3) {
    const x = Number(entity.position[0]);
    const y = Number(entity.position[1]);
    const z = Number(entity.position[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return [x, y, z];
  }
  const lane = entity?.lane ? ACTIVITY_LANES[entity.lane] : null;
  return lane ? [lane.position[0], lane.position[1], lane.position[2]] : null;
}
