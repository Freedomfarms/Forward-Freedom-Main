// Maps the existing CHIEF turn and voice lifecycle onto the scene.
// Orbital speeds are multipliers of idle. Nothing here invents activity.

export const ORBITS = Object.freeze([
  Object.freeze({
    id: "inner",
    rx: 1.14,
    ry: 1.14,
    tilt: 0.18,
    speed: 0.55,
    dir: 1,
    phase: 0.4,
    width: 1.15,
    alpha: 0.55,
    ticks: true,
    nodes: Object.freeze([0.2, 2.7]),
  }),
  Object.freeze({
    id: "equator",
    rx: 1.72,
    ry: 0.46,
    tilt: -0.16,
    speed: 0.34,
    dir: -1,
    phase: 1.15,
    width: 1.8,
    alpha: 0.72,
    ticks: false,
    nodes: Object.freeze([0.05, 3.3]),
  }),
  Object.freeze({
    id: "incline",
    rx: 1.38,
    ry: 1.02,
    tilt: 1.02,
    speed: 0.46,
    dir: 1,
    phase: 2.05,
    width: 1.25,
    alpha: 0.48,
    ticks: false,
    nodes: Object.freeze([1.15]),
  }),
  Object.freeze({
    id: "dial",
    rx: 1.58,
    ry: 1.52,
    tilt: 0.06,
    speed: 0.22,
    dir: -1,
    phase: 0.25,
    width: 0.85,
    alpha: 0.38,
    ticks: true,
    nodes: Object.freeze([0.55]),
  }),
  Object.freeze({
    id: "wide",
    rx: 2.05,
    ry: 0.72,
    tilt: 0.36,
    speed: 0.18,
    dir: -1,
    phase: 0.75,
    width: 1.05,
    alpha: 0.42,
    ticks: true,
    nodes: Object.freeze([0.9, 4.1]),
  }),
  Object.freeze({
    id: "outer",
    rx: 2.22,
    ry: 1.08,
    tilt: -0.58,
    speed: 0.12,
    dir: 1,
    phase: 2.65,
    width: 0.9,
    alpha: 0.34,
    ticks: true,
    nodes: Object.freeze([1.75]),
  }),
]);

export const SCENE_SPEED = Object.freeze({
  idle: 1,
  listening: 1.15,
  thinking: 2.5,
  responding: 1.45,
  error: 0.55,
});

const VIOLET = Object.freeze({
  idle: 0.22,
  listening: 0.26,
  thinking: 0.38,
  responding: 0.82,
  error: 0.1,
});

export function ringAngle(time, ring) {
  return ring.phase + time * ring.speed * ring.dir;
}

export function ellipsePoint(cx, cy, rx, ry, tilt, angle) {
  const x = Math.cos(angle) * rx;
  const y = Math.sin(angle) * ry;
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  return [cx + x * c - y * s, cy + x * s + y * c];
}

export function orbitPoint(ring, time, cx, cy, radius) {
  return ellipsePoint(cx, cy, ring.rx * radius, ring.ry * radius, ring.tilt, ringAngle(time, ring));
}

export function waveHead(ring, time, index) {
  return ringAngle(time, ring) + index * 2.15;
}

export function systemActivity({
  scenePhase = "idle",
  assistantState = "idle",
  status = "",
  statusTone = "ready",
} = {}) {
  const text = typeof status === "string" ? status : "";
  const thinking = scenePhase === "thinking" || assistantState === "thinking";
  const searching = thinking && /search/i.test(text);
  const connecting = thinking && /access|tool|connect/i.test(text);
  const processing = thinking && !searching && !connecting && /financial|process/i.test(text);
  const reasoning = thinking && !searching && !connecting && !processing;
  return {
    listening: assistantState === "listening",
    processing,
    reasoning,
    searching,
    connecting,
    responding: scenePhase === "responding" || assistantState === "speaking",
    error: statusTone === "error" || text === "Error",
  };
}

export function scenePace(activity, scenePhase) {
  if (activity.listening) return "listening";
  if (activity.responding) return "responding";
  const thinking =
    scenePhase === "thinking" ||
    activity.reasoning ||
    activity.processing ||
    activity.searching ||
    activity.connecting;
  if (thinking) return "thinking";
  if (activity.error) return "error";
  return "idle";
}

export function motionForPace(pace) {
  const key = Object.prototype.hasOwnProperty.call(SCENE_SPEED, pace) ? pace : "idle";
  return {
    pace: key,
    speed: SCENE_SPEED[key],
    violet: VIOLET[key],
  };
}

export function sceneMotion(input = {}) {
  const activity = systemActivity(input);
  const pace = scenePace(activity, input.scenePhase || "idle");
  return { ...motionForPace(pace), activity };
}

export function sceneLayout(width, height) {
  const radius = Math.max(78, Math.min(width * 0.145, height * 0.22));
  const cx = width * 0.5;
  const cy = height * 0.385;
  const platformY = Math.min(height * 0.8, cy + radius * 2.45);
  return { cx, cy, radius, platformY };
}
