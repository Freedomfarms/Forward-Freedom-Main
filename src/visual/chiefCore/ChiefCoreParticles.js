// Particle budgets and one-time geometry. Positions are computed in the
// vertex shader, so counts can change without touching the animation loop.

import * as THREE from "three";

export const PARTICLE_BUDGET = Object.freeze({
  desktop: Object.freeze({ field: 900, orbit: 56, traveler: 18, dust: 70 }),
  mobile: Object.freeze({ field: 360, orbit: 24, traveler: 8, dust: 28 }),
});

export function particleBudgetFor(width, coarsePointer) {
  return width < 900 || coarsePointer ? PARTICLE_BUDGET.mobile : PARTICLE_BUDGET.desktop;
}

function randomDirection(dir, index) {
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  const offset = index * 3;
  dir[offset] = Math.sin(phi) * Math.cos(theta);
  dir[offset + 1] = Math.sin(phi) * Math.sin(theta);
  dir[offset + 2] = Math.cos(phi);
}

export function createParticleGeometry(count, kind) {
  const total = Math.max(0, count | 0);
  const geometry = new THREE.BufferGeometry();
  const dir = new Float32Array(total * 3);
  const seed = new Float32Array(total);
  const kinds = new Float32Array(total);
  const position = new Float32Array(total * 3);
  for (let i = 0; i < total; i += 1) {
    randomDirection(dir, i);
    seed[i] = Math.random();
    kinds[i] = kind;
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("aDir", new THREE.BufferAttribute(dir, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  geometry.setAttribute("aKind", new THREE.BufferAttribute(kinds, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 8);
  return geometry;
}

export function createCoreParticleGeometry(budget) {
  const field = budget.field;
  const orbit = budget.orbit;
  const traveler = budget.traveler;
  const total = field + orbit + traveler;
  const geometry = new THREE.BufferGeometry();
  const dir = new Float32Array(total * 3);
  const seed = new Float32Array(total);
  const kinds = new Float32Array(total);
  const position = new Float32Array(total * 3);
  for (let i = 0; i < total; i += 1) {
    randomDirection(dir, i);
    seed[i] = Math.random();
    if (i < field) kinds[i] = 0;
    else if (i < field + orbit) kinds[i] = 1;
    else kinds[i] = 2;
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("aDir", new THREE.BufferAttribute(dir, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  geometry.setAttribute("aKind", new THREE.BufferAttribute(kinds, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 8);
  return geometry;
}
