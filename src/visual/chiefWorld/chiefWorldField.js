// Spatial layout for the home world. Positions fill a volume.
// Nothing here is arranged on a sphere.

export const PRESENCE_ORIGIN = Object.freeze([0.04, 1.12, -1.55]);

export const ACTIVITY_LANES = Object.freeze({
  research: Object.freeze({ position: Object.freeze([2.45, 1.18, -2.55]) }),
  finance: Object.freeze({ position: Object.freeze([1.7, 0.68, -0.85]) }),
  systems: Object.freeze({ position: Object.freeze([-2.25, 1.02, -1.7]) }),
  tools: Object.freeze({ position: Object.freeze([0.42, 1.52, -4.55]) }),
  hold: Object.freeze({ position: Object.freeze([0.12, 0.82, -1.15]) }),
});

// Corridor slabs. Thin in one axis so they read as walls, not posters.
// `depth` selects the parallax layer: near moves more than far.
export const GLASS_PANELS = Object.freeze([
  Object.freeze({
    position: Object.freeze([-2.85, 1.15, -6.5]),
    rotation: Object.freeze([0, 0.06, 0]),
    size: Object.freeze([0.028, 2.55, 1.85]),
    depth: "far",
    shift: Object.freeze([0.22, 0.02, -0.4]),
  }),
  Object.freeze({
    position: Object.freeze([3.1, 1.22, -6.15]),
    rotation: Object.freeze([0, -0.08, 0]),
    size: Object.freeze([0.028, 2.75, 1.65]),
    depth: "far",
    shift: Object.freeze([-0.2, 0.03, -0.34]),
  }),
  Object.freeze({
    position: Object.freeze([0.05, 2.2, -7.5]),
    rotation: Object.freeze([0.18, 0, 0]),
    size: Object.freeze([4.4, 0.02, 0.55]),
    depth: "far",
    shift: Object.freeze([0, 0.08, -0.16]),
  }),
  Object.freeze({
    position: Object.freeze([-2.15, 1.02, -3.15]),
    rotation: Object.freeze([0, 0.1, 0]),
    size: Object.freeze([0.022, 2.2, 1.4]),
    depth: "mid",
    shift: Object.freeze([0.16, 0.02, -0.48]),
  }),
  Object.freeze({
    position: Object.freeze([2.4, 1.08, -2.85]),
    rotation: Object.freeze([0, -0.12, 0]),
    size: Object.freeze([0.022, 2.3, 1.25]),
    depth: "mid",
    shift: Object.freeze([-0.14, 0.02, -0.42]),
  }),
  Object.freeze({
    position: Object.freeze([-1.05, 1.55, -4.35]),
    rotation: Object.freeze([0, 0.42, 0]),
    size: Object.freeze([0.85, 1.05, 0.016]),
    depth: "mid",
    shift: Object.freeze([0.1, 0.04, -0.22]),
  }),
  Object.freeze({
    position: Object.freeze([1.2, 0.72, -4.7]),
    rotation: Object.freeze([0, -0.38, 0]),
    size: Object.freeze([0.62, 0.82, 0.016]),
    depth: "mid",
    shift: Object.freeze([-0.08, 0.03, -0.18]),
  }),
  Object.freeze({
    position: Object.freeze([-1.9, 0.82, 1.2]),
    rotation: Object.freeze([0, 0.62, 0]),
    size: Object.freeze([0.018, 1.75, 0.9]),
    depth: "near",
    shift: Object.freeze([0.06, 0, -0.16]),
  }),
  Object.freeze({
    position: Object.freeze([2.0, 0.9, 1.4]),
    rotation: Object.freeze([0, -0.55, 0]),
    size: Object.freeze([0.018, 1.9, 0.78]),
    depth: "near",
    shift: Object.freeze([-0.06, 0, -0.14]),
  }),
]);

export const LIGHT_SEAMS = Object.freeze([
  Object.freeze({ position: Object.freeze([-1.7, 1.15, -1.35]), depth: "mid" }),
  Object.freeze({ position: Object.freeze([1.95, 1.2, -2.5]), depth: "mid" }),
  Object.freeze({ position: Object.freeze([-2.65, 1.25, -5.1]), depth: "far" }),
  Object.freeze({ position: Object.freeze([2.9, 1.3, -5.6]), depth: "far" }),
]);

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

export const FIELD_STRATA = Object.freeze([
  Object.freeze({ y: 0.18, z: -2.1, width: 5.4 }),
  Object.freeze({ y: 0.46, z: -4.6, width: 7.6 }),
  Object.freeze({ y: 1.92, z: -7.2, width: 9.4 }),
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
