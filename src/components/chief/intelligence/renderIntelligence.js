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

function strokeRibbon(context, points, front, originX, originY, scale) {
  let drawing = false;
  context.beginPath();
  for (const point of points) {
    if (point.z >= 0 !== front) {
      drawing = false;
      continue;
    }
    const x = originX + point.x * scale;
    const y = originY + point.y * scale;
    if (!drawing) {
      context.moveTo(x, y);
      drawing = true;
    } else {
      context.lineTo(x, y);
    }
  }
  context.stroke();
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
    const alpha = layer.alpha * intensity;
    gradient.addColorStop(0, rgba(layer.color, alpha * 0.8));
    gradient.addColorStop(0.46, rgba(layer.color, alpha * 0.48));
    gradient.addColorStop(1, rgba(layer.color, 0));
    context.fillStyle = gradient;
    context.fill();
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
    const alpha = ribbon.alpha * intensity * (front ? 1 : 0.36);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = rgba(ribbon.color, alpha * (0.13 + glow * 0.06));
    context.lineWidth = ribbon.width * (3.8 + glow * 1.1);
    strokeRibbon(context, points, front, originX, originY, scale);
    context.strokeStyle = rgba(ribbon.color, Math.min(1, alpha * 0.92));
    context.lineWidth = Math.max(0.72, ribbon.width * 0.58);
    strokeRibbon(context, points, front, originX, originY, scale);

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
  }
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
    if (particle.hot && index % 3 === 0) {
      const haloRadius = particle.size * (2.6 + glow * 1.8);
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
  const scale = Math.min(width, height) * 0.4;

  context.globalCompositeOperation = "source-over";
  drawPlasma(context, width, height, time, motion);
  drawDust(context, false, originX, originY, scale * 1.28, time, motion);
  context.lineCap = "round";
  for (const wave of WAVES) {
    if (wave.layer === "back") drawWave(context, wave, width, height, time, motion);
  }

  context.globalCompositeOperation = "lighter";
  drawRibbons(context, false, originX, originY, scale, time, motion);
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
