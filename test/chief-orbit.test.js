import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CHIEF_ORBIT,
  orbitNodePosition,
  splitChiefOrbitLayers,
} from "../src/components/chief/chiefOrbit.js";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("orbital layers turn opposite directions at different speeds", () => {
  assert.ok(CHIEF_ORBIT.outerSeconds >= 45 && CHIEF_ORBIT.outerSeconds <= 70);
  assert.ok(CHIEF_ORBIT.innerSeconds >= 25 && CHIEF_ORBIT.innerSeconds <= 40);
  assert.notEqual(CHIEF_ORBIT.outerSeconds, CHIEF_ORBIT.innerSeconds);

  const face = read("src/components/chief/ChiefInterface.jsx");
  const field = read("src/components/chief/ChiefOrbitField.jsx");
  const css = read("src/components/chief/ChiefInterface.css");

  assert.match(face, /<ChiefOrbitField/);
  assert.match(field, /chief-orbit-outer/);
  assert.match(field, /chief-orbit-inner/);
  assert.match(field, /outerSeconds/);
  assert.match(field, /innerSeconds/);
  assert.match(css, /@keyframes chief-orbit-cw \{\s*to \{\s*transform: rotate\(360deg\);/);
  assert.match(css, /@keyframes chief-orbit-ccw \{\s*to \{\s*transform: rotate\(-360deg\);/);
  assert.match(css, /\.chief-orbit-outer \{\s*animation: chief-orbit-cw linear infinite;/);
  assert.match(css, /\.chief-orbit-inner \{\s*animation: chief-orbit-ccw linear infinite;/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.is-reduced-motion \.chief-orbit-layer/);
  assert.match(css, /pointer-events:\s*none/);
  assert.doesNotMatch(field, /requestAnimationFrame|setInterval/);
});

test("nodes sit on the inner and outer ring groups", () => {
  for (const node of CHIEF_ORBIT.nodes.inner) {
    assert.ok(node.radius < CHIEF_ORBIT.innerEnd);
    const place = orbitNodePosition(node);
    assert.match(place.left, /%$/);
    assert.match(place.top, /%$/);
  }
  for (const node of CHIEF_ORBIT.nodes.outer) {
    assert.ok(node.radius >= CHIEF_ORBIT.innerEnd);
  }
});

test("ring strokes split onto independent layers and the core stays still", () => {
  const width = 180;
  const height = 180;
  const center = 90;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      pixels[index] = 8;
      pixels[index + 1] = 14;
      pixels[index + 2] = 36;
      pixels[index + 3] = 255;
    }
  }

  function paintRing(radius, red, green, blue) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const distance = Math.hypot(x - center, y - center);
        if (Math.abs(distance - radius) > 1.2) continue;
        const index = (y * width + x) * 4;
        pixels[index] = red;
        pixels[index + 1] = green;
        pixels[index + 2] = blue;
      }
    }
  }

  paintRing(40, 90, 210, 255);
  paintRing(70, 170, 120, 255);
  const core = (center * width + center) * 4;
  pixels[core] = 255;
  pixels[core + 1] = 255;
  pixels[core + 2] = 255;

  const layers = splitChiefOrbitLayers(pixels, width, height, {
    centerX: center,
    centerY: center,
    innerEnd: 55,
    radiusMin: 30,
    radiusMax: 80,
    band: 2.2,
    beamRadians: (4 * Math.PI) / 180,
    peakMin: 25,
    lumaPeak: 70,
    lumaKeep: 36,
    maxY: height,
  });

  assert.ok(layers);
  const rightInner = (center * width + (center + 40)) * 4;
  const rightOuter = (center * width + (center + 70)) * 4;
  const corner = 0;

  assert.equal(layers.inner[rightInner + 3], 255);
  assert.equal(layers.outer[rightInner + 3], 0);
  assert.equal(layers.outer[rightOuter + 3], 255);
  assert.equal(layers.inner[rightOuter + 3], 0);
  assert.equal(layers.inner[core + 3], 0);
  assert.equal(layers.outer[core + 3], 0);
  assert.equal(layers.base[core], 255);
  assert.equal(layers.base[core + 1], 255);
  assert.equal(layers.inner[corner + 3], 0);
  assert.equal(layers.outer[corner + 3], 0);
  assert.equal(layers.base[corner], pixels[corner]);
});
