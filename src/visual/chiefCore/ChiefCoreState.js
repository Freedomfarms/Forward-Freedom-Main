// Pose and state for the homepage intelligence core.
// Retune motion here. The renderer only reads the eased pose.

export const CORE_STATES = Object.freeze(["idle", "listening", "thinking", "responding"]);

// Radii, sizes, and pace follow the original overview particle ball.
// Idle is the tight standby cluster. Thinking tightens and speeds up.
// Responding keeps the outward wave. Expand/inward stay for pose tests.
export const POSE = Object.freeze({
  idle: Object.freeze({
    expand: 1,
    inward: 0,
    outward: 0,
    hot: 0.2,
    energy: 0.28,
    wave: 0,
    order: 0.18,
    spin: 0.07,
    breath: 0.02,
    radius: 0.58,
    pace: 1,
    point: 0.066,
    opacity: 0.95,
    bubble: 0.17,
  }),
  listening: Object.freeze({
    expand: 1.075,
    inward: 0.06,
    outward: 0.04,
    hot: 0.42,
    energy: 0.74,
    wave: 0.027,
    order: 0.84,
    spin: 0.1,
    breath: 0.016,
    radius: 0.78,
    pace: 0.8,
    point: 0.05,
    opacity: 0.9,
    bubble: 0.162,
  }),
  thinking: Object.freeze({
    expand: 0.91,
    inward: 0.9,
    outward: 0,
    hot: 1,
    energy: 0.86,
    wave: 0.28,
    order: 0.72,
    spin: 0.28,
    breath: 0.008,
    radius: 0.48,
    pace: 2.6,
    point: 0.082,
    opacity: 1,
    bubble: 0.138,
  }),
  responding: Object.freeze({
    expand: 1.11,
    inward: 0.02,
    outward: 0.94,
    hot: 0.48,
    energy: 0.9,
    wave: 1,
    order: 0.3,
    spin: 0.18,
    breath: 0.018,
    radius: 1.2,
    pace: 1.7,
    point: 0.056,
    opacity: 0.96,
    bubble: 0.196,
  }),
});

// One pass on the homepage so the four states are visible, then rest on idle.
export const PREVIEW_SCRIPT = Object.freeze([
  Object.freeze({ at: 4200, state: "listening" }),
  Object.freeze({ at: 8600, state: "thinking" }),
  Object.freeze({ at: 12800, state: "responding" }),
  Object.freeze({ at: 16800, state: "idle" }),
]);

const NAMED_STATES = new Set([
  "idle",
  "listening",
  "thinking",
  "processing",
  "responding",
  "speaking",
]);

export function damp(current, target, lambda, dt) {
  const step = Math.min(Math.max(dt, 0), 0.05);
  return target + (current - target) * Math.exp(-lambda * step);
}

export function normalizeCoreState(value) {
  const state = String(value || "").toLowerCase();
  if (state.includes("listen")) return "listening";
  if (state.includes("think") || state.includes("process")) return "thinking";
  if (state.includes("respond") || state.includes("speak")) return "responding";
  return "idle";
}

export function stateFromSearch(search) {
  const params = new URLSearchParams(typeof search === "string" ? search : "");
  const raw = params.get("core");
  if (!raw || !NAMED_STATES.has(raw.toLowerCase())) return null;
  return normalizeCoreState(raw);
}

export function poseFor(state) {
  return { ...POSE[normalizeCoreState(state)] };
}

export function stepPose(current, target, dt, lambda = 2.6) {
  for (const key of Object.keys(target)) {
    current[key] = damp(current[key], target[key], lambda, dt);
  }
  return current;
}

export function resolvePresentedState(external, simulated, previewActive) {
  const base = normalizeCoreState(external);
  if (!previewActive || base !== "idle" || !simulated) return base;
  return normalizeCoreState(simulated);
}

export function supportsWebGL(doc = globalThis.document) {
  if (!doc?.createElement) return false;
  try {
    const canvas = doc.createElement("canvas");
    const gl = canvas.getContext?.("webgl2") || canvas.getContext?.("webgl");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}
