// Quality policy for the homepage filament sphere.
// Hardware desktops stay on the approved path. A software renderer, or a
// display that keeps missing frames, steps the buffer down and does not
// step back up, so the image cannot flicker between settings.

export const PREMIUM_DPR_CAP = 1.5;
export const SOFTWARE_DPR_CAP = 1;
export const DPR_FLOOR = 0.5;
const DPR_CAPS = Object.freeze([1.5, 1.25, 1, 0.75, DPR_FLOOR]);

export const FRAME_WARMUP = 8;
export const SLOW_FRAME_MS = 40;
export const SLOW_FRAME_LIMIT = 12;
export const ADAPT_COOLDOWN = 20;
// A gap this long is a suspended tab or a stalled clock, not a render sample.
export const SUSPENDED_FRAME_MS = 1000;

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|microsoft basic render/i;

export function isSoftwareRenderer(name) {
  return SOFTWARE_RENDERER.test(String(name || ""));
}

export function createQualityState(rendererName) {
  const software = isSoftwareRenderer(rendererName);
  return {
    antialias: !software,
    dprCap: software ? SOFTWARE_DPR_CAP : PREMIUM_DPR_CAP,
    software,
    warmup: FRAME_WARMUP,
    slowFrames: 0,
    cooldown: 0,
    adaptations: 0,
  };
}

// CSS pixels in, drawing-buffer pixels out. The ratio is applied once to the
// CSS size. Calling this again with the same CSS size cannot compound.
export function drawingBufferSize(cssWidth, cssHeight, devicePixelRatio, dprCap) {
  const width = Math.max(0, Math.round(Number(cssWidth) || 0));
  const height = Math.max(0, Math.round(Number(cssHeight) || 0));
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const cap = Number.isFinite(dprCap) && dprCap > 0 ? dprCap : ratio;
  const dpr = Math.min(ratio, cap);
  return {
    cssWidth: width,
    cssHeight: height,
    dpr,
    bufferWidth: Math.floor(width * dpr),
    bufferHeight: Math.floor(height * dpr),
  };
}

export function nextEffectiveCap(cap, devicePixelRatio) {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const applied = Math.min(ratio, cap);
  for (const candidate of DPR_CAPS) {
    if (candidate >= cap - 1e-6) continue;
    if (Math.min(ratio, candidate) < applied - 1e-6) return candidate;
  }
  return cap;
}

// `gpuMs` is null while a timer query is still pending. Without a timer,
// the frame gap itself is the measurement and can reset the slow streak.
// Returns null for the first frame, the frame after a resume, and gaps long
// enough to be a suspended tab rather than a render.
export function measureFrame(rawMs, gpuMs, hasTimer) {
  if (!(rawMs > 0) || rawMs >= SUSPENDED_FRAME_MS) return null;
  const usable = Number.isFinite(gpuMs) && gpuMs >= 0 && gpuMs < SUSPENDED_FRAME_MS;
  const pending = Boolean(hasTimer) && !usable;
  if (hasTimer && Number.isFinite(gpuMs) && gpuMs >= SUSPENDED_FRAME_MS) return null;
  if (pending || !hasTimer) return { sample: rawMs, confirmed: !pending };
  return { sample: Math.max(rawMs, gpuMs), confirmed: true };
}

// Mutates state. Returns true when the drawing-buffer cap changed.
// `confirmed` is false for a vsync gap that has no GPU sample yet, so a
// late timer result is not wiped out by the in-between frames.
export function observeFrame(state, frameMs, devicePixelRatio, confirmed = true) {
  if (state.warmup > 0) {
    state.warmup -= 1;
    return false;
  }
  if (state.cooldown > 0) {
    state.cooldown -= 1;
    return false;
  }
  if (!(frameMs > SLOW_FRAME_MS)) {
    if (confirmed) state.slowFrames = 0;
    return false;
  }
  state.slowFrames += 1;
  if (state.slowFrames < SLOW_FRAME_LIMIT) return false;
  state.slowFrames = 0;
  const next = nextEffectiveCap(state.dprCap, devicePixelRatio);
  if (next === state.dprCap) return false;
  state.dprCap = next;
  state.cooldown = ADAPT_COOLDOWN;
  state.adaptations += 1;
  return true;
}

export function probeWebGLRenderer(doc = globalThis.document) {
  if (!doc?.createElement) return "";
  let gl = null;
  try {
    const canvas = doc.createElement("canvas");
    gl =
      canvas.getContext?.("webgl2", {
        antialias: false,
        depth: false,
        stencil: false,
        failIfMajorPerformanceCaveat: false,
      }) ||
      canvas.getContext?.("webgl", {
        antialias: false,
        depth: false,
        stencil: false,
        failIfMajorPerformanceCaveat: false,
      });
    if (!gl) return "";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || "") : "";
  } catch {
    return "";
  } finally {
    gl?.getExtension?.("WEBGL_lose_context")?.loseContext?.();
  }
}
