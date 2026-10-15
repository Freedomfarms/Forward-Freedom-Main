// One 2D frame of the plasma core. The caller owns the animation clock.

import { LIVING_VIEW } from "./chiefLivingMotion.js";

const TAU = Math.PI * 2;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function drawLivingCore(ctx, width, height, time, motion, level = 0) {
  const sx = width / LIVING_VIEW.width;
  const sy = height / LIVING_VIEW.height;
  const cx = LIVING_VIEW.cx * sx;
  const cy = LIVING_VIEW.cy * sy;
  const unit = Math.min(sx, sy);
  const listen = motion.pace === "listening" ? clamp(level, 0, 1) : 0;
  const radius = LIVING_VIEW.core * unit * (1 + listen * 0.16);
  const speed = motion.speed || 1;
  const violet = motion.violet || 0;
  const t = time * speed;
  const error = motion.pace === "error";

  ctx.clearRect(0, 0, width, height);
  ctx.save();

  const halo = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 2.15);
  halo.addColorStop(0, error ? "rgba(255, 120, 140, 0.16)" : "rgba(120, 210, 255, 0.22)");
  halo.addColorStop(0.42, violet > 0.5 ? "rgba(140, 80, 255, 0.16)" : "rgba(30, 80, 220, 0.1)");
  halo.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 2.15, 0, TAU);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.clip();

  const body = ctx.createRadialGradient(
    cx - radius * 0.28,
    cy - radius * 0.32,
    radius * 0.08,
    cx,
    cy,
    radius
  );
  body.addColorStop(0, "rgba(236, 250, 255, 0.98)");
  body.addColorStop(0.16, violet > 0.5 ? "rgba(176, 130, 255, 0.82)" : "rgba(90, 176, 255, 0.78)");
  body.addColorStop(0.48, "rgba(18, 52, 150, 0.94)");
  body.addColorStop(1, "rgba(3, 10, 36, 0.98)");
  ctx.fillStyle = body;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);

  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 5; i += 1) {
    const ang = t * (0.32 + i * 0.06) + i * 1.4;
    const ox = cx + Math.cos(ang) * radius * 0.32;
    const oy = cy + Math.sin(ang * 1.25) * radius * 0.24;
    const cloud = ctx.createRadialGradient(ox, oy, 0, ox, oy, radius * 0.58);
    const purple = i % 2 === 0 ? violet : violet * 0.4;
    cloud.addColorStop(
      0,
      `rgba(${150 + purple * 80}, ${170 - purple * 70}, 255, ${0.16 + purple * 0.38})`
    );
    cloud.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = cloud;
    ctx.beginPath();
    ctx.arc(ox, oy, radius * 0.58, 0, TAU);
    ctx.fill();
  }

  ctx.lineWidth = Math.max(1, unit);
  for (let i = 1; i <= 6; i += 1) {
    const lat = (i / 7) * Math.PI;
    const y = cy + Math.cos(lat) * radius;
    const rr = Math.sin(lat) * radius;
    ctx.beginPath();
    ctx.ellipse(cx, y, Math.max(1, rr), Math.max(1, rr * 0.18), 0, 0, TAU);
    ctx.strokeStyle = `rgba(186, 236, 255, ${0.08 + (i % 3) * 0.04})`;
    ctx.stroke();
  }

  for (let i = 0; i < 10; i += 1) {
    const rot = t * 0.55 + (i / 10) * TAU;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(1, Math.abs(Math.cos(rot)) * radius), radius, 0, 0, TAU);
    ctx.strokeStyle =
      i % 4 === 0 && violet > 0.45 ? "rgba(210, 176, 255, 0.34)" : "rgba(160, 230, 255, 0.16)";
    ctx.stroke();
  }

  ctx.lineWidth = Math.max(1.2, unit * 1.4);
  for (let i = 0; i < 6; i += 1) {
    const ang = t * (0.7 + i * 0.08) + i;
    ctx.beginPath();
    ctx.strokeStyle = i % 2 === 0 ? "rgba(255, 255, 255, 0.45)" : "rgba(120, 220, 255, 0.4)";
    const x0 = cx + Math.cos(ang) * radius * 0.15;
    const y0 = cy + Math.sin(ang) * radius * 0.12;
    const x1 = cx + Math.cos(ang + 1.2) * radius * 0.78;
    const y1 = cy + Math.sin(ang + 0.6) * radius * 0.7;
    const x2 = cx + Math.cos(ang + 2.1) * radius * 0.4;
    const y2 = cy + Math.sin(ang + 2.4) * radius * 0.55;
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(x2, y2, x1, y1);
    ctx.stroke();
  }

  for (let i = 0; i < 70; i += 1) {
    const seed = i * 12.9898;
    const ang = t * (0.45 + (i % 7) * 0.05) + seed;
    const rad = radius * (0.12 + ((i * 47) % 82) / 100);
    const x = cx + Math.cos(ang) * rad;
    const y = cy + Math.sin(ang * 0.82 + seed) * rad * 0.92;
    const size = unit * (1.1 + (i % 3) * 0.7);
    ctx.fillStyle =
      i % 6 === 0 ? `rgba(220, 180, 255, ${0.35 + violet * 0.45})` : "rgba(226, 248, 255, 0.62)";
    ctx.fillRect(x, y, size, size);
  }

  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.97, 0, TAU);
  ctx.strokeStyle = violet > 0.5 ? "rgba(196, 150, 255, 0.55)" : "rgba(90, 186, 255, 0.4)";
  ctx.lineWidth = Math.max(1, unit * 1.3);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.strokeStyle = error ? "rgba(255, 150, 166, 0.9)" : "rgba(214, 252, 255, 0.95)";
  ctx.lineWidth = Math.max(2, unit * 2.6);
  ctx.shadowColor = error ? "rgba(255, 120, 140, 0.8)" : "rgba(80, 210, 255, 0.9)";
  ctx.shadowBlur = 18 * unit;
  ctx.stroke();
  ctx.shadowBlur = 0;

  if (motion.pace === "thinking") {
    const pulse = radius * (0.58 + (Math.sin(time * 7) * 0.5 + 0.5) * 0.28);
    ctx.beginPath();
    ctx.arc(cx, cy, pulse, 0, TAU);
    ctx.strokeStyle = "rgba(236, 252, 255, 0.42)";
    ctx.lineWidth = Math.max(1, unit * 1.6);
    ctx.stroke();
  }

  const hot = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.24);
  hot.addColorStop(0, "rgba(255, 255, 255, 1)");
  hot.addColorStop(0.4, "rgba(214, 248, 255, 0.92)");
  hot.addColorStop(1, "rgba(80, 170, 255, 0)");
  ctx.fillStyle = hot;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.24, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = Math.max(1, unit);
  ctx.beginPath();
  ctx.moveTo(cx - radius * 0.08, cy);
  ctx.lineTo(cx + radius * 0.08, cy);
  ctx.moveTo(cx, cy - radius * 0.08);
  ctx.lineTo(cx, cy + radius * 0.08);
  ctx.stroke();

  ctx.restore();
}
