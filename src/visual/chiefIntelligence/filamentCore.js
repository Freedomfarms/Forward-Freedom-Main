// One spherical volume. Filaments are ridges in a warped field, so the
// ball stays round and the interior reads as woven light.

import * as THREE from "three";

export const FILAMENT_ANCHOR_Y = 0.426;
export const FILAMENT_COLORS = Object.freeze({
  magenta: 0xff4ad8,
  violet: 0x9b4dff,
});

export function createFilamentMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uPace;
      uniform float uHot;
      uniform vec3 uCamLocal;
      uniform vec3 uMagenta;
      uniform vec3 uViolet;
      varying vec3 vLocal;

      float thread(vec3 p, float scale, float speed) {
        vec3 q = p * scale;
        float t = uTime * speed;
        q += 0.24 * vec3(
          sin(q.y * 1.6 + q.z * 0.7 + t),
          sin(q.z * 1.4 + q.x * 0.6 - t * 0.7),
          sin(q.x * 1.5 + q.y * 0.5 + t * 0.5)
        );
        float a = 1.0 - abs(sin(q.x + q.y * 0.28));
        float b = 1.0 - abs(sin(q.y + q.z * 0.33));
        float c = 1.0 - abs(sin(q.z + q.x * 0.3));
        return pow(a * b, 6.0) + pow(b * c, 6.0) + pow(c * a, 6.0);
      }

      void main() {
        vec3 ro = vLocal;
        vec3 rd = normalize(vLocal - uCamLocal);
        float pace = max(uPace, 0.4);
        vec3 radiance = vec3(0.0);
        float alpha = 0.0;
        for (int i = 0; i < 24; i++) {
          vec3 p = ro + rd * (float(i) * 0.085);
          float radius = length(p);
          if (radius > 1.01) break;
          float shell = smoothstep(1.0, 0.55, radius);
          float filaments = (
            thread(p, 6.2, 0.14 * pace) +
            thread(vec3(p.z, p.x, p.y), 4.8, 0.1 * pace)
          ) * shell;
          vec3 color = mix(uViolet, uMagenta, clamp(filaments * 0.4, 0.0, 1.0));
          color = mix(color, vec3(1.0), uHot * 0.12);
          float sampleAlpha = clamp(filaments * 0.4, 0.0, 0.4);
          radiance += color * sampleAlpha * (1.0 - alpha);
          alpha += sampleAlpha * (1.0 - alpha);
        }
        float closest = length(cross(rd, ro));
        float heart = exp(-closest * closest * 22.0);
        radiance = mix(radiance, vec3(1.0), heart);
        alpha = clamp(max(alpha, heart * 0.9), 0.0, 1.0);
        gl_FragColor = vec4(mix(radiance / max(alpha, 0.001), vec3(1.0), heart), alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.FrontSide,
    blending: THREE.NormalBlending,
    toneMapped: false,
  });
}

export function createGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,0.55)");
  gradient.addColorStop(0.22, "rgba(255,90,210,0.28)");
  gradient.addColorStop(0.55, "rgba(150,60,255,0.08)");
  gradient.addColorStop(1, "rgba(120,40,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

export function createFilamentCore(uniforms) {
  const root = new THREE.Group();
  root.name = "chief-filament-core";
  const geometry = new THREE.SphereGeometry(1, 64, 48);
  const material = createFilamentMaterial(uniforms);
  const volume = new THREE.Mesh(geometry, material);
  volume.name = "filament-volume";
  volume.frustumCulled = false;
  volume.renderOrder = 2;
  root.add(volume);

  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: createGlowTexture(),
      color: FILAMENT_COLORS.magenta,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
  );
  glow.name = "filament-glow";
  glow.scale.set(1.55, 1.55, 1);
  glow.renderOrder = 1;
  root.add(glow);

  root.userData.disposeCore = () => {
    geometry.dispose();
    material.dispose();
    glow.material.map?.dispose();
    glow.material.dispose();
  };
  return root;
}
