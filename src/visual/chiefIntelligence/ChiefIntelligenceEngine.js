// One transparent canvas and one animation loop for the homepage core.
// Pose easing comes from the shared core table. The login scene is not mounted.

import * as THREE from "three";
import { normalizeCoreState, poseFor, stepPose } from "../chiefCore/ChiefCoreState.js";
import {
  FILAMENT_ANCHOR_Y,
  FILAMENT_COLORS,
  createFilamentCore,
} from "./filamentCore.js";

const IDLE_RADIUS = 0.58;
const BASE_RADIUS = 0.96;

export class ChiefIntelligenceEngine {
  constructor(canvas, root, options = {}) {
    this.disposed = false;
    this.dead = false;
    this.running = false;
    this.raf = 0;
    try {
      this.assemble(canvas, root, options);
    } catch (error) {
      this.dead = true;
      this.dispose();
      console.warn("[chief-intelligence]", error?.message || error);
      queueMicrotask(() => options.onFatal?.(error));
    }
  }

  static mount(canvas, root, options) {
    try {
      const engine = new ChiefIntelligenceEngine(canvas, root, options);
      return engine.dead ? null : engine;
    } catch (error) {
      queueMicrotask(() => options?.onFatal?.(error));
      return null;
    }
  }

  assemble(canvas, root, { state = "idle", onFatal } = {}) {
    this.canvas = canvas;
    this.root = root;
    this.onFatal = onFatal;
    this.last = 0;
    this.time = 0;
    this.presented = normalizeCoreState(state);
    this.pose = poseFor(this.presented);
    this.poseTarget = poseFor(this.presented);
    this.pointer = new THREE.Vector2();
    this.pointerTarget = new THREE.Vector2();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
      stencil: false,
      depth: false,
      premultipliedAlpha: false,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    this.camera.position.set(0, 0, 5.2);
    this.rig = new THREE.Group();
    this.scene.add(this.rig);

    this.uniforms = {
      uTime: { value: 0 },
      uPace: { value: this.pose.pace },
      uHot: { value: this.pose.hot },
      uThickness: { value: 1.22 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uBlue: { value: new THREE.Color(FILAMENT_COLORS.blue) },
      uCyan: { value: new THREE.Color(FILAMENT_COLORS.cyan) },
      uMagenta: { value: new THREE.Color(FILAMENT_COLORS.magenta) },
      uViolet: { value: new THREE.Color(FILAMENT_COLORS.violet) },
    };
    this.core = createFilamentCore(this.uniforms);
    this.rig.add(this.core);

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

    this.onPointer = (event) => {
      const width = window.innerWidth || 1;
      const height = window.innerHeight || 1;
      this.pointerTarget.set((event.clientX / width) * 2 - 1, (event.clientY / height) * 2 - 1);
    };
    window.addEventListener("pointermove", this.onPointer, { passive: true });

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(root);
    this.resize();
    this.frame = (now) => this.renderFrame(now);
  }

  setState(state) {
    this.presented = normalizeCoreState(state);
    this.poseTarget = poseFor(this.presented);
  }

  resize() {
    if (this.disposed) return;
    const width = this.root.clientWidth || window.innerWidth || 1;
    const height = this.root.clientHeight || window.innerHeight || 1;
    if (width < 2 || height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.uniforms.uResolution.value.set(width * dpr, height * dpr);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const distance = this.camera.position.z;
    const visibleHeight = 2 * Math.tan((this.camera.fov * Math.PI) / 360) * distance;
    const ndcY = 1 - 2 * FILAMENT_ANCHOR_Y;
    this.rig.position.y = (ndcY * visibleHeight) / 2;
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
    stepPose(this.pose, this.poseTarget, dt);
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.uniforms.uPace.value = this.pose.pace;
    this.uniforms.uHot.value = this.pose.hot;
    const breath = 1 + Math.sin(this.time * 0.55) * this.pose.breath;
    this.core.scale.setScalar((this.pose.radius / IDLE_RADIUS) * BASE_RADIUS * breath);
    const spin = 0.05 + this.pose.spin;
    this.core.rotation.y += dt * spin;
    this.core.rotation.z += dt * spin * 0.22;
    this.pointer.lerp(this.pointerTarget, 1 - Math.exp(-2.2 * dt));
    this.rig.rotation.y = this.pointer.x * 0.06;
    this.rig.rotation.x = this.pointer.y * -0.04;
  }

  fail(error) {
    this.disposed = true;
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    console.warn("[chief-intelligence]", error?.message || error);
    this.onFatal?.(error);
  }

  dispose() {
    this.disposed = true;
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas?.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas?.removeEventListener("webglcontextrestored", this.onContextRestored);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pointermove", this.onPointer);
    this.observer?.disconnect();
    this.core?.userData.disposeCore?.();
    this.renderer?.dispose();
    this.scene = null;
    this.core = null;
  }
}
