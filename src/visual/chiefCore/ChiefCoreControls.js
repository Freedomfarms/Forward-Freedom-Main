// Pointer motion for the core. Drag updates velocity; the render loop
// integrates it, so React never sees per-frame input.

import { damp } from "./ChiefCoreState.js";

export const ZOOM_MIN = 0.86;
export const ZOOM_MAX = 1.22;
export const PITCH_LIMIT = 1.05;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createMotion() {
  return {
    yawVel: 0.08,
    pitchVel: 0,
    pitch: 0,
    zoom: 1,
    zoomTarget: 1,
    pinchOrigin: 1,
    dragging: false,
    dragFresh: false,
    pointerX: 0,
    pointerY: 0,
    pointerTargetX: 0,
    pointerTargetY: 0,
  };
}

export function notePointer(motion, x, y) {
  motion.pointerTargetX = clamp(x, -1, 1);
  motion.pointerTargetY = clamp(y, -1, 1);
}

export function noteDrag(motion, dx, dy, dt) {
  const safe = Math.max(dt, 0.008);
  const sens = 0.0052;
  const yaw = clamp((dx * sens) / safe, -2.8, 2.8);
  const pitch = clamp((-dy * sens) / safe, -2.8, 2.8);
  motion.yawVel = motion.yawVel * 0.42 + yaw * 0.58;
  motion.pitchVel = motion.pitchVel * 0.42 + pitch * 0.58;
  motion.dragging = true;
  motion.dragFresh = true;
}

export function endDrag(motion) {
  motion.dragging = false;
  motion.dragFresh = false;
}

export function beginPinch(motion) {
  motion.pinchOrigin = motion.zoomTarget;
}

export function applyPinch(motion, ratio) {
  const scale = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  motion.zoomTarget = clamp(motion.pinchOrigin * scale, ZOOM_MIN, ZOOM_MAX);
}

export function applyWheel(motion, deltaY) {
  const factor = deltaY > 0 ? 0.94 : 1.065;
  motion.zoomTarget = clamp(motion.zoomTarget * factor, ZOOM_MIN, ZOOM_MAX);
}

export function stepMotion(
  motion,
  dt,
  { dragging = false, reduced = false, idleYaw = 0.08 } = {},
  out
) {
  const target = out || { yawDelta: 0, pitchDelta: 0 };
  const yawDelta = motion.yawVel * dt;
  const nextPitch = motion.pitch + motion.pitchVel * dt;
  const clampedPitch = clamp(nextPitch, -PITCH_LIMIT, PITCH_LIMIT);
  const pitchDelta = clampedPitch - motion.pitch;
  motion.pitch = clampedPitch;
  if (Math.abs(motion.pitch) >= PITCH_LIMIT - 1e-4) motion.pitchVel = 0;

  const held = dragging || motion.dragging;
  if (held) {
    if (!motion.dragFresh) {
      motion.yawVel = damp(motion.yawVel, 0, 14, dt);
      motion.pitchVel = damp(motion.pitchVel, 0, 14, dt);
    }
    motion.dragFresh = false;
  } else {
    motion.yawVel = damp(motion.yawVel, reduced ? 0 : idleYaw, 1.05, dt);
    motion.pitchVel = damp(motion.pitchVel, 0, 2.6, dt);
  }

  motion.zoomTarget = clamp(motion.zoomTarget, ZOOM_MIN, ZOOM_MAX);
  motion.zoom = damp(motion.zoom, motion.zoomTarget, 7, dt);
  motion.pointerX = damp(motion.pointerX, motion.pointerTargetX, 5, dt);
  motion.pointerY = damp(motion.pointerY, motion.pointerTargetY, 5, dt);
  target.yawDelta = yawDelta;
  target.pitchDelta = pitchDelta;
  return target;
}

export function frameForViewport(width, height, layout) {
  const aspect = width / Math.max(height, 1);
  const portrait = aspect < 0.9;
  const wide = aspect > 1.15;
  const auth = layout === "auth";
  if (auth && wide) {
    return { fov: 32, position: [0.2, 0.02, 10.4], lookAt: [1.55, 0.05, 0] };
  }
  if (portrait) {
    return {
      fov: auth ? 34 : 36,
      position: [0, 0.04, auth ? 11.2 : 10.6],
      lookAt: [0, auth ? -1.85 : -1.22, 0],
    };
  }
  return { fov: 32, position: [0, 0, 9.8], lookAt: [0, 0.02, 0] };
}

export function isCompactStage(width, coarsePointer) {
  return width < 900 || Boolean(coarsePointer);
}

function pairDistance(points) {
  const list = [...points.values()];
  if (list.length < 2) return 0;
  return Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y);
}

function pointerNdc(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(rect.width, 1);
  const height = Math.max(rect.height, 1);
  return {
    x: ((event.clientX - rect.left) / width) * 2 - 1,
    y: -((event.clientY - rect.top) / height) * 2 + 1,
  };
}

export function attachCorePointer(canvas, motion) {
  const points = new Map();
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  let pinchStart = 0;

  const onDown = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.setPointerCapture?.(event.pointerId);
    const ndc = pointerNdc(canvas, event);
    notePointer(motion, ndc.x, ndc.y);
    if (points.size === 1) {
      lastX = event.clientX;
      lastY = event.clientY;
      lastT = performance.now();
      motion.dragging = true;
      canvas.classList.add("is-dragging");
    } else if (points.size === 2) {
      motion.dragging = false;
      beginPinch(motion);
      pinchStart = pairDistance(points);
    }
  };

  const onMove = (event) => {
    const ndc = pointerNdc(canvas, event);
    notePointer(motion, ndc.x, ndc.y);
    if (!points.has(event.pointerId)) return;
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.size >= 2) {
      const dist = pairDistance(points);
      if (pinchStart > 0) applyPinch(motion, dist / pinchStart);
      return;
    }
    const now = performance.now();
    noteDrag(motion, event.clientX - lastX, event.clientY - lastY, (now - lastT) / 1000);
    lastX = event.clientX;
    lastY = event.clientY;
    lastT = now;
  };

  const onUp = (event) => {
    points.delete(event.pointerId);
    if (points.size < 2) pinchStart = 0;
    if (points.size === 0) {
      endDrag(motion);
      canvas.classList.remove("is-dragging");
      return;
    }
    if (points.size === 1) {
      const remaining = points.values().next().value;
      lastX = remaining.x;
      lastY = remaining.y;
      lastT = performance.now();
      motion.dragging = true;
    }
  };

  const onWheel = (event) => {
    event.preventDefault();
    applyWheel(motion, event.deltaY);
  };

  const onTouchMove = (event) => {
    if (points.size > 0) event.preventDefault();
  };

  const onContext = (event) => event.preventDefault();

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("contextmenu", onContext);

  return () => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("touchmove", onTouchMove);
    canvas.removeEventListener("contextmenu", onContext);
    canvas.classList.remove("is-dragging");
  };
}
