import {
  AMBIENT_COUNT,
  ENERGY_RIBBONS,
  INTELLIGENCE_PARTICLE_COUNT,
  PLASMA_LAYERS,
  WAVES,
  ambientParticle,
  coreScale,
  intelligenceParticle,
  ribbonNodeParameters,
  ribbonPoint,
  sampleRibbon,
} from "./chiefIntelligence.js";

function rgba(color, alpha) {
  const value = Math.max(0, Math.min(1, alpha));
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${value})`;
}

function strokeEnergyCore(
  context,
  points,
  front,
  originX,
  originY,
  scale,
  color,
  alpha,
  width,
  minimumEnergy = 0.24
) {
  context.lineCap = "butt";
  context.lineWidth = width;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    if (previous.z >= 0 !== front || point.z >= 0 !== front) continue;
    const energy = Math.max(0.08, Math.min(1, (previous.energy + point.energy) / 2));
    if (energy < minimumEnergy) continue;
    const depth = front ? 0.72 + Math.max(0, point.z) * 0.42 : 0.42;
    context.strokeStyle = rgba(color, alpha * energy * depth);
    context.beginPath();
    context.moveTo(originX + previous.x * scale, originY + previous.y * scale);
    context.lineTo(originX + point.x * scale, originY + point.y * scale);
    context.stroke();
  }
  context.lineCap = "round";
}

function smoothClosedPath(context, points) {
  const first = points[0];
  const last = points[points.length - 1];
  context.beginPath();
  context.moveTo((first.x + last.x) / 2, (first.y + last.y) / 2);
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    context.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
  }
  context.closePath();
}

function drawPlasma(context, width, height, time, motion) {
  const originX = width / 2;
  const originY = height / 2;
  const scale = Math.min(width, height);
  const speed = Number(motion.speed) || 0;
  const intensity = Number(motion.intensity) || 0;
  const previous = context.globalCompositeOperation;
  context.globalCompositeOperation = "screen";
  context.save();
  context.filter = `blur(${Math.max(6, scale * 0.012)}px)`;
  for (const layer of PLASMA_LAYERS) {
    const drift = time * layer.drift * speed;
    const centerX = originX + (layer.x + Math.sin(drift + layer.phase) * 0.035) * scale;
    const centerY = originY + (layer.y + Math.cos(drift * 0.8 + layer.phase) * 0.028) * scale;
    const points = [];
    const steps = 42;
    for (let index = 0; index < steps; index += 1) {
      const angle = (index / steps) * Math.PI * 2;
      const turbulence =
        1 +
        Math.sin(angle * 3 + layer.phase + drift) * 0.17 +
        Math.sin(angle * 7 - layer.phase - drift * 0.7) * 0.075;
      points.push({
        x:
          centerX +
          Math.cos(angle) * layer.radiusX * scale * turbulence +
          Math.sin(angle * 2 + layer.phase) * scale * 0.035,
        y:
          centerY +
          Math.sin(angle) * layer.radiusY * scale * turbulence +
          Math.cos(angle * 3 - layer.phase) * scale * 0.025,
      });
    }
    smoothClosedPath(context, points);
    const radius = Math.max(layer.radiusX, layer.radiusY) * scale;
    const gradient = context.createRadialGradient(
      centerX + Math.sin(layer.phase) * radius * 0.18,
      centerY - Math.cos(layer.phase) * radius * 0.12,
      radius * 0.06,
      centerX,
      centerY,
      radius
    );
    const alpha = layer.alpha * intensity * 1.72;
    const light = layer.color.map((channel) => Math.min(255, channel + 42));
    gradient.addColorStop(0, rgba(light, alpha * 0.9));
    gradient.addColorStop(0.46, rgba(layer.color, alpha * 0.58));
    gradient.addColorStop(1, rgba(layer.color, 0));
    context.fillStyle = gradient;
    context.fill();
    context.strokeStyle = rgba(light, alpha * 0.22);
    context.lineWidth = Math.max(4, scale * 0.012);
    context.stroke();
  }
  context.restore();
  context.globalCompositeOperation = previous;
}

function drawWave(context, wave, width, height, time, motion) {
  const originX = width / 2;
  const originY = height / 2;
  const scale = Math.min(width, height);
  const speed = (Number(motion.speed) || 0) * (Number(motion.wave) || 0);
  const reach = width * 0.52;
  const steps = 56;
  context.beginPath();
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const x = (t - 0.5) * reach * 2;
    const along = t * Math.PI * wave.freq * 2 + time * wave.speed * speed;
    const bow = Math.exp(-Math.pow((t - 0.5) * 3.1, 2)) * scale * 0.16 * Math.sign(wave.y || 1);
    const y =
      wave.y * scale * 0.12 +
      Math.sin(along) * wave.amp * scale * 0.08 +
      Math.sin(along * 0.5 + wave.freq) * wave.amp * scale * 0.04 +
      bow * 0.25;
    if (index === 0) context.moveTo(originX + x, originY + y);
    else context.lineTo(originX + x, originY + y);
  }
  const gradient = context.createLinearGradient(originX - reach, originY, originX + reach, originY);
  const alpha =
    wave.alpha * (Number(motion.intensity) || 0) * (0.38 + (Number(motion.glow) || 0) * 0.22);
  gradient.addColorStop(0, "rgba(186, 140, 255, 0)");
  gradient.addColorStop(0.32, `rgba(206, 170, 255, ${alpha * 0.55})`);
  gradient.addColorStop(0.5, `rgba(236, 220, 255, ${alpha * 0.7})`);
  gradient.addColorStop(0.68, `rgba(176, 110, 245, ${alpha * 0.5})`);
  gradient.addColorStop(1, "rgba(186, 140, 255, 0)");
  context.strokeStyle = gradient;
  context.lineWidth = wave.width * 0.5;
  context.stroke();
}

function drawRibbons(context, front, originX, originY, scale, time, motion) {
  const glow = Number(motion.glow) || 0;
  const intensity = Number(motion.intensity) || 0;
  for (const ribbon of ENERGY_RIBBONS) {
    const points = sampleRibbon(ribbon, time, motion);
    const alpha = ribbon.alpha * intensity * (front ? 1 : 0.54);
    context.lineCap = "round";
    context.lineJoin = "round";
    strokeEnergyCore(
      context,
      points,
      front,
      originX,
      originY,
      scale,
      ribbon.color,
      alpha * (0.24 + glow * 0.14),
      ribbon.width * (6.2 + glow * 2),
      0.12
    );
    strokeEnergyCore(
      context,
      points,
      front,
      originX,
      originY,
      scale,
      ribbon.color,
      front ? Math.min(1.9, 0.88 + alpha * 1.08) : Math.min(1.1, alpha * 1.38),
      Math.max(1.15, ribbon.width * 0.82)
    );

    for (const parameter of ribbonNodeParameters(ribbon, time, motion)) {
      const point = ribbonPoint(ribbon, parameter, time, motion);
      if (point.z >= 0 !== front) continue;
      const x = originX + point.x * scale;
      const y = originY + point.y * scale;
      const sparkRadius = 1.25 + glow * 1.15;
      const spark = context.createRadialGradient(x, y, 0, x, y, sparkRadius * 3.2);
      spark.addColorStop(0, `rgba(255, 252, 255, ${0.95 * intensity})`);
      spark.addColorStop(0.28, rgba(ribbon.color, 0.68 * intensity));
      spark.addColorStop(1, rgba(ribbon.color, 0));
      context.fillStyle = spark;
      context.beginPath();
      context.arc(x, y, sparkRadius * 3.2, 0, Math.PI * 2);
      context.fill();
    }
    const flow = time * Math.abs(ribbon.speed) * (Number(motion.speed) || 0) * 0.34;
    for (let index = 0; index < 14; index += 1) {
      const parameter = (index * 0.173 + ribbon.phase * 0.113 + flow) % 1;
      const point = ribbonPoint(ribbon, parameter, time, motion);
      if (point.z >= 0 !== front) continue;
      const x = originX + point.x * scale;
      const y = originY + point.y * scale;
      const moteAlpha = alpha * (0.2 + ((index * 7) % 10) * 0.045);
      context.fillStyle = rgba(ribbon.color, moteAlpha);
      context.beginPath();
      context.arc(x, y, 0.45 + (index % 3) * 0.3, 0, Math.PI * 2);
      context.fill();
    }
  }
}

function drawLocalFieldGlow(context, originX, originY, scale, time, motion) {
  const glow = Number(motion.glow) || 0;
  const speed = Number(motion.speed) || 0;
  const patches = [
    [-0.12, -0.05, 0.34, [116, 44, 216], 0.13, 0.7],
    [0.1, -0.08, 0.29, [196, 74, 224], 0.1, 1.9],
    [0.08, 0.12, 0.38, [92, 30, 184], 0.12, 3.2],
    [-0.08, 0.14, 0.26, [184, 108, 255], 0.08, 4.6],
  ];
  const previous = context.globalCompositeOperation;
  context.globalCompositeOperation = "screen";
  for (const [offsetX, offsetY, radiusScale, color, alpha, phase] of patches) {
    const x = originX + (offsetX + Math.sin(time * 0.08 * speed + phase) * 0.025) * scale;
    const y = originY + (offsetY + Math.cos(time * 0.065 * speed + phase) * 0.02) * scale;
    const radius = radiusScale * scale;
    const gradient = context.createRadialGradient(x, y, radius * 0.04, x, y, radius);
    gradient.addColorStop(0, rgba(color, alpha * glow));
    gradient.addColorStop(0.45, rgba(color, alpha * glow * 0.48));
    gradient.addColorStop(1, rgba(color, 0));
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
  context.globalCompositeOperation = previous;
}

function drawIntelligenceParticles(
  context,
  front,
  originX,
  originY,
  scale,
  time,
  motion,
  amplitude
) {
  const fieldScale = coreScale(time, motion, amplitude);
  const glow = Number(motion.glow) || 0;
  for (let index = 0; index < INTELLIGENCE_PARTICLE_COUNT; index += 1) {
    const particle = intelligenceParticle(index, time, motion, fieldScale);
    if (particle.z >= 0 !== front) continue;
    const depth = front ? 0.72 + particle.z * 0.72 : 0.36 + (particle.z + 0.4) * 0.18;
    const alpha = Math.max(0.04, particle.alpha * depth);
    const x = originX + particle.x * scale;
    const y = originY + particle.y * scale;
    const color = particle.warm
      ? [255, 208, 154]
      : particle.hot
        ? [255, 246, 255]
        : [198, 154, 255];
    if (particle.hot && index % 2 === 0) {
      const haloRadius = particle.size * (2.8 + glow * 2.1);
      const halo = context.createRadialGradient(x, y, 0, x, y, haloRadius);
      halo.addColorStop(0, rgba(color, alpha * 0.58));
      halo.addColorStop(1, rgba(color, 0));
      context.fillStyle = halo;
      context.beginPath();
      context.arc(x, y, haloRadius, 0, Math.PI * 2);
      context.fill();
    }
    context.fillStyle = rgba(color, alpha);
    context.beginPath();
    context.arc(x, y, particle.size * (front ? 1 : 0.78), 0, Math.PI * 2);
    context.fill();
  }
}

function drawDust(context, front, originX, originY, scale, time, motion) {
  for (let index = 0; index < AMBIENT_COUNT; index += 1) {
    const particle = ambientParticle(index, time, motion);
    if (particle.z >= 0 !== front) continue;
    if (particle.alpha < 0.02) continue;
    const depth = front ? 0.6 + particle.z * 0.4 : 0.32;
    context.fillStyle = `rgba(214, 186, 255, ${particle.alpha * depth})`;
    context.beginPath();
    context.arc(
      originX + particle.x * scale,
      originY + particle.y * scale,
      particle.size * (front ? 1 : 0.72),
      0,
      Math.PI * 2
    );
    context.fill();
  }
}

export function renderIntelligence(context, { width, height, time, motion, amplitude }) {
  context.clearRect(0, 0, width, height);
  const originX = width / 2;
  const originY = height * 0.46;
  const scale = Math.min(width, height) * 0.46;

  context.globalCompositeOperation = "source-over";
  drawPlasma(context, width, height, time, motion);
  drawDust(context, false, originX, originY, scale * 1.28, time, motion);
  context.lineCap = "round";
  for (const wave of WAVES) {
    if (wave.layer === "back") drawWave(context, wave, width, height, time, motion);
  }

  context.globalCompositeOperation = "lighter";
  drawRibbons(context, false, originX, originY, scale, time, motion);
  drawLocalFieldGlow(context, originX, originY, scale, time, motion);
  drawIntelligenceParticles(context, false, originX, originY, scale, time, motion, amplitude);
  drawIntelligenceParticles(context, true, originX, originY, scale, time, motion, amplitude);
  drawRibbons(context, true, originX, originY, scale, time, motion);
  for (const wave of WAVES) {
    if (wave.layer === "front") drawWave(context, wave, width, height, time, motion);
  }
  drawDust(context, true, originX, originY, scale * 1.28, time, motion);
  context.globalCompositeOperation = "source-over";
  const vignette = context.createRadialGradient(
    originX,
    originY,
    scale * 0.55,
    originX,
    originY,
    Math.max(width, height) * 0.72
  );
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.62)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);
}
