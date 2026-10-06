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
    uMode: { value: 0 },
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
      uMode: shared.uMode,
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
      uniform float uMode;
      uniform float uSize;
      uniform float uDpr;
      uniform float uHeight;
      uniform vec2 uPointer;
      varying float vShade;
      varying float vCore;
      void main() {
        float r = aBallR * uRadius + sin(uTime * aSpeed * uPace + aPhase) * uBubble;
        if (uMode > 2.5) r += sin(aBallR * 5.5 - uTime * 5.0) * uWaveAmp;
        else if (uMode > 1.5) r += sin(aBallR * 4.2 - uTime * 3.6) * (uWaveAmp * uWave);
        else if (uMode > 0.5) r += sin(aBallR * 2.0 - uTime * 0.55) * (uWaveAmp * uWave);
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

export function createBoundaryMaterial() {
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
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormalV = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying vec3 vNormalV;
      varying vec3 vView;
      void main() {
        float ndv = abs(dot(normalize(vNormalV), normalize(vView)));
        float rim = smoothstep(0.2, 0.015, ndv);
        float alpha = rim * 0.42;
        if (alpha < 0.02) discard;
        vec3 col = vec3(0.62, 0.28, 0.98);
        gl_FragColor = vec4(pow(col, vec3(0.4545)), alpha);
      }
    `,
  });
}
