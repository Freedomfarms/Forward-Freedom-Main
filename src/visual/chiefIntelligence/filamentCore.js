// Two layers, not a filled tangle. The shell is a few dozen long blue
// and cyan paths. The interior is a smaller set of violet and magenta
// paths with open space between them. A shared random field was filling
// every direction, so the sphere read as spaghetti and the dark pockets
// disappeared.

import * as THREE from "three";

export const FILAMENT_ANCHOR_Y = 0.426;
export const FILAMENT_COLORS = Object.freeze({
  magenta: 0xff4ad8,
  violet: 0x9b4dff,
  blue: 0x4da3ff,
  cyan: 0x5ce8ff,
});

const SHELL_FLOWS = Object.freeze([
  Object.freeze({ count: 32, radius: 0.99, steps: 42, step: 0.042, tilt: 0.12, turn: 0.012, seed: 3 }),
  Object.freeze({ count: 22, radius: 0.95, steps: 36, step: 0.046, tilt: 0.62, turn: 0.016, seed: 11 }),
  Object.freeze({ count: 14, radius: 0.91, steps: 30, step: 0.05, tilt: -0.4, turn: 0.018, seed: 17 }),
]);

const INNER_CLUSTERS = Object.freeze([
  Object.freeze({ count: 16, axis: Object.freeze([0.2, 0.25, 0.9]), spread: 0.7, min: 0.52, max: 0.68, steps: 34, step: 0.05, tilt: 0.35, turn: 0.07, seed: 29, branch: 0.45 }),
  Object.freeze({ count: 12, axis: Object.freeze([-0.55, -0.15, 0.75]), spread: 0.55, min: 0.34, max: 0.5, steps: 30, step: 0.048, tilt: -0.25, turn: 0.1, seed: 43, branch: 0.8 }),
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

function clusterStart(axis, spread, radius, tilt, rand) {
  const aim = normalize(axis);
  const up = Math.abs(aim[1]) > 0.85 ? [1, 0, 0] : [0, 1, 0];
  const tangent = normalize([
    aim[1] * up[2] - aim[2] * up[1],
    aim[2] * up[0] - aim[0] * up[2],
    aim[0] * up[1] - aim[1] * up[0],
  ]);
  const bitangent = normalize([
    aim[1] * tangent[2] - aim[2] * tangent[1],
    aim[2] * tangent[0] - aim[0] * tangent[2],
    aim[0] * tangent[1] - aim[1] * tangent[0],
  ]);
  const dir = normalize([
    aim[0] + tangent[0] * (rand() - 0.5) * spread + bitangent[0] * (rand() - 0.5) * spread,
    aim[1] + tangent[1] * (rand() - 0.5) * spread + bitangent[1] * (rand() - 0.5) * spread,
    aim[2] + tangent[2] * (rand() - 0.5) * spread + bitangent[2] * (rand() - 0.5) * spread,
  ]);
  return {
    dir,
    tangent: normalize(rotateAround(tangent, dir, tilt)),
    radius,
  };
}

function shellStart(index, count, radius, tilt, rand) {
  const height = Math.cos(((index + 0.5) / count) * Math.PI) * 0.8;
  const ring = Math.sqrt(Math.max(0, 1 - height * height));
  const theta = index * 2.399963 + (rand() - 0.5) * 0.35;
  const dir = normalize([Math.cos(theta) * ring, height, Math.sin(theta) * ring]);
  let tangent = normalize([-Math.sin(theta), 0, Math.cos(theta)]);
  const lean = tilt * (index % 2 === 0 ? 1 : -1);
  tangent = normalize(rotateAround(tangent, dir, lean));
  return { dir, tangent, radius: radius * (0.985 + rand() * 0.015) };
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

function traceArc(dir, tangent, radius, steps, stepAngle, drift, phase, turn, floor, ceiling) {
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
    const wobble = Math.sin(step * 0.65 + phase) * 0.008;
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
      mid.heading = heading.slice();
      mid.forward = forward.slice();
      mid.reach = reach;
    }
    heading = nextHeading;
    forward = normalize(rotateAround(nextForward, heading, Math.sin(step * 0.55 + phase) * turn));
    reach = Math.min(ceiling, Math.max(floor, reach + drift + Math.sin(step * 0.4 + phase) * 0.004));
  }
  return { points, heading: mid.heading, forward: mid.forward, reach: mid.reach };
}

function pushStrand(buffers, points, seed, layer) {
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
      buffers.layer.push(layer);
    }
  }
}

function createLatticeGeometry() {
  const buffers = { position: [], next: [], side: [], along: [], seed: [], layer: [] };
  for (const family of SHELL_FLOWS) {
    const rand = mulberry32(family.seed);
    for (let index = 0; index < family.count; index += 1) {
      const start = shellStart(index, family.count, family.radius, family.tilt, rand);
      const phase = rand() * Math.PI * 2;
      const arc = traceArc(start.dir, start.tangent, start.radius, family.steps, family.step, 0, phase, family.turn, 0.88, 1);
      pushStrand(buffers, arc.points, phase, 0);
    }
  }
  for (const family of INNER_CLUSTERS) {
    const rand = mulberry32(family.seed);
    for (let index = 0; index < family.count; index += 1) {
      const radius = family.min + rand() * (family.max - family.min);
      const start = clusterStart(family.axis, family.spread, radius, family.tilt, rand);
      const phase = rand() * Math.PI * 2;
      const drift = (index % 2 === 0 ? -1 : 1) * 0.004;
      const arc = traceArc(start.dir, start.tangent, radius, family.steps, family.step, drift, phase, family.turn, 0.24, 0.72);
      pushStrand(buffers, arc.points, phase + 1.4, 1);
      if (rand() < family.branch) {
        const turn = (rand() < 0.5 ? -1 : 1) * (0.7 + rand() * 0.35);
        const branchTangent = normalize(rotateAround(arc.forward, arc.heading, turn));
        const branch = traceArc(
          arc.heading,
          branchTangent,
          arc.reach,
          12,
          family.step * 0.85,
          -0.012,
          phase + 2.1,
          0.06,
          0.2,
          0.72
        );
        pushStrand(buffers, branch.points, phase + 2.4, 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(buffers.position, 3));
  geometry.setAttribute("aNext", new THREE.Float32BufferAttribute(buffers.next, 3));
  geometry.setAttribute("aSide", new THREE.Float32BufferAttribute(buffers.side, 1));
  geometry.setAttribute("aAlong", new THREE.Float32BufferAttribute(buffers.along, 1));
  geometry.setAttribute("aSeed", new THREE.Float32BufferAttribute(buffers.seed, 1));
  geometry.setAttribute("aLayer", new THREE.Float32BufferAttribute(buffers.layer, 1));
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
      attribute float aLayer;
      uniform vec2 uResolution;
      uniform float uThickness;
      uniform float uTime;
      varying float vSide;
      varying float vAlong;
      varying float vSeed;
      varying float vRadius;
      varying float vLayer;
      void main() {
        float sway = sin(uTime * 0.28 + aSeed) * 0.028;
        float cs = cos(sway);
        float sn = sin(sway);
        float breath = 1.0 + sin(uTime * 0.42 + aSeed * 1.7) * 0.01;
        vec3 shaped = vec3(position.x * cs - position.z * sn, position.y, position.x * sn + position.z * cs) * breath;
        vec3 next = vec3(aNext.x * cs - aNext.z * sn, aNext.y, aNext.x * sn + aNext.z * cs) * breath;
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(shaped, 1.0);
        vec4 clipNext = projectionMatrix * modelViewMatrix * vec4(next, 1.0);
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
        vLayer = aLayer;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uPace;
      uniform float uHot;
      uniform vec3 uBlue;
      uniform vec3 uCyan;
      uniform vec3 uViolet;
      uniform vec3 uMagenta;
      varying float vSide;
      varying float vAlong;
      varying float vSeed;
      varying float vRadius;
      varying float vLayer;
      void main() {
        float pace = max(uPace, 0.4);
        float spine = pow(clamp(1.0 - abs(vSide), 0.0, 1.0), 1.45);
        float travel = 0.62 + 0.38 * sin(vAlong * 22.0 - uTime * (0.24 + pace * 0.16) + vSeed);
        float dye = fract(sin(vSeed * 12.9898) * 43758.5453);
        vec3 shell = mix(uBlue, uCyan, smoothstep(0.32, 0.78, dye));
        vec3 inner = mix(uViolet, uMagenta, smoothstep(0.2, 0.75, dye));
        inner = mix(inner, uMagenta, smoothstep(0.52, 0.28, vRadius) * 0.55);
        vec3 strand = mix(shell, inner, vLayer);
        float point = smoothstep(0.035, 0.0, vRadius);
        strand = mix(strand, vec3(0.86, 0.95, 1.0), point * spine);
        strand *= (0.72 + spine * 0.4) * (0.84 + travel * 0.16);
        float alpha = (0.42 + spine * 0.5) * (0.86 + travel * 0.14);
        alpha *= mix(1.0, 0.86, vLayer);
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
      uniform vec3 uCyan;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float facing = pow(clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0), 3.2);
        vec3 color = mix(uCyan, vec3(1.0), 0.2 + facing * 0.8);
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

  const heartGeometry = new THREE.SphereGeometry(0.02, 24, 16);
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
