// Crisp point sprites and one thin spherical rim. Motion stays in the
// vertex shader. No volume, nebula, or bloom.

import * as THREE from "three";

const VIOLET = new THREE.Color(0xb026ff);

export function createSharedUniforms() {
  return {
    uTime: { value: 0 },
    uRadius: { value: 0.58 },
    uPace: { value: 1 },
    uBubble: { value: 0.17 },
    uWave: { value: 0 },
    uWaveAmp: { value: 0.5 },
    uSize: { value: 0.066 },
    uDpr: { value: 1 },
    uHeight: { value: 900 },
    uHot: { value: 0.2 },
    uOpacity: { value: 0.95 },
    uColor: { value: VIOLET.clone() },
    uPointer: { value: new THREE.Vector2() },
  };
}

export function createCoreSprite() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.55)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

export function createCorePointMaterial(shared, map) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uRadius: shared.uRadius,
      uPace: shared.uPace,
      uBubble: shared.uBubble,
      uWave: shared.uWave,
      uWaveAmp: shared.uWaveAmp,
      uSize: shared.uSize,
      uDpr: shared.uDpr,
      uHeight: shared.uHeight,
      uHot: shared.uHot,
      uOpacity: shared.uOpacity,
      uColor: shared.uColor,
      uPointer: shared.uPointer,
      uMap: { value: map },
    },
    vertexShader: `
      attribute vec3 aDir;
      attribute float aBallR;
      attribute float aPhase;
      attribute float aSpeed;
      uniform float uTime;
      uniform float uRadius;
      uniform float uPace;
      uniform float uBubble;
      uniform float uWave;
      uniform float uWaveAmp;
      uniform float uSize;
      uniform float uDpr;
      uniform float uHeight;
      uniform vec2 uPointer;
      varying float vShade;
      varying float vCore;
      void main() {
        float pace = max(uPace, 0.25);
        float home = aBallR * uRadius;
        float boil = sin(uTime * 0.34 * pace + aPhase) * uBubble * (0.36 + 0.08 * aSpeed);
        float field = sin(uTime * 0.15 * pace + aDir.y * 2.1 + aDir.x * 1.3) * uBubble * 0.26;
        float ripple = sin(aBallR * 2.1 - uTime * (0.45 + pace * 0.22)) * uWaveAmp * uWave;
        float r = max(home + boil + field + ripple, 0.02);
        vec3 p = aDir * r;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uSize * uDpr * (uHeight * 0.5) / max(-mv.z, 0.2);
        vec3 lightDir = normalize(vec3(uPointer.x * 0.65, uPointer.y * 0.45, 1.0));
        vec3 viewNormal = normalize(mat3(modelViewMatrix) * aDir);
        float key = clamp(dot(viewNormal, lightDir), 0.0, 1.0);
        float facing = clamp(viewNormal.z, 0.0, 1.0);
        vShade = mix(0.74, 1.0, facing) * (0.9 + key * 0.1);
        vCore = smoothstep(0.34, 0.02, r);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      uniform float uHot;
      uniform float uOpacity;
      varying float vShade;
      varying float vCore;
      void main() {
        vec4 tex = texture2D(uMap, gl_PointCoord);
        if (tex.a < 0.01) discard;
        float tip = smoothstep(0.78, 1.0, tex.a) * vCore * smoothstep(0.55, 1.0, uHot);
        vec3 col = mix(uColor, vec3(1.0), tip);
        col *= vShade * tex.rgb;
        gl_FragColor = vec4(pow(col, vec3(0.4545)), tex.a * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

const SHELL_POINTS = 112;

// Fixed points on the unit sphere. They carry no animation of their own.
// Parenting them to the particle rotor is what rotates the boundary.
export function createShellGeometry(count = SHELL_POINTS) {
  const total = Math.max(8, count | 0);
  const position = new Float32Array(total * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < total; i += 1) {
    const y = 1 - (i / (total - 1)) * 2;
    const radial = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const offset = i * 3;
    position[offset] = Math.cos(theta) * radial;
    position[offset + 1] = y;
    position[offset + 2] = Math.sin(theta) * radial;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
  return geometry;
}

function createShellMaterial(shared, map) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uDpr: shared.uDpr,
      uHeight: shared.uHeight,
      uMap: { value: map },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    vertexShader: `
      uniform float uDpr;
      uniform float uHeight;
      varying float vFacing;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 viewDir = normalize(mat3(modelViewMatrix) * position);
        vFacing = clamp(viewDir.z, 0.0, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = 0.052 * uDpr * (uHeight * 0.5) / max(-mv.z, 0.2);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      varying float vFacing;
      void main() {
        vec4 tex = texture2D(uMap, gl_PointCoord);
        if (tex.a < 0.04) discard;
        float shade = mix(0.42, 1.0, vFacing);
        vec3 col = vec3(0.72, 0.36, 1.0) * shade * tex.rgb;
        gl_FragColor = vec4(pow(col, vec3(0.4545)), tex.a * 0.8);
      }
    `,
  });
}

export function createShellPoints(shared, map) {
  const points = new THREE.Points(createShellGeometry(), createShellMaterial(shared, map));
  points.frustumCulled = false;
  return points;
}

function createShellSurfaceMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    toneMapped: false,
    vertexShader: `
      varying vec3 vNormalV;
      varying vec3 vView;
      varying float vObjectY;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormalV = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        vObjectY = position.y;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying vec3 vNormalV;
      varying vec3 vView;
      varying float vObjectY;
      void main() {
        float ndv = abs(dot(normalize(vNormalV), normalize(vView)));
        float rim = smoothstep(0.5, 0.0, ndv);
        float edge = pow(rim, 1.2);
        float form = 0.78 + 0.22 * (vObjectY * 0.5 + 0.5);
        float side = gl_FrontFacing ? 1.0 : 0.4;
        float alpha = edge * form * side * 0.9;
        if (alpha < 0.04) discard;
        vec3 col = mix(vec3(0.42, 0.16, 0.78), vec3(0.78, 0.48, 1.0), edge);
        gl_FragColor = vec4(pow(col, vec3(0.4545)), alpha);
      }
    `,
  });
}

// One group: the spherical surface plus the fixed markers. The scene
// parents this group to the particle rotor and scales it to the hull.
export function createShell(shared, map) {
  const group = new THREE.Group();
  const surface = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), createShellSurfaceMaterial());
  surface.frustumCulled = false;
  surface.renderOrder = 4;
  const markers = createShellPoints(shared, map);
  markers.renderOrder = 5;
  group.add(surface, markers);
  return group;
}
