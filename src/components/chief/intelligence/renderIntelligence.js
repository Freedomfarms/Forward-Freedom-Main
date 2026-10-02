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
    uContract: { value: 0 },
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
  uniforms.uContract.value = Number(motion?.contract) || 0;
  uniforms.uPixelRatio.value = pixelRatio;
}

function particleUniforms(shared, pass) {
  return {
    uTime: shared.uTime,
    uSpeed: shared.uSpeed,
    uActivity: shared.uActivity,
    uOutflow: shared.uOutflow,
    uOrganize: shared.uOrganize,
    uContract: shared.uContract,
    uPixelRatio: shared.uPixelRatio,
    uPass: { value: pass },
  };
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
  const boundSphere = new SphereGeometry(1.16, 72, 56);

  const field = new Mesh(sphere, material(uniforms, fieldVertex, fieldFragment, AdditiveBlending));
  field.scale.setScalar(1.62);
  field.renderOrder = 1;
  field.frustumCulled = false;

  const heart = new Mesh(sphere, material(uniforms, heartVertex, heartFragment, AdditiveBlending));
  heart.scale.setScalar(0.28);
  heart.renderOrder = 4;
  heart.frustumCulled = false;

  const volume = new Mesh(
    boundSphere,
    material(uniforms, volumeVertex, volumeFragment, NormalBlending)
  );
  volume.renderOrder = 3;
  volume.frustumCulled = false;

  const layout = createCoreParticles(CORE_PARTICLE_COUNT);
  const pointsGeometry = new BufferGeometry();
  pointsGeometry.setAttribute("position", new BufferAttribute(layout.directions.slice(), 3));
  pointsGeometry.setAttribute("aDir", new BufferAttribute(layout.directions, 3));
  pointsGeometry.setAttribute("aRadius", new BufferAttribute(layout.radii, 1));
  pointsGeometry.setAttribute("aSeed", new BufferAttribute(layout.seeds, 4));
  const backParticles = new Points(
    pointsGeometry,
    material(particleUniforms(uniforms, 0), particleVertex, particleFragment, AdditiveBlending)
  );
  backParticles.renderOrder = 2;
  backParticles.frustumCulled = false;
  const particles = new Points(
    pointsGeometry,
    material(particleUniforms(uniforms, 1), particleVertex, particleFragment, AdditiveBlending)
  );
  particles.renderOrder = 5;
  particles.frustumCulled = false;

  const membrane = new Mesh(
    sphere,
    material(
      {
        uGlow: uniforms.uGlow,
        uTime: uniforms.uTime,
        uAlpha: { value: 0.16 },
      },
      shellVertex,
      shellFragment,
      AdditiveBlending
    )
  );
  membrane.scale.setScalar(1.01);
  membrane.renderOrder = 6;
  membrane.frustumCulled = false;

  root.add(field, backParticles, volume, heart, particles, membrane);
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

    const pulse = coreScale(time, motion, amplitude);
    const breathe = 1 + (pulse - 1) * 0.38;
    const slowVolume = 1 + Math.sin(time * 0.29) * 0.009;
    const body = Number(motion?.body) || 1;
    const spin = Number(motion?.spin) || 0;
    const voice = amplitude == null ? 0 : amplitude;
    root.scale.setScalar(breathe * body * slowVolume);
    root.rotation.y = time * 0.08 * spin;
    root.rotation.x = Math.sin(time * 0.11 + 0.6) * 0.04;
    root.rotation.z = Math.sin(time * 0.07 + 2.1) * 0.025 * spin;
    root.updateWorldMatrix(true, true);
    cameraLocal.copy(camera.position);
    volume.worldToLocal(cameraLocal);
    uniforms.uCameraLocal.value.copy(cameraLocal);
    applyMotion(uniforms, motion, time, ratio);
    uniforms.uGlow.value *= 1 + voice * 0.12;
    membrane.material.uniforms.uGlow.value = uniforms.uGlow.value;
    renderer.render(scene, camera);
  }

  function dispose() {
    renderer.dispose();
    sphere.dispose();
    boundSphere.dispose();
    pointsGeometry.dispose();
    field.material.dispose();
    heart.material.dispose();
    volume.material.dispose();
    backParticles.material.dispose();
    particles.material.dispose();
    membrane.material.dispose();
  }

  return { render, dispose };
}
