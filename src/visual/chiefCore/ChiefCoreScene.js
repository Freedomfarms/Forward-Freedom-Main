// One WebGL renderer and one animation loop. React only calls setState,
// setLayout, and setPreview. Particles, lighting, and inertia stay here.

import * as THREE from "three";
import {
  attachCorePointer,
  createMotion,
  frameForViewport,
  isCompactStage,
  stepMotion,
} from "./ChiefCoreControls.js";
import {
  createGlowTexture,
  createNebulaMaterial,
  createParticleMaterial,
  createSharedUniforms,
  createShellMaterial,
  createVolumeMaterial,
  createWaveMaterial,
} from "./ChiefCoreMaterial.js";
import {
  createCoreParticleGeometry,
  createParticleGeometry,
  particleBudgetFor,
} from "./ChiefCoreParticles.js";
import {
  PREVIEW_SCRIPT,
  normalizeCoreState,
  poseFor,
  resolvePresentedState,
  stepPose,
} from "./ChiefCoreState.js";

const CLEAR = 0x07040f;

export class ChiefCoreEngine {
  constructor(canvas, root, options = {}) {
    this.disposed = false;
    this.dead = false;
    this.running = false;
    this.raf = 0;
    this.previewTimers = [];
    try {
      this.assemble(canvas, root, options);
    } catch (error) {
      this.dead = true;
      this.dispose();
      console.warn("[chief-core]", error?.message || error);
      queueMicrotask(() => options.onFatal?.(error));
    }
  }

  assemble(canvas, root, { state = "idle", layout = "home", preview = false, onFatal } = {}) {
    this.canvas = canvas;
    this.root = root;
    this.onFatal = onFatal;
    this.last = 0;
    this.time = 0;
    this.failed = false;
    this.layout = layout === "auth" ? "auth" : "home";
    this.externalState = state;
    this.simulated = null;
    this.previewEnabled = Boolean(preview);
    this.presented = normalizeCoreState(state);
    this.pose = poseFor(this.presented);
    this.poseTarget = poseFor(this.presented);
    this.motion = createMotion();
    this.delta = { yawDelta: 0, pitchDelta: 0 };
    this.camLocal = new THREE.Vector3();
    this.qYaw = new THREE.Quaternion();
    this.qPitch = new THREE.Quaternion();
    this.axisUp = new THREE.Vector3(0, 1, 0);
    this.axisRight = new THREE.Vector3(1, 0, 0);
    this.shared = createSharedUniforms();
    this.width = 1;
    this.height = 1;

    this.coarse = Boolean(window.matchMedia?.("(pointer: coarse)")?.matches);
    this.compact = isCompactStage(window.innerWidth || 1280, this.coarse);
    this.budget = particleBudgetFor(window.innerWidth || 1280, this.coarse);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: false,
      antialias: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.setClearColor(CLEAR, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 80);
    this.rig = new THREE.Group();
    this.rotor = new THREE.Group();
    this.scene.add(this.rig);
    this.rig.add(this.rotor);

    this.nebula = new THREE.Mesh(
      new THREE.SphereGeometry(42, 32, 20),
      createNebulaMaterial(this.shared)
    );
    this.nebula.frustumCulled = false;
    this.nebula.renderOrder = 0;
    this.scene.add(this.nebula);

    this.dust = new THREE.Points(
      createParticleGeometry(this.budget.dust, 3),
      createParticleMaterial(this.shared, 0.15)
    );
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 1;
    this.scene.add(this.dust);

    this.glow = new THREE.Mesh(
      new THREE.SphereGeometry(1.34, 40, 28),
      createShellMaterial(this.shared, {
        power: 3.4,
        gain: 0.1,
        colorA: "0.22, 0.08, 0.42",
        colorB: "0.62, 0.40, 0.95",
      })
    );
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 2;
    this.rotor.add(this.glow);

    this.volume = new THREE.Mesh(
      new THREE.SphereGeometry(1, 64, 48),
      createVolumeMaterial(this.shared)
    );
    this.volume.frustumCulled = false;
    this.volume.renderOrder = 3;
    this.rotor.add(this.volume);

    this.shell = new THREE.Mesh(
      new THREE.SphereGeometry(1.16, 64, 48),
      createShellMaterial(this.shared, {
        power: 4.4,
        gain: 0.22,
        colorA: "0.26, 0.09, 0.48",
        colorB: "0.88, 0.84, 1.0",
      })
    );
    this.shell.frustumCulled = false;
    this.shell.renderOrder = 4;
    this.rotor.add(this.shell);

    this.particles = new THREE.Points(
      createCoreParticleGeometry(this.budget),
      createParticleMaterial(this.shared, 1)
    );
    this.particles.frustumCulled = false;
    this.particles.renderOrder = 5;
    this.rotor.add(this.particles);

    this.waveA = new THREE.Mesh(new THREE.PlaneGeometry(3.15, 3.15), createWaveMaterial());
    this.waveB = new THREE.Mesh(new THREE.PlaneGeometry(3.15, 3.15), createWaveMaterial());
    this.waveA.frustumCulled = false;
    this.waveB.frustumCulled = false;
    this.waveA.renderOrder = 6;
    this.waveB.renderOrder = 6;
    this.rig.add(this.waveA, this.waveB);

    this.coreMat = new THREE.MeshBasicMaterial({
      color: 0xfff7ff,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    this.coreMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), this.coreMat);
    this.coreMesh.scale.setScalar(0.09);
    this.coreMesh.frustumCulled = false;
    this.coreMesh.renderOrder = 7;
    this.rotor.add(this.coreMesh);

    this.glowTexture = createGlowTexture();
    this.spriteMat = new THREE.SpriteMaterial({
      map: this.glowTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      opacity: 0.95,
    });
    this.sprite = new THREE.Sprite(this.spriteMat);
    this.sprite.scale.set(0.46, 0.46, 1);
    this.sprite.renderOrder = 8;
    this.rotor.add(this.sprite);

    this.detachPointer = attachCorePointer(canvas, this.motion);
    this.onContextLost = (event) => {
      event.preventDefault();
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    };
    this.onContextRestored = () => {
      if (!this.disposed) this.start();
    };
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);

    this.onVisibility = () => {
      if (document.hidden) {
        this.running = false;
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.last = 0;
        return;
      }
      this.start();
    };
    document.addEventListener("visibilitychange", this.onVisibility);

    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reduced = this.motionQuery.matches;
    this.onMotion = () => {
      this.reduced = this.motionQuery.matches;
      if (this.reduced) this.stopPreview();
      this.applyPresentedState();
    };
    this.motionQuery.addEventListener("change", this.onMotion);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(root);
    this.resize();
    this.applyPresentedState();
    if (this.previewEnabled) this.startPreview();

    this.frame = (now) => this.renderFrame(now);
  }

  static mount(canvas, root, options) {
    try {
      const engine = new ChiefCoreEngine(canvas, root, options);
      if (engine.dead) return null;
      return engine;
    } catch (error) {
      queueMicrotask(() => options?.onFatal?.(error));
      return null;
    }
  }

  setState(state) {
    this.externalState = state;
    if (normalizeCoreState(state) !== "idle") this.stopPreview();
    else if (this.previewEnabled && !this.reduced && this.previewTimers.length === 0)
      this.startPreview();
    this.applyPresentedState();
  }

  setLayout(layout) {
    this.layout = layout === "auth" ? "auth" : "home";
    this.resize();
  }

  setPreview(enabled) {
    this.previewEnabled = Boolean(enabled);
    this.stopPreview();
    if (this.previewEnabled) this.startPreview();
    this.applyPresentedState();
  }

  startPreview() {
    this.stopPreview();
    if (!this.previewEnabled || this.reduced) return;
    if (normalizeCoreState(this.externalState) !== "idle") return;
    this.simulated = null;
    this.previewTimers = PREVIEW_SCRIPT.map((step) =>
      setTimeout(() => {
        if (this.disposed) return;
        this.simulated = step.state;
        this.applyPresentedState();
      }, step.at)
    );
  }

  stopPreview() {
    for (const id of this.previewTimers || []) clearTimeout(id);
    this.previewTimers = [];
    this.simulated = null;
  }

  applyPresentedState() {
    this.presented = resolvePresentedState(
      this.externalState,
      this.simulated,
      this.previewEnabled && !this.reduced
    );
    this.poseTarget = poseFor(this.presented);
  }

  resize() {
    if (this.disposed) return;
    const width = this.root.clientWidth || window.innerWidth || 1;
    const height = this.root.clientHeight || window.innerHeight || 1;
    if (width < 2 || height < 2) return;
    this.width = width;
    this.height = height;
    this.compact = isCompactStage(width, this.coarse);
    const dprCap = this.compact ? 1.15 : 1.35;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.shared.uDpr.value = dpr;
    this.shared.uPointScale.value = this.compact ? 0.72 : 1;
    const frame = frameForViewport(width, height, this.layout);
    this.camera.fov = frame.fov;
    this.camera.aspect = width / height;
    this.camera.position.set(frame.position[0], frame.position[1], frame.position[2]);
    this.camera.lookAt(frame.lookAt[0], frame.lookAt[1], frame.lookAt[2]);
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this.disposed || this.running) return;
    this.running = true;
    this.last = 0;
    this.queueFrame();
  }

  queueFrame() {
    if (!this.running || this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  renderFrame(now) {
    if (!this.running || this.disposed) return;
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 0.016;
    this.last = now;
    try {
      this.advance(dt);
      this.renderer.render(this.scene, this.camera);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.queueFrame();
  }

  advance(dt) {
    const timeScale = this.reduced ? 0.08 : 1;
    this.time += dt * timeScale;
    stepPose(this.pose, this.poseTarget, dt);
    const deltas = stepMotion(
      this.motion,
      dt,
      { reduced: this.reduced, idleYaw: this.pose.spin },
      this.delta
    );
    this.qYaw.setFromAxisAngle(this.axisUp, deltas.yawDelta);
    this.axisRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.qPitch.setFromAxisAngle(this.axisRight, deltas.pitchDelta);
    this.rotor.quaternion.premultiply(this.qYaw).premultiply(this.qPitch);

    const breath = 1 + Math.sin(this.time * 0.85) * this.pose.breath * (this.reduced ? 0.2 : 1);
    this.rig.scale.setScalar(this.motion.zoom * this.pose.expand * breath);

    const pose = this.pose;
    this.shared.uTime.value = this.time;
    this.shared.uInward.value = pose.inward;
    this.shared.uOutward.value = pose.outward;
    this.shared.uHot.value = pose.hot;
    this.shared.uEnergy.value = pose.energy;
    this.shared.uOrder.value = pose.order;
    this.shared.uOpacity.value = 0.28 + pose.energy * 0.32;
    this.shared.uPointer.value.set(this.motion.pointerX, this.motion.pointerY);

    this.camLocal.copy(this.camera.position);
    this.volume.worldToLocal(this.camLocal);
    this.shared.uCamLocal.value.copy(this.camLocal);

    const pulse =
      0.2 + pose.hot * 0.14 + Math.sin(this.time * (1.05 + pose.hot)) * (0.018 + pose.hot * 0.012);
    this.sprite.scale.set(pulse, pulse, 1);
    this.coreMat.opacity = 0.22 + pose.hot * 0.55;
    this.coreMesh.scale.setScalar(0.055 + pose.hot * 0.04);

    const cycle = (this.time * 0.11) % 1;
    this.waveA.material.uniforms.uRadius.value = 0.26 + cycle * 0.92;
    this.waveA.material.uniforms.uStrength.value = pose.wave * 0.12;
    const cycleB = (this.time * 0.11 + 0.48) % 1;
    this.waveB.material.uniforms.uRadius.value = 0.26 + cycleB * 0.92;
    this.waveB.material.uniforms.uStrength.value = pose.wave * 0.09;
    this.waveA.quaternion.copy(this.camera.quaternion);
    this.waveB.quaternion.copy(this.camera.quaternion);
  }

  fail(error) {
    if (this.failed) return;
    this.failed = true;
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    console.warn("[chief-core]", error?.message || error);
    this.onFatal?.(error);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stopPreview();
    this.detachPointer?.();
    this.observer?.disconnect();
    this.motionQuery?.removeEventListener("change", this.onMotion);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.canvas?.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas?.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.scene?.traverse((object) => {
      object.geometry?.dispose?.();
      const material = object.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose?.());
      else material?.dispose?.();
    });
    this.glowTexture?.dispose();
    this.renderer?.dispose();
  }
}
