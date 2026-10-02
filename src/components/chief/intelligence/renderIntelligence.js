import {
  AMBIENT_COUNT,
  NEBULA,
  ORBITS,
  WAVES,
  ambientParticle,
  coreScale,
  projectRing,
  sampleRing,
  sparkAngles,
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

function drawNebula(context, width, height, time, motion) {
  const originX = width / 2;
  const originY = height / 2;
  const scale = Math.min(width, height);
  const driftScale = (Number(motion.speed) || 0) * 0.15;
  const previous = context.globalCompositeOperation;
  context.globalCompositeOperation = "screen";
  for (const cloud of NEBULA) {
    const x = originX + (cloud.x + Math.sin(time * driftScale + cloud.drift * 8) * cloud.drift) * scale;
    const y = originY + (cloud.y + Math.cos(time * driftScale * 0.8 + cloud.x) * cloud.drift) * scale;
    const radius = cloud.r * scale * 0.72;
    const lit = cloud.color.map((channel) => Math.min(255, channel + 70));
    const gradient = context.createRadialGradient(x, y, radius * 0.1, x, y, radius);
    const alpha = 0.34 * (Number(motion.intensity) || 0);
    gradient.addColorStop(0, rgba(lit, alpha));
    gradient.addColorStop(0.42, rgba(cloud.color, alpha * 0.7));
    gradient.addColorStop(1, rgba(cloud.color, 0));
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
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
  const alpha = wave.alpha * (Number(motion.intensity) || 0) * (0.65 + (Number(motion.glow) || 0) * 0.5);
  gradient.addColorStop(0, "rgba(186, 140, 255, 0)");
  gradient.addColorStop(0.32, `rgba(206, 170, 255, ${alpha * 0.7})`);
  gradient.addColorStop(0.5, `rgba(255, 236, 255, ${alpha})`);
  gradient.addColorStop(0.68, `rgba(176, 110, 245, ${alpha * 0.65})`);
  gradient.addColorStop(1, "rgba(186, 140, 255, 0)");
  context.strokeStyle = gradient;
  context.lineWidth = wave.width;
  context.stroke();
}

function drawOrbits(context, front, originX, originY, scale, time, motion) {
  const glow = Number(motion.glow) || 0;
  const intensity = Number(motion.intensity) || 0;
  for (const orbit of ORBITS) {
    const points = sampleRing(orbit, time, motion);
    const alpha = orbit.alpha * intensity * (front ? 1 : 0.55);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = rgba(orbit.color, alpha * (0.45 + glow * 0.35));
    context.lineWidth = orbit.width * (8 + glow * 4);
    strokeRibbon(context, points, front, originX, originY, scale);
    context.strokeStyle = rgba([255, 246, 255], alpha * 0.9);
    context.lineWidth = Math.max(1.1, orbit.width * 0.7);
    strokeRibbon(context, points, front, originX, originY, scale);

    for (const angle of sparkAngles(orbit, time, motion)) {
      const wobble = 1 + Math.sin(angle * 3 + orbit.phase) * orbit.wobble;
      const point = projectRing(orbit, angle, wobble);
      if (point.z >= 0 !== front) continue;
      const x = originX + point.x * scale;
      const y = originY + point.y * scale;
      const radius = 3.2 + glow * 3.2;
      const spark = context.createRadialGradient(x, y, 0, x, y, radius * 5);
      spark.addColorStop(0, `rgba(255, 252, 255, ${0.95 * intensity})`);
      spark.addColorStop(0.28, rgba(orbit.color, 0.7 * intensity));
      spark.addColorStop(1, rgba(orbit.color, 0));
      context.fillStyle = spark;
      context.beginPath();
      context.arc(x, y, radius * 5, 0, Math.PI * 2);
      context.fill();
    }
  }
}

function coreRadius(scale, time, motion, amplitude) {
  return scale * 0.3 * coreScale(time, motion, amplitude);
}

function drawBloom(context, originX, originY, radius, motion) {
  const glow = Number(motion.glow) || 0;
  const bloom = context.createRadialGradient(originX, originY, radius * 0.08, originX, originY, radius * 3.6);
  bloom.addColorStop(0, `rgba(255, 250, 255, ${0.5 * glow})`);
  bloom.addColorStop(0.16, `rgba(210, 170, 255, ${0.34 * glow})`);
  bloom.addColorStop(0.4, `rgba(120, 48, 210, ${0.18 * glow})`);
  bloom.addColorStop(1, "rgba(40, 0, 70, 0)");
  context.fillStyle = bloom;
  context.beginPath();
  context.arc(originX, originY, radius * 3.6, 0, Math.PI * 2);
  context.fill();
}

function drawCoreBody(context, originX, originY, radius, time, motion) {
  const body = context.createRadialGradient(
    originX - radius * 0.16,
    originY - radius * 0.2,
    radius * 0.02,
    originX,
    originY,
    radius
  );
  body.addColorStop(0, "rgba(255, 255, 255, 1)");
  body.addColorStop(0.14, "rgba(248, 236, 255, 0.95)");
  body.addColorStop(0.4, "rgba(186, 110, 255, 0.72)");
  body.addColorStop(0.68, "rgba(120, 48, 210, 0.28)");
  body.addColorStop(1, "rgba(90, 20, 170, 0)");
  context.fillStyle = body;
  context.beginPath();
  context.arc(originX, originY, radius, 0, Math.PI * 2);
  context.fill();

  const hot = context.createRadialGradient(originX, originY, 0, originX, originY, radius * 0.32);
  hot.addColorStop(0, "rgba(255, 255, 255, 1)");
  hot.addColorStop(0.4, "rgba(250, 240, 255, 0.92)");
  hot.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.fillStyle = hot;
  context.beginPath();
  context.arc(originX, originY, radius * 0.16, 0, Math.PI * 2);
  context.fill();

  const motes = 70;
  const activity = Number(motion.particle) || 0;
  for (let index = 0; index < motes; index += 1) {
    const spin = time * 0.22 * (Number(motion.speed) || 0) + index;
    const ring = 0.12 + (index % 9) * 0.09;
    const x = originX + Math.cos(spin + index * 0.7) * radius * ring;
    const y = originY + Math.sin(spin * 0.65 + index * 1.15) * radius * ring;
    context.fillStyle = `rgba(226, 214, 255, ${0.25 + activity * 0.55})`;
    context.beginPath();
    context.arc(x, y, 0.45 + (index % 3) * 0.28, 0, Math.PI * 2);
    context.fill();
  }
}

function drawDust(context, originX, originY, scale, time, motion) {
  for (let index = 0; index < AMBIENT_COUNT; index += 1) {
    const particle = ambientParticle(index, time, motion);
    if (particle.alpha < 0.02) continue;
    context.fillStyle = `rgba(214, 186, 255, ${particle.alpha})`;
    context.beginPath();
    context.arc(
      originX + particle.x * scale,
      originY + particle.y * scale,
      particle.size,
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

  const radius = coreRadius(scale, time, motion, amplitude);

  context.globalCompositeOperation = "source-over";
  drawNebula(context, width, height, time, motion);
  context.lineCap = "round";
  for (const wave of WAVES) {
    if (wave.layer === "back") drawWave(context, wave, width, height, time, motion);
  }

  context.globalCompositeOperation = "lighter";
  drawOrbits(context, false, originX, originY, scale, time, motion);
  drawBloom(context, originX, originY, radius, motion);
  drawCoreBody(context, originX, originY, radius, time, motion);
  drawOrbits(context, true, originX, originY, scale, time, motion);
  for (const wave of WAVES) {
    if (wave.layer === "front") drawWave(context, wave, width, height, time, motion);
  }
  drawDust(context, originX, originY, scale, time, motion);
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
