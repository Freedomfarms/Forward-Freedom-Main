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
  createCorePointMaterial,
  createCoreSprite,
  createSharedUniforms,
  createShellMesh,
} from "./ChiefCoreMaterial.js";
import { createCoreParticleGeometry, particleBudgetFor } from "./ChiefCoreParticles.js";
import {
  PREVIEW_SCRIPT,
  normalizeCoreState,
  poseFor,
  resolvePresentedState,
  stepPose,
} from "./ChiefCoreState.js";

const CLEAR = 0x04080f;
const CORE_SCALE = 1;

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
      antialias: true,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.setClearColor(CLEAR, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setPixelRatio(1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 40);
    this.rig = new THREE.Group();
    this.rotor = new THREE.Group();
    this.rotor.scale.setScalar(CORE_SCALE);
    this.rotor.rotation.x = 0.3;
    this.scene.add(this.rig);
    this.rig.add(this.rotor);

    this.shell = createShellMesh();
    this.shell.renderOrder = 4;
    this.rotor.add(this.shell);

    this.sprite = createCoreSprite();
    this.particles = new THREE.Points(
      createCoreParticleGeometry(this.budget),
      createCorePointMaterial(this.shared, this.sprite)
    );
    this.particles.frustumCulled = false;
    this.particles.renderOrder = 3;
    this.rotor.add(this.particles);

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
    this.shared.uHeight.value = height;
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
      { reduced: this.reduced },
      this.delta
    );
    this.qYaw.setFromAxisAngle(this.axisUp, deltas.yawDelta);
    this.axisRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.qPitch.setFromAxisAngle(this.axisRight, deltas.pitchDelta);
    this.rotor.quaternion.premultiply(this.qYaw).premultiply(this.qPitch);

    this.rig.scale.setScalar(this.motion.zoom);

    const pose = this.pose;
    this.shared.uTime.value = this.time;
    this.shared.uRadius.value = pose.radius;
    this.shared.uPace.value = pose.pace;
    this.shared.uBubble.value = pose.bubble;
    this.shared.uWave.value = pose.wave;
    this.shared.uSize.value = pose.point;
    this.shared.uHot.value = pose.hot;
    this.shared.uOpacity.value = pose.opacity;
    this.shared.uPointer.value.set(this.motion.pointerX, this.motion.pointerY);
    const hull = pose.radius + pose.bubble + pose.wave * this.shared.uWaveAmp.value;
    this.shell.scale.setScalar(hull + 0.04);
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
    this.sprite?.dispose();
    this.renderer?.dispose();
  }
}
