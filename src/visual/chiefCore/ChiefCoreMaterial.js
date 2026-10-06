// Shaders for the homepage core. Colors live here so lighting can change
// without touching interaction or React.

import * as THREE from "three";

const NOISE = `
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z
  );
}
`;

export function createSharedUniforms() {
  return {
    uTime: { value: 0 },
    uInward: { value: 0 },
    uOutward: { value: 0 },
    uHot: { value: 0.34 },
    uEnergy: { value: 0.28 },
    uOrder: { value: 0.18 },
    uPointer: { value: new THREE.Vector2() },
    uCamLocal: { value: new THREE.Vector3(0, 0, 6) },
    uPointScale: { value: 1 },
    uDpr: { value: 1 },
    uOpacity: { value: 0.7 },
  };
}

function shaderMaterial(vertex, fragment, uniforms, blending) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending,
    toneMapped: false,
  });
}

export function createNebulaMaterial(shared) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime },
    side: THREE.BackSide,
    depthWrite: true,
    depthTest: true,
    toneMapped: true,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      ${NOISE}
      varying vec3 vDir;
      uniform float uTime;
      void main() {
        vec3 p = normalize(vDir);
        float n = vnoise(p * 1.55 + vec3(uTime * 0.012, 0.2, 0.0));
        float m = vnoise(p * 2.7 - vec3(0.0, uTime * 0.008, 0.2));
        vec3 col = vec3(0.012, 0.007, 0.026);
        col += vec3(0.10, 0.035, 0.18) * smoothstep(0.4, 0.84, n);
        col += vec3(0.18, 0.08, 0.28) * m * 0.32;
        float vignette = smoothstep(1.2, 0.1, length(p.xy));
        col *= 0.5 + 0.7 * vignette;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

export function createVolumeMaterial(shared) {
  const material = shaderMaterial(
    `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    `
      ${NOISE}
      varying vec3 vPos;
      uniform float uTime;
      uniform float uInward;
      uniform float uHot;
      uniform float uEnergy;
      uniform vec2 uPointer;
      uniform vec3 uCamLocal;
      void main() {
        vec3 ro = uCamLocal;
        vec3 rd = normalize(vPos - uCamLocal);
        float b = dot(ro, rd);
        float c = dot(ro, ro) - 1.0;
        float h = b * b - c;
        if (h < 0.0) discard;
        float s = sqrt(h);
        float tNear = max(-b - s, 0.0);
        float tFar = -b + s;
        float span = max(tFar - tNear, 0.001);
        vec3 acc = vec3(0.0);
        float alpha = 0.0;
        const int STEPS = 4;
        float dt = span / float(STEPS);
        for (int i = 0; i < STEPS; i++) {
          float t = tNear + dt * (float(i) + 0.5);
          vec3 p = ro + rd * t;
          float warp = vnoise(p * 1.65 + vec3(0.0, uTime * 0.055, uTime * 0.02));
          vec3 q = p + (warp - 0.5) * 0.3;
          float body = vnoise(q * 2.5 + vec3(uTime * 0.08, 0.0, -uTime * 0.035));
          float flow = vnoise(q * 4.1 + vec3(-uTime * 0.13, uTime * 0.045, 0.4));
          float radius = length(p);
          float gather = mix(1.0, smoothstep(0.98, 0.1, radius), uInward);
          float falloff = mix(8.2, 3.0, uHot);
          float core = exp(-radius * radius * falloff);
          vec3 violet = mix(vec3(0.14, 0.035, 0.30), vec3(0.50, 0.30, 0.90), body);
          violet += vec3(0.24, 0.10, 0.42) * flow * (0.3 + uEnergy);
          vec3 hot = vec3(1.0, 0.96, 1.0) * core * (0.5 + uHot * 1.25);
          float density = (0.2 + body * 0.58) * gather * (0.62 + uEnergy * 0.55);
          density += core * (1.7 + uHot);
          float a = clamp(density * dt * 1.45, 0.0, 0.75);
          acc += (violet * (0.32 + body) + hot) * a * (1.0 - alpha);
          alpha += a * (1.0 - alpha);
        }
        vec3 n = normalize(vPos);
        vec3 viewDir = normalize(uCamLocal - vPos);
        float fres = pow(1.0 - clamp(dot(n, viewDir), 0.0, 1.0), 2.1);
        vec3 lightDir = normalize(vec3(uPointer.x * 0.7, uPointer.y * 0.45, 1.0));
        float key = pow(clamp(dot(n, lightDir), 0.0, 1.0), 1.7);
        acc += vec3(0.45, 0.26, 0.78) * fres * 0.2;
        acc += vec3(0.62, 0.48, 0.95) * key * 0.14 * (0.35 + uEnergy);
        alpha = clamp(alpha + fres * 0.06, 0.0, 0.9);
        gl_FragColor = vec4(acc * alpha, alpha);
      }
    `,
    {
      uTime: shared.uTime,
      uInward: shared.uInward,
      uHot: shared.uHot,
      uEnergy: shared.uEnergy,
      uPointer: shared.uPointer,
      uCamLocal: shared.uCamLocal,
    },
    THREE.NormalBlending
  );
  material.depthTest = true;
  material.premultipliedAlpha = true;
  return material;
}

export function createShellMaterial(shared, { power, gain, colorA, colorB }) {
  return shaderMaterial(
    `
      varying vec3 vNormalV;
      varying vec3 vView;
      varying vec3 vPos;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormalV = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        vPos = position;
        gl_Position = projectionMatrix * mv;
      }
    `,
    `
      varying vec3 vNormalV;
      varying vec3 vView;
      varying vec3 vPos;
      uniform float uTime;
      uniform float uEnergy;
      uniform vec2 uPointer;
      void main() {
        float fres = pow(1.0 - clamp(dot(normalize(vNormalV), normalize(vView)), 0.0, 1.0), ${power.toFixed(2)});
        float sweep = 0.5 + 0.5 * sin(vPos.y * 4.5 + uTime * 0.45 + uPointer.x * 1.4);
        vec3 col = mix(vec3(${colorA}), vec3(${colorB}), smoothstep(0.15, 0.92, fres));
        col += vec3(0.18, 0.08, 0.32) * sweep * fres * 0.35;
        float alpha = fres * (${gain.toFixed(3)}) * (0.72 + uEnergy * 0.4) * (0.8 + sweep * 0.2);
        if (alpha < 0.012) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `,
    {
      uTime: shared.uTime,
      uEnergy: shared.uEnergy,
      uPointer: shared.uPointer,
    },
    THREE.AdditiveBlending
  );
}

export function createParticleMaterial(shared, affect) {
  return shaderMaterial(
    `
      attribute vec3 aDir;
      attribute float aSeed;
      attribute float aKind;
      uniform float uTime;
      uniform float uInward;
      uniform float uOutward;
      uniform float uEnergy;
      uniform float uOrder;
      uniform float uPointScale;
      uniform float uDpr;
      uniform float uAffect;
      varying float vKind;
      varying float vSeed;
      void main() {
        float seed = aSeed;
        float affect = uAffect;
        vec3 p;
        if (aKind < 0.5) {
          float radial = mix(0.05, 0.96, fract(seed * 4.13));
          radial *= mix(1.0, 0.36 + 0.08 * sin(uTime * 2.1 + seed * 8.0), uInward * affect);
          float burst = fract(seed * 0.73 + uTime * mix(0.035, 0.22, uOutward));
          radial = mix(radial, mix(0.02, 1.24, burst), clamp(uOutward * affect, 0.0, 1.0));
          float ang = uTime * mix(0.16, 0.58, seed) * (1.0 + uInward * 1.5) + seed * 6.2831853;
          float c = cos(ang);
          float s = sin(ang);
          vec3 d = aDir;
          d = vec3(d.x * c - d.z * s, d.y, d.x * s + d.z * c);
          float bob = sin(uTime * 0.75 + seed * 14.0) * 0.04 * (1.0 - uOrder);
          p = d * radial + vec3(0.0, bob, 0.0);
        } else if (aKind < 1.5) {
          float r = mix(1.2, 1.78, seed) * mix(1.0, 0.9, uOrder);
          float a = uTime * mix(0.09, 0.24, fract(seed * 9.1)) * (1.0 + uEnergy * 0.3) + seed * 6.2831853;
          float incline = (seed - 0.5) * 0.95;
          p = vec3(cos(a) * r, sin(a) * sin(incline) * r * 0.55, sin(a) * r * 0.7);
        } else if (aKind < 2.5) {
          float a = uTime * (0.2 + seed * 0.18) + seed * 6.2831853;
          float r = mix(0.22, 1.08, 0.5 + 0.5 * sin(a * 0.65));
          r = mix(r, r * 0.42, uInward * affect);
          r = mix(r, r * 1.32, uOutward * affect);
          p = vec3(cos(a * 1.25) * r, sin(a * 0.75) * r * 0.7, sin(a) * r);
        } else {
          float r = mix(2.5, 5.8, seed);
          float a = uTime * 0.025 + seed * 6.2831853;
          p = vec3(cos(a) * r, (seed - 0.5) * 3.4, sin(a) * r * 0.82);
        }
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = mix(1.7, 3.5, fract(seed * 3.7));
        if (aKind > 1.5 && aKind < 2.5) size *= 1.75;
        if (aKind > 2.5) size *= 0.65;
        gl_PointSize = clamp(size * uPointScale * uDpr * (150.0 / max(1.2, -mv.z)), 1.0, 14.0);
        vKind = aKind;
        vSeed = seed;
      }
    `,
    `
      varying float vKind;
      varying float vSeed;
      uniform float uHot;
      uniform float uOpacity;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;
        float glow = smoothstep(0.5, 0.05, d);
        vec3 col = vec3(0.58, 0.4, 0.92);
        if (vKind < 0.5) {
          col = mix(vec3(0.42, 0.18, 0.78), vec3(1.0, 0.95, 1.0), glow * (0.3 + uHot * 0.7));
        } else if (vKind < 1.5) {
          col = vec3(0.52, 0.34, 0.88);
        } else if (vKind < 2.5) {
          col = mix(vec3(0.78, 0.66, 1.0), vec3(1.0, 0.98, 1.0), glow);
        } else {
          col = vec3(0.38, 0.24, 0.58);
        }
        float alpha = glow * uOpacity;
        if (vKind > 2.5) alpha *= 0.4;
        gl_FragColor = vec4(col * (0.75 + vSeed * 0.25), alpha);
      }
    `,
    {
      uTime: shared.uTime,
      uInward: shared.uInward,
      uOutward: shared.uOutward,
      uEnergy: shared.uEnergy,
      uOrder: shared.uOrder,
      uHot: shared.uHot,
      uPointScale: shared.uPointScale,
      uDpr: shared.uDpr,
      uOpacity: shared.uOpacity,
      uAffect: { value: affect },
    },
    THREE.AdditiveBlending
  );
}

export function createWaveMaterial() {
  return shaderMaterial(
    `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    `
      varying vec2 vUv;
      uniform float uRadius;
      uniform float uStrength;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float band = exp(-pow((r - uRadius) * 16.0, 2.0));
        float fade = smoothstep(1.15, 0.2, uRadius) * uStrength;
        float alpha = band * fade;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(vec3(0.58, 0.42, 0.92), alpha);
      }
    `,
    {
      uRadius: { value: 0.4 },
      uStrength: { value: 0 },
    },
    THREE.AdditiveBlending
  );
}

export function createGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.16, "rgba(255,247,255,0.95)");
  gradient.addColorStop(0.38, "rgba(198,176,255,0.32)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
