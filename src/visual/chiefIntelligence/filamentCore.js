// Independent arcs in four radius bands. A few dozen long paths read as
// an empty cage: the luminous volume comes from many short arcs, each
// with its own heading, packed through the shell and the interior.

import * as THREE from "three";

export const FILAMENT_ANCHOR_Y = 0.426;
export const FILAMENT_COLORS = Object.freeze({
  magenta: 0xff4ad8,
  violet: 0x9b4dff,
  blue: 0x4da3ff,
  cyan: 0x5ce8ff,
});

const BANDS = Object.freeze([
  Object.freeze({ count: 1500, min: 0.9, max: 1, steps: 10, step: 0.09, seed: 5, dive: 0.22, branch: 0.28, layer: 0, floor: 0.74, ceiling: 1, turn: 0.05 }),
  Object.freeze({ count: 900, min: 0.55, max: 0.86, steps: 9, step: 0.095, seed: 19, dive: 0.32, branch: 0.34, layer: 1, floor: 0.3, ceiling: 0.9, turn: 0.06 }),
  Object.freeze({ count: 480, min: 0.26, max: 0.54, steps: 8, step: 0.09, seed: 37, dive: 0.16, branch: 0.3, layer: 1, floor: 0.14, ceiling: 0.6, turn: 0.07 }),
  Object.freeze({ count: 220, min: 0.08, max: 0.24, steps: 6, step: 0.08, seed: 101, dive: 0, branch: 0, layer: 1, floor: 0.05, ceiling: 0.28, turn: 0.05 }),
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

function direction(rand) {
  const z = rand() * 2 - 1;
  const theta = rand() * Math.PI * 2;
  const ring = Math.sqrt(Math.max(0, 1 - z * z));
  return [ring * Math.cos(theta), ring * Math.sin(theta), z];
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
  for (const family of BANDS) {
    const rand = mulberry32(family.seed);
    for (let index = 0; index < family.count; index += 1) {
      const dir = direction(rand);
      const tangent = tangentFrame(dir, rand);
      const radius = family.min + rand() * (family.max - family.min);
      const diving = rand() < family.dive;
      const drift = diving ? -0.01 - rand() * 0.016 : 0;
      const phase = rand() * Math.PI * 2;
      const arc = traceArc(
        dir,
        tangent,
        radius,
        family.steps,
        family.step,
        drift,
        phase,
        family.turn,
        family.floor,
        family.ceiling
      );
      pushStrand(buffers, arc.points, phase, family.layer);
      if (rand() < family.branch) {
        const split = (rand() < 0.5 ? -1 : 1) * (0.65 + rand() * 0.4);
        const branchTangent = normalize(rotateAround(arc.forward, arc.heading, split));
        const branch = traceArc(
          arc.heading,
          branchTangent,
          arc.reach,
          8,
          family.step,
          -0.014,
          phase + 1.7,
          family.turn,
          Math.max(0.06, family.floor - 0.12),
          family.ceiling
        );
        pushStrand(buffers, branch.points, phase + 0.4, family.layer);
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
      uniform float uIdle;
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
        float idle = clamp(uIdle, 0.0, 1.0);
        float rate = mix(0.21, 0.31, aLayer);
        float weave = sin(uTime * rate + aSeed * 2.3);
        float crosswise = cos(uTime * rate * 0.73 + aSeed * 1.4);
        vec3 radial = normalize(shaped);
        vec3 heading = next - shaped;
        float headingLength = length(heading);
        heading = headingLength > 0.0001 ? heading / headingLength : vec3(0.0, 1.0, 0.0);
        vec3 side = cross(radial, heading);
        float sideLength = length(side);
        side = sideLength > 0.0001 ? side / sideLength : vec3(1.0, 0.0, 0.0);
        vec3 drift = (side * weave + cross(radial, side) * crosswise) * idle * mix(0.008, 0.014, aLayer);
        shaped += drift;
        next += drift;
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
      uniform float uIdle;
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
        float spine = pow(clamp(1.0 - abs(vSide), 0.0, 1.0), 1.7);
        float travel = 0.58 + 0.42 * sin(vAlong * 28.0 - uTime * (0.28 + pace * 0.16) + vSeed);
        float dye = fract(sin(vSeed * 12.9898) * 43758.5453);
        vec3 royal = vec3(uBlue.r * 0.78, uBlue.g * 0.5, uBlue.b) * 1.12;
        float cyanAlong = smoothstep(0.48, 0.94, dye);
        vec3 shell = mix(royal, uCyan, cyanAlong * (0.35 + spine * 0.65));
        shell = mix(shell, uViolet, smoothstep(0.92, 1.0, dye) * 0.15);
        vec3 inner = mix(uViolet, uMagenta, smoothstep(0.18, 0.82, dye));
        inner *= 1.12;
        vec3 strand = mix(shell, inner, vLayer);
        float reach = smoothstep(0.14, 0.0, vRadius);
        float hot = smoothstep(0.065, 0.0, vRadius);
        vec3 coreTint = mix(uCyan, vec3(1.0), hot);
        strand = mix(strand, coreTint, mix(reach * 0.2, 0.5, hot));
        strand *= (0.5 + spine * 0.95) * (0.8 + travel * 0.24);
        float alpha = (0.1 + spine * 0.68) * (0.8 + travel * 0.18);
        alpha *= mix(1.22, 0.78, vLayer);
        float traveler = fract(sin(vSeed * 91.7) * 43758.5453);
        float chosen = smoothstep(0.988, 0.997, traveler);
        float sparkAt = fract(uTime * 0.055 + traveler);
        float span = abs(vAlong - sparkAt);
        span = min(span, 1.0 - span);
        float spark = smoothstep(0.035, 0.0, span) * chosen * clamp(uIdle, 0.0, 1.0) * spine;
        strand = mix(strand, mix(uCyan, vec3(1.0), 0.7), spark);
        alpha += spark * 0.28;
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

function createHaloMaterial(uniforms) {
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
      uniform float uPulse;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float ndot = clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0);
        float glow = pow(smoothstep(0.35, 0.96, ndot), 1.25);
        vec3 color = mix(uCyan, vec3(1.0), smoothstep(0.45, 0.92, ndot));
        gl_FragColor = vec4(color, glow * 0.36 * (1.0 + uPulse * 0.14));
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
      uniform float uPulse;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float ndot = clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0);
        float core = pow(ndot, 3.2);
        float halo = pow(ndot, 1.05);
        vec3 color = mix(uCyan, vec3(1.0), core);
        gl_FragColor = vec4(color, mix(halo * 0.38, 0.92, core) * (1.0 + uPulse * 0.1));
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

  const haloGeometry = new THREE.SphereGeometry(0.135, 32, 24);
  const halo = new THREE.Mesh(haloGeometry, createHaloMaterial(uniforms));
  halo.name = "filament-halo";
  halo.frustumCulled = false;
  halo.renderOrder = 3;
  root.add(halo);

  const heartGeometry = new THREE.SphereGeometry(0.045, 24, 16);
  const heart = new THREE.Mesh(heartGeometry, createHeartMaterial(uniforms));
  heart.name = "filament-heart";
  heart.frustumCulled = false;
  heart.renderOrder = 4;
  root.add(heart);

  root.userData.disposeCore = () => {
    geometry.dispose();
    material.dispose();
    haloGeometry.dispose();
    halo.material.dispose();
    heartGeometry.dispose();
    heart.material.dispose();
  };
  return root;
}
