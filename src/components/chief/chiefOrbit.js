// Splits the CHIEF scene artwork into a still plate plus two ring layers.
// The photograph is one bitmap. Ring strokes are copied onto inner and outer
// canvases so they can rotate in opposite directions without turning the
// sphere, the horizon, or the dais. The plate keeps a smooth version of each
// ring, so the strokes read as moving along a stable circle.

export const CHIEF_ORBIT = Object.freeze({
  width: 864,
  height: 510,
  centerX: 462,
  centerY: 289,
  innerEnd: 150,
  outerSeconds: 58,
  innerSeconds: 32,
  nodes: Object.freeze({
    inner: Object.freeze([
      Object.freeze({ radius: 116, angle: 312 }),
      Object.freeze({ radius: 140, angle: 58 }),
    ]),
    outer: Object.freeze([
      Object.freeze({ radius: 176, angle: 24 }),
      Object.freeze({ radius: 208, angle: 156 }),
      Object.freeze({ radius: 228, angle: 236 }),
    ]),
  }),
});

const GEOMETRY = Object.freeze({
  centerX: CHIEF_ORBIT.centerX,
  centerY: CHIEF_ORBIT.centerY,
  innerEnd: CHIEF_ORBIT.innerEnd,
  radiusMin: 108,
  radiusMax: 246,
  band: 2.2,
  beamRadians: (4 * Math.PI) / 180,
  peakMin: 90,
  lumaPeak: 70,
  lumaKeep: 36,
  maxY: 500,
});

function luminance(red, green, blue) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function onBeam(angle, beamRadians) {
  return Math.abs(Math.abs(angle) - Math.PI / 2) < beamRadians;
}

function readPixel(pixels, width, height, x, y) {
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const index = (y * width + x) * 4;
  return [pixels[index], pixels[index + 1], pixels[index + 2]];
}

export function orbitNodePosition(node, geometry = CHIEF_ORBIT) {
  const angle = (node.angle * Math.PI) / 180;
  const x = geometry.centerX + node.radius * Math.cos(angle);
  const y = geometry.centerY + node.radius * Math.sin(angle);
  return {
    left: `${(x / geometry.width) * 100}%`,
    top: `${(y / geometry.height) * 100}%`,
  };
}

export function splitChiefOrbitLayers(pixels, width, height, geometry = GEOMETRY) {
  const count = width * height;
  if (!pixels || pixels.length < count * 4) return null;

  const { centerX, centerY, innerEnd, radiusMin, radiusMax, band, beamRadians } = geometry;
  const peakMin = geometry.peakMin;
  const lumaPeak = geometry.lumaPeak;
  const lumaKeep = geometry.lumaKeep;
  const maxY = geometry.maxY ?? height;

  const peaks = new Uint16Array(radiusMax + 8);
  for (let y = 4; y < height - 4; y += 1) {
    for (let x = 4; x < width - 4; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const radius = Math.hypot(dx, dy);
      const radiusIndex = Math.round(radius);
      if (radiusIndex < radiusMin || radiusIndex > radiusMax) continue;
      const angle = Math.atan2(dy, dx);
      if (onBeam(angle, beamRadians)) continue;
      const pixel = readPixel(pixels, width, height, x, y);
      if (!pixel) continue;
      const lite = luminance(pixel[0], pixel[1], pixel[2]);
      if (lite < lumaPeak) continue;
      if (pixel[2] + 0.2 * pixel[1] < pixel[0] + 12 && lite < 160) continue;
      const inwardX = Math.round(x - (dx / radius) * 4);
      const inwardY = Math.round(y - (dy / radius) * 4);
      const outwardX = Math.round(x + (dx / radius) * 5);
      const outwardY = Math.round(y + (dy / radius) * 5);
      const inward = readPixel(pixels, width, height, inwardX, inwardY);
      const outward = readPixel(pixels, width, height, outwardX, outwardY);
      if (!inward || !outward) continue;
      const inwardLite = luminance(inward[0], inward[1], inward[2]);
      const outwardLite = luminance(outward[0], outward[1], outward[2]);
      if (lite > inwardLite + 20 && lite > outwardLite + 18) peaks[radiusIndex] += 1;
    }
  }

  const ring = new Uint8Array(peaks.length);
  for (let radius = 0; radius < peaks.length; radius += 1) {
    if (peaks[radius] > peakMin) ring[radius] = 1;
  }

  const mask = new Uint8Array(count);
  const bins = 360;
  const sumR = new Float64Array(peaks.length * bins);
  const sumG = new Float64Array(peaks.length * bins);
  const sumB = new Float64Array(peaks.length * bins);
  const sumN = new Uint16Array(peaks.length * bins);

  for (let y = 0; y < height; y += 1) {
    if (y > maxY) continue;
    for (let x = 0; x < width; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const radius = Math.hypot(dx, dy);
      if (radius < radiusMin - 4 || radius > radiusMax + 4) continue;
      const rounded = Math.round(radius);
      let nearest = band + 1;
      for (let delta = -3; delta <= 3; delta += 1) {
        const candidate = rounded + delta;
        if (candidate < 0 || candidate >= ring.length || !ring[candidate]) continue;
        const distance = Math.abs(radius - candidate);
        if (distance < nearest) nearest = distance;
      }
      if (nearest > band) continue;
      const angle = Math.atan2(dy, dx);
      if (onBeam(angle, beamRadians)) continue;
      const index = (y * width + x) * 4;
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const lite = luminance(red, green, blue);
      if (lite < lumaKeep) continue;
      if (blue < red - 5 && lite < 120) continue;
      mask[y * width + x] = 1;
      const radiusIndex = Math.min(peaks.length - 1, Math.floor(radius));
      const bin = Math.floor((((angle + Math.PI) / (Math.PI * 2)) * bins) % bins);
      const slot = radiusIndex * bins + bin;
      sumR[slot] += red;
      sumG[slot] += green;
      sumB[slot] += blue;
      sumN[slot] += 1;
    }
  }

  const symR = new Float64Array(peaks.length);
  const symG = new Float64Array(peaks.length);
  const symB = new Float64Array(peaks.length);
  const symReady = new Uint8Array(peaks.length);
  for (let radius = 0; radius < peaks.length; radius += 1) {
    let red = 0;
    let green = 0;
    let blue = 0;
    let samples = 0;
    for (let bin = 0; bin < bins; bin += 1) {
      const slot = radius * bins + bin;
      if (!sumN[slot]) continue;
      red += sumR[slot] / sumN[slot];
      green += sumG[slot] / sumN[slot];
      blue += sumB[slot] / sumN[slot];
      samples += 1;
    }
    if (!samples) continue;
    symR[radius] = red / samples;
    symG[radius] = green / samples;
    symB[radius] = blue / samples;
    symReady[radius] = 1;
  }

  function symmetric(radius) {
    const index = Math.max(0, Math.min(peaks.length - 1, Math.floor(radius)));
    if (symReady[index]) return [symR[index], symG[index], symB[index]];
    if (index > 0 && symReady[index - 1])
      return [symR[index - 1], symG[index - 1], symB[index - 1]];
    return null;
  }

  const base = new Uint8ClampedArray(pixels);
  const inner = new Uint8ClampedArray(count * 4);
  const outer = new Uint8ClampedArray(count * 4);
  const beam = new Uint8ClampedArray(count * 4);

  function paintRing(x, y, radius, red, green, blue) {
    const color = symmetric(radius);
    if (!color) return;
    const offset = (y * width + x) * 4;
    const layer = radius < innerEnd ? inner : outer;
    layer[offset] = red;
    layer[offset + 1] = green;
    layer[offset + 2] = blue;
    layer[offset + 3] = 255;
    base[offset] = Math.round(color[0]);
    base[offset + 1] = Math.round(color[1]);
    base[offset + 2] = Math.round(color[2]);
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      const radius = Math.hypot(x - centerX, y - centerY);
      const index = (y * width + x) * 4;
      paintRing(x, y, radius, pixels[index], pixels[index + 1], pixels[index + 2]);
    }
  }

  for (let y = 0; y < height; y += 1) {
    if (y > maxY) continue;
    for (let x = 0; x < width; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const radius = Math.hypot(dx, dy);
      if (radius < radiusMin - 4 || radius > radiusMax + 4) continue;
      const angle = Math.atan2(dy, dx);
      if (!onBeam(angle, beamRadians)) continue;
      const rounded = Math.round(radius);
      let nearest = band + 1;
      for (let delta = -3; delta <= 3; delta += 1) {
        const candidate = rounded + delta;
        if (candidate < 0 || candidate >= ring.length || !ring[candidate]) continue;
        const distance = Math.abs(radius - candidate);
        if (distance < nearest) nearest = distance;
      }
      if (nearest > band) continue;
      const color = symmetric(radius);
      if (!color) continue;
      const offset = (y * width + x) * 4;
      const layer = radius < innerEnd ? inner : outer;
      layer[offset] = Math.round(color[0]);
      layer[offset + 1] = Math.round(color[1]);
      layer[offset + 2] = Math.round(color[2]);
      layer[offset + 3] = 255;
      beam[offset] = pixels[offset];
      beam[offset + 1] = pixels[offset + 1];
      beam[offset + 2] = pixels[offset + 2];
      beam[offset + 3] = 255;
    }
  }

  return { base, inner, outer, beam };
}
