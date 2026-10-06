// One spherical particle field. Distribution matches the original homepage
// ball: directions are uniform on the sphere, radius is biased outward.

import * as THREE from "three";

export const PARTICLE_BUDGET = Object.freeze({
  desktop: Object.freeze({ count: 1200 }),
  mobile: Object.freeze({ count: 480 }),
});

export function particleBudgetFor(width, coarsePointer) {
  return width < 900 || coarsePointer ? PARTICLE_BUDGET.mobile : PARTICLE_BUDGET.desktop;
}

export function createCoreParticleGeometry(budget) {
  const total = Math.max(0, budget.count | 0);
  const geometry = new THREE.BufferGeometry();
  const dir = new Float32Array(total * 3);
  const ballR = new Float32Array(total);
  const phase = new Float32Array(total);
  const speed = new Float32Array(total);
  const position = new Float32Array(total * 3);

  for (let i = 0; i < total; i += 1) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const offset = i * 3;
    dir[offset] = Math.sin(phi) * Math.cos(theta);
    dir[offset + 1] = Math.sin(phi) * Math.sin(theta);
    dir[offset + 2] = Math.cos(phi);
    ballR[i] = 0.16 + Math.pow(Math.random(), 0.6) * 0.84;
    phase[i] = Math.random() * Math.PI * 2;
    speed[i] = 0.7 + Math.random() * 1.7;
    position[offset] = dir[offset] * ballR[i];
    position[offset + 1] = dir[offset + 1] * ballR[i];
    position[offset + 2] = dir[offset + 2] * ballR[i];
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("aDir", new THREE.BufferAttribute(dir, 3));
  geometry.setAttribute("aBallR", new THREE.BufferAttribute(ballR, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
  geometry.setAttribute("aSpeed", new THREE.BufferAttribute(speed, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2.2);
  return geometry;
}
