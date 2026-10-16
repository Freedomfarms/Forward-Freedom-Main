// Independent spherical arcs, not a shared curl field. A shared flow
// bunches every strand onto the same lanes, so raising the count only
// thickens a few ropes and leaves the sphere empty. Each arc here has
// its own direction and a small private turn, then splits into a branch
// that drifts inward. Ribbons collapse when a segment points at the
// camera, which is what was stamping the white horizontal bars.

import * as THREE from "three";

export const FILAMENT_ANCHOR_Y = 0.426;
export const FILAMENT_COLORS = Object.freeze({
  magenta: 0xff4ad8,
  violet: 0x9b4dff,
  blue: 0x4da3ff,
});

const FAMILIES = Object.freeze([
  Object.freeze({ count: 1680, min: 0.9, max: 1, steps: 9, step: 0.1, drift: 0, seed: 5, dive: 0.28, branch: 0.42 }),
  Object.freeze({ count: 980, min: 0.55, max: 0.86, steps: 8, step: 0.105, drift: -0.002, seed: 19, dive: 0.4, branch: 0.36 }),
  Object.freeze({ count: 520, min: 0.24, max: 0.52, steps: 7, step: 0.1, drift: 0, seed: 37, dive: 0.2, branch: 0.2 }),
  Object.freeze({ count: 240, min: 0.07, max: 0.22, steps: 5, step: 0.09, drift: 0, seed: 101, dive: 0, branch: 0 }),
]);

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function fibonacciDirection(index, count, rand) {
  const y = 1 - (2 * (index + 0.5)) / count;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = Math.PI * (3 - Math.sqrt(5)) * index + (rand() - 0.5) * 0.35;
  return [Math.cos(theta) * ring, y, Math.sin(theta) * ring];
}

function tangentFrame(dir, rand) {
  const up = Math.abs(dir[1]) > 0.85 ? [1, 0, 0] : [0, 1, 0];
  let tx = dir[1] * up[2] - dir[2] * up[1];
  let ty = dir[2] * up[0] - dir[0] * up[2];
  let tz = dir[0] * up[1] - dir[1] * up[0];
  const length = Math.hypot(tx, ty, tz) || 1;
  tx /= length;
  ty /= length;
  tz /= length;
  const bx = dir[1] * tz - dir[2] * ty;
  const by = dir[2] * tx - dir[0] * tz;
  const bz = dir[0] * ty - dir[1] * tx;
  const angle = rand() * Math.PI * 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [tx * cos + bx * sin, ty * cos + by * sin, tz * cos + bz * sin];
}

function rotateAround(vector, axis, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dot = vector[0] * axis[0] + vector[1] * axis[1] + vector[2] * axis[2];
  const cx = axis[1] * vector[2] - axis[2] * vector[1];
  const cy = axis[2] * vector[0] - axis[0] * vector[2];
  const cz = axis[0] * vector[1] - axis[1] * vector[0];
  return [
    vector[0] * cos + cx * sin + axis[0] * dot * (1 - cos),
    vector[1] * cos + cy * sin + axis[1] * dot * (1 - cos),
    vector[2] * cos + cz * sin + axis[2] * dot * (1 - cos),
  ];
}

function traceArc(dir, tangent, radius, steps, stepAngle, drift, phase, rand) {
  const points = [];
  let heading = dir;
  let forward = tangent;
  let reach = radius;
  const mid = { heading: dir, forward: tangent, reach: radius };
  const midStep = Math.floor(steps / 2);
  for (let step = 0; step <= steps; step += 1) {
    const binormal = normalize([
      heading[1] * forward[2] - heading[2] * forward[1],
      heading[2] * forward[0] - heading[0] * forward[2],
      heading[0] * forward[1] - heading[1] * forward[0],
    ]);
    const wobble = Math.sin(step * 0.85 + phase) * 0.012;
    points.push([
      heading[0] * reach + binormal[0] * wobble,
      heading[1] * reach + binormal[1] * wobble,
      heading[2] * reach + binormal[2] * wobble,
    ]);
    const cos = Math.cos(stepAngle);
    const sin = Math.sin(stepAngle);
    const nextHeading = normalize([
      heading[0] * cos + forward[0] * sin,
      heading[1] * cos + forward[1] * sin,
      heading[2] * cos + forward[2] * sin,
    ]);
    const nextForward = normalize([
      -heading[0] * sin + forward[0] * cos,
      -heading[1] * sin + forward[1] * cos,
      -heading[2] * sin + forward[2] * cos,
    ]);
    if (step === midStep) {
      mid.heading = heading;
      mid.forward = forward;
      mid.reach = reach;
    }
    heading = nextHeading;
    forward = normalize(rotateAround(nextForward, heading, (rand() - 0.5) * 0.16));
    reach = Math.min(1, Math.max(0.05, reach + drift));
  }
  return { points, heading: mid.heading, forward: mid.forward, reach: mid.reach };
}

function pushStrand(buffers, points, seed) {
  const last = points.length - 1;
  for (let index = 0; index < last; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const dz = end[2] - start[2];
    if (dx * dx + dy * dy + dz * dz < 1e-8) continue;
    const alongStart = index / last;
    const alongEnd = (index + 1) / last;
    const endNext = [end[0] + dx, end[1] + dy, end[2] + dz];
    const corners = [
      [start, end, -1, alongStart],
      [start, end, 1, alongStart],
      [end, endNext, -1, alongEnd],
      [end, endNext, 1, alongEnd],
    ];
    for (const corner of [0, 1, 2, 2, 1, 3]) {
      const [position, next, side, along] = corners[corner];
      buffers.position.push(position[0], position[1], position[2]);
      buffers.next.push(next[0], next[1], next[2]);
      buffers.side.push(side);
      buffers.along.push(along);
      buffers.seed.push(seed);
    }
  }
}

function createLatticeGeometry() {
  const buffers = { position: [], next: [], side: [], along: [], seed: [] };
  for (const family of FAMILIES) {
    const rand = mulberry32(family.seed);
    for (let index = 0; index < family.count; index += 1) {
      const dir = fibonacciDirection(index, family.count, rand);
      const tangent = tangentFrame(dir, rand);
      const radius = family.min + rand() * (family.max - family.min);
      const diving = rand() < family.dive;
      const drift = diving ? -0.012 - rand() * 0.018 : family.drift;
      const phase = rand() * Math.PI * 2;
      const arc = traceArc(dir, tangent, radius, family.steps, family.step, drift, phase, rand);
      const seed = rand() * Math.PI * 2;
      pushStrand(buffers, arc.points, seed);
      if (rand() < family.branch) {
        const turn = (rand() < 0.5 ? -1 : 1) * (0.65 + rand() * 0.45);
        const branchTangent = normalize(rotateAround(arc.forward, arc.heading, turn));
        const branch = traceArc(
          arc.heading,
          branchTangent,
          arc.reach,
          6,
          family.step,
          -0.02,
          phase + 1.7,
          rand
        );
        pushStrand(buffers, branch.points, seed + 0.35);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(buffers.position, 3));
  geometry.setAttribute("aNext", new THREE.Float32BufferAttribute(buffers.next, 3));
  geometry.setAttribute("aSide", new THREE.Float32BufferAttribute(buffers.side, 1));
  geometry.setAttribute("aAlong", new THREE.Float32BufferAttribute(buffers.along, 1));
  geometry.setAttribute("aSeed", new THREE.Float32BufferAttribute(buffers.seed, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

export function createFilamentMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      attribute vec3 aNext;
      attribute float aSide;
      attribute float aAlong;
      attribute float aSeed;
      uniform vec2 uResolution;
      uniform float uThickness;
      uniform float uTime;
      varying float vSide;
      varying float vAlong;
      varying float vSeed;
      varying float vRadius;
      void main() {
        float breath = 1.0 + sin(uTime * 0.5 + aSeed) * 0.012;
        vec3 shaped = position * breath;
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(shaped, 1.0);
        vec4 clipNext = projectionMatrix * modelViewMatrix * vec4(aNext * breath, 1.0);
        vec2 dir = clipNext.xy / max(clipNext.w, 0.0001) - clip.xy / max(clip.w, 0.0001);
        float span = length(dir);
        dir = span < 0.00001 ? vec2(1.0, 0.0) : dir / span;
        float drawn = smoothstep(0.00002, 0.00016, span);
        vec2 pixel = vec2(2.0 / max(uResolution.x, 1.0), 2.0 / max(uResolution.y, 1.0));
        clip.xy += vec2(-dir.y, dir.x) * aSide * uThickness * pixel * clip.w * drawn;
        gl_Position = clip;
        vSide = aSide;
        vAlong = aAlong;
        vSeed = aSeed;
        vRadius = length(position);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uPace;
      uniform float uHot;
      uniform vec3 uBlue;
      uniform vec3 uViolet;
      uniform vec3 uMagenta;
      varying float vSide;
      varying float vAlong;
      varying float vSeed;
      varying float vRadius;
      void main() {
        float pace = max(uPace, 0.4);
        float spine = pow(clamp(1.0 - abs(vSide), 0.0, 1.0), 1.15);
        float travel = 0.55 + 0.45 * sin(vAlong * 34.0 - uTime * (0.32 + pace * 0.2) + vSeed);
        float dye = fract(sin(vSeed * 12.9898) * 43758.5453);
        float shell = smoothstep(0.5, 0.94, vRadius);
        vec3 outer = mix(uBlue, uViolet, smoothstep(0.58, 0.86, dye));
        outer = mix(outer, uMagenta, smoothstep(0.9, 0.99, dye));
        vec3 inner = mix(uViolet, uMagenta, smoothstep(0.18, 0.72, dye));
        vec3 strand = mix(inner, outer, shell);
        float heart = smoothstep(0.07, 0.0, vRadius);
        strand = mix(strand, vec3(1.0), heart * (0.35 + spine * 0.65) + spine * spine * 0.14);
        strand *= 0.7 + spine * 0.4;
        strand *= 0.8 + travel * 0.25;
        float alpha = (0.14 + spine * 0.4) * (0.78 + travel * 0.22) * mix(0.9, 1.2, shell);
        gl_FragColor = vec4(strand, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    toneMapped: false,
  });
}

function createHeartMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-viewPosition.xyz);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      uniform float uHot;
      uniform vec3 uMagenta;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float facing = pow(clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0), 2.4);
        vec3 color = mix(uMagenta, vec3(1.0), 0.15 + facing * 0.85);
        gl_FragColor = vec4(color, facing);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    toneMapped: false,
  });
}

export function createFilamentCore(uniforms) {
  const root = new THREE.Group();
  root.name = "chief-filament-core";
  const geometry = createLatticeGeometry();
  const material = createFilamentMaterial(uniforms);
  const lattice = new THREE.Mesh(geometry, material);
  lattice.name = "filament-volume";
  lattice.frustumCulled = false;
  lattice.renderOrder = 2;
  root.add(lattice);

  const heartGeometry = new THREE.SphereGeometry(0.028, 24, 16);
  const heart = new THREE.Mesh(heartGeometry, createHeartMaterial(uniforms));
  heart.name = "filament-heart";
  heart.frustumCulled = false;
  heart.renderOrder = 3;
  root.add(heart);

  root.userData.disposeCore = () => {
    geometry.dispose();
    material.dispose();
    heartGeometry.dispose();
    heart.material.dispose();
  };
  return root;
}
