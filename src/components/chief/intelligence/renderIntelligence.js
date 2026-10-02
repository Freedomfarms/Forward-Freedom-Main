import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  NoToneMapping,
  NormalBlending,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";

import { CORE_PARTICLE_COUNT, coreScale, createCoreParticles } from "./chiefIntelligence.js";
import {
  heartFragment,
  heartVertex,
  particleFragment,
  particleVertex,
  fieldFragment,
  fieldVertex,
  shellFragment,
  shellVertex,
  volumeFragment,
  volumeVertex,
} from "./coreShaders.js";

function sharedUniforms() {
  return {
    uTime: { value: 0 },
    uSpeed: { value: 1 },
    uGlow: { value: 0.6 },
    uDensity: { value: 0.8 },
    uWave: { value: 0.8 },
    uFlicker: { value: 0.2 },
    uActivity: { value: 0.5 },
    uOutflow: { value: 0.1 },
    uOrganize: { value: 0.2 },
    uPixelRatio: { value: 1 },
    uCameraLocal: { value: new Vector3(0, 0, 4) },
  };
}

function material(uniforms, vertexShader, fragmentShader, blending) {
  return new ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending,
    premultipliedAlpha: true,
  });
}

function applyMotion(uniforms, motion, time, pixelRatio) {
  uniforms.uTime.value = time;
  uniforms.uSpeed.value = Number(motion?.speed) || 0;
  uniforms.uGlow.value = Number(motion?.glow) || 0;
  const density = Number(motion?.density) || 0;
  const intensity = Number(motion?.intensity) || 0;
  uniforms.uDensity.value = density * (0.65 + intensity * 0.45);
  uniforms.uWave.value = Number(motion?.wave) || 0;
  uniforms.uFlicker.value = Number(motion?.flicker) || 0;
  uniforms.uActivity.value = Number(motion?.particle) || 0;
  uniforms.uOutflow.value = Number(motion?.outflow) || 0;
  uniforms.uOrganize.value = Number(motion?.organize) || 0;
  uniforms.uPixelRatio.value = pixelRatio;
}

export function createIntelligenceRenderer(canvas) {
  const renderer = new WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(32, 1, 0.1, 30);
  camera.position.set(0, 0.08, 5.85);
  camera.lookAt(0, 0, 0);

  const uniforms = sharedUniforms();
  const root = new Group();
  root.position.set(0, 0.1, 0);

  const sphere = new SphereGeometry(1, 72, 56);

  const field = new Mesh(sphere, material(uniforms, fieldVertex, fieldFragment, AdditiveBlending));
  field.scale.setScalar(1.62);
  field.renderOrder = 1;
  field.frustumCulled = false;

  const heart = new Mesh(sphere, material(uniforms, heartVertex, heartFragment, AdditiveBlending));
  heart.scale.setScalar(0.4);
  heart.renderOrder = 4;
  heart.frustumCulled = false;

  const volume = new Mesh(sphere, material(uniforms, volumeVertex, volumeFragment, NormalBlending));
  volume.renderOrder = 2;
  volume.frustumCulled = false;

  const layout = createCoreParticles(CORE_PARTICLE_COUNT);
  const pointsGeometry = new BufferGeometry();
  pointsGeometry.setAttribute("position", new BufferAttribute(layout.directions.slice(), 3));
  pointsGeometry.setAttribute("aDir", new BufferAttribute(layout.directions, 3));
  pointsGeometry.setAttribute("aRadius", new BufferAttribute(layout.radii, 1));
  pointsGeometry.setAttribute("aSeed", new BufferAttribute(layout.seeds, 4));
  const particles = new Points(
    pointsGeometry,
    material(uniforms, particleVertex, particleFragment, AdditiveBlending)
  );
  particles.renderOrder = 5;
  particles.frustumCulled = false;

  const membrane = new Mesh(
    sphere,
    material(
      {
        uGlow: uniforms.uGlow,
        uAlpha: { value: 0.28 },
      },
      shellVertex,
      shellFragment,
      AdditiveBlending
    )
  );
  membrane.scale.setScalar(1.03);
  membrane.renderOrder = 6;
  membrane.frustumCulled = false;

  root.add(field, heart, volume, particles, membrane);
  scene.add(root);

  const cameraLocal = new Vector3();
  let bufferWidth = 0;
  let bufferHeight = 0;
  let pixelRatio = 1;

  function render({ cssWidth, cssHeight, pixelRatio: nextRatio, time, motion, amplitude }) {
    const width = Math.max(1, cssWidth || 1);
    const height = Math.max(1, cssHeight || 1);
    const ratio = Math.min(Math.max(nextRatio || 1, 1), 1.5);
    const nextBufferWidth = Math.floor(width * ratio);
    const nextBufferHeight = Math.floor(height * ratio);
    if (
      nextBufferWidth !== bufferWidth ||
      nextBufferHeight !== bufferHeight ||
      ratio !== pixelRatio
    ) {
      pixelRatio = ratio;
      bufferWidth = nextBufferWidth;
      bufferHeight = nextBufferHeight;
      renderer.setPixelRatio(ratio);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }

    const breathe = coreScale(time, motion, amplitude);
    const body = Number(motion?.body) || 1;
    const spin = Number(motion?.spin) || 0;
    root.scale.setScalar(breathe * body);
    root.rotation.y = time * 0.11 * spin;
    root.rotation.x = Math.sin(time * 0.13) * 0.045;
    root.rotation.z = Math.sin(time * 0.09 + 0.6) * 0.03 * spin;
    root.updateWorldMatrix(true, true);
    cameraLocal.copy(camera.position);
    volume.worldToLocal(cameraLocal);
    uniforms.uCameraLocal.value.copy(cameraLocal);
    applyMotion(uniforms, motion, time, ratio);
    membrane.material.uniforms.uGlow.value = uniforms.uGlow.value;
    renderer.render(scene, camera);
  }

  function dispose() {
    renderer.dispose();
    sphere.dispose();
    pointsGeometry.dispose();
    field.material.dispose();
    heart.material.dispose();
    volume.material.dispose();
    particles.material.dispose();
    membrane.material.dispose();
  }

  return { render, dispose };
}
