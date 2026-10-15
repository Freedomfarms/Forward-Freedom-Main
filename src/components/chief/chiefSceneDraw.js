// One frame of the plasma core, independent orbits, and the floor.
// The caller owns the clock. Coordinates are canvas pixels.

import { ORBITS, ellipsePoint, ringAngle, sceneLayout, waveHead } from "./chiefSceneMotion.js";

const TAU = Math.PI * 2;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sideOf(cy, y) {
  return y >= cy ? "front" : "back";
}

function drawNode(ctx, x, y, radius, alpha) {
  const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 4.2);
  glow.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
  glow.addColorStop(0.22, `rgba(150, 230, 255, ${alpha * 0.75})`);
  glow.addColorStop(1, "rgba(40, 120, 255, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, radius * 4.2, 0, TAU);
  ctx.fill();
  ctx.fillStyle = `rgba(246, 253, 255, ${alpha})`;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();
}

function strokeEllipseSide(ctx, ring, layout, pass, unit) {
  const { cx, cy, radius } = layout;
  const rx = ring.rx * radius;
  const ry = ring.ry * radius;
  const steps = 128;
  ctx.beginPath();
  let drawing = false;
  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * TAU;
    const [x, y] = ellipsePoint(cx, cy, rx, ry, ring.tilt, angle);
    if (sideOf(cy, y) !== pass) {
      drawing = false;
      continue;
    }
    if (!drawing) {
      ctx.moveTo(x, y);
      drawing = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = `rgba(150, 220, 255, ${ring.alpha * (pass === "front" ? 1 : 0.45)})`;
  ctx.lineWidth = Math.max(1, ring.width * unit);
  ctx.stroke();

  if (!ring.ticks) return;
  const count = ring.rx > 1.8 ? 56 : 36;
  ctx.lineWidth = Math.max(1, 0.8 * unit);
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * TAU;
    const inner = ellipsePoint(cx, cy, rx, ry, ring.tilt, angle);
    const outer = ellipsePoint(
      cx,
      cy,
      rx + 7 * unit,
      ry + (ring.ry > 0.9 ? 7 : 2.4) * unit,
      ring.tilt,
      angle
    );
    if (sideOf(cy, (inner[1] + outer[1]) / 2) !== pass) continue;
    ctx.beginPath();
    ctx.moveTo(inner[0], inner[1]);
    ctx.lineTo(outer[0], outer[1]);
    ctx.strokeStyle = `rgba(186, 236, 255, ${pass === "front" ? 0.45 : 0.18})`;
    ctx.stroke();
  }
}

function strokeWave(ctx, ring, layout, head, span, pass, unit) {
  const { cx, cy, radius } = layout;
  const rx = ring.rx * radius;
  const ry = ring.ry * radius;
  const steps = 22;
  for (let i = 0; i < steps; i += 1) {
    const u0 = i / steps;
    const u1 = (i + 1) / steps;
    const a0 = head - span * (1 - u0);
    const a1 = head - span * (1 - u1);
    const [x0, y0] = ellipsePoint(cx, cy, rx, ry, ring.tilt, a0);
    const [x1, y1] = ellipsePoint(cx, cy, rx, ry, ring.tilt, a1);
    if (sideOf(cy, (y0 + y1) / 2) !== pass) continue;
    const alpha = 0.04 + u1 * u1 * 0.9;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = `rgba(226, 252, 255, ${alpha})`;
    ctx.lineWidth = Math.max(1, (0.8 + u1 * 2.4) * unit);
    ctx.stroke();
  }
  const [hx, hy] = ellipsePoint(cx, cy, rx, ry, ring.tilt, head);
  if (sideOf(cy, hy) === pass) drawNode(ctx, hx, hy, 2.6 * unit, pass === "front" ? 1 : 0.45);
}

function drawOrbits(ctx, layout, time, pass, unit) {
  for (const ring of ORBITS) {
    strokeEllipseSide(ctx, ring, layout, pass, unit);
    strokeWave(ctx, ring, layout, waveHead(ring, time, 0), 0.95, pass, unit);
    strokeWave(ctx, ring, layout, waveHead(ring, time, 1), 0.7, pass, unit);
    ring.nodes.forEach((offset, index) => {
      const [x, y] = ellipsePoint(
        layout.cx,
        layout.cy,
        ring.rx * layout.radius,
        ring.ry * layout.radius,
        ring.tilt,
        ringAngle(time, ring) + offset
      );
      if (sideOf(layout.cy, y) !== pass) return;
      const size = (index === 0 ? 5.2 : 3.3) * unit;
      drawNode(ctx, x, y, size, pass === "front" ? 0.95 : 0.4);
    });
  }
}

function drawPlasma(ctx, layout, time, motion, level) {
  const { cx, cy, radius } = layout;
  const violet = motion.violet || 0;
  const error = motion.pace === "error";
  const listen = motion.pace === "listening" ? clamp(level, 0, 1) : 0;
  const body = radius * (1 + listen * 0.14);
  const t = time;

  const halo = ctx.createRadialGradient(cx, cy, body * 0.4, cx, cy, body * 2.15);
  halo.addColorStop(0, error ? "rgba(255, 90, 110, 0.18)" : "rgba(90, 190, 255, 0.22)");
  halo.addColorStop(0.45, violet > 0.5 ? "rgba(120, 70, 255, 0.14)" : "rgba(20, 60, 180, 0.08)");
  halo.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, body * 2.15, 0, TAU);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, body, 0, TAU);
  ctx.clip();

  const base = ctx.createRadialGradient(
    cx - body * 0.22,
    cy - body * 0.28,
    body * 0.05,
    cx,
    cy,
    body
  );
  base.addColorStop(0, "rgba(244, 252, 255, 0.98)");
  base.addColorStop(0.16, error ? "rgba(255, 170, 180, 0.7)" : "rgba(120, 196, 255, 0.72)");
  base.addColorStop(0.46, violet > 0.45 ? "rgba(92, 36, 180, 0.92)" : "rgba(12, 42, 140, 0.94)");
  base.addColorStop(1, error ? "rgba(40, 6, 16, 1)" : "rgba(3, 8, 28, 1)");
  ctx.fillStyle = base;
  ctx.fillRect(cx - body, cy - body, body * 2, body * 2);

  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 8; i += 1) {
    const ang = t * (0.35 + i * 0.05) + i * 1.3;
    const ox = cx + Math.cos(ang) * body * (0.18 + (i % 3) * 0.08);
    const oy = cy + Math.sin(ang * 1.17) * body * 0.22;
    const cloud = ctx.createRadialGradient(ox, oy, 0, ox, oy, body * 0.52);
    const purple = i % 3 === 0 ? violet : violet * 0.35;
    cloud.addColorStop(
      0,
      `rgba(${150 + purple * 90}, ${150 - purple * 80}, 255, ${0.18 + purple * 0.4})`
    );
    cloud.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = cloud;
    ctx.beginPath();
    ctx.arc(ox, oy, body * 0.52, 0, TAU);
    ctx.fill();
  }

  ctx.lineWidth = Math.max(1, body * 0.012);
  for (let i = 0; i < 16; i += 1) {
    const phase = t * (0.55 + (i % 5) * 0.07) + i * 0.73;
    const purple = ((i * 5) % 7) / 7 < 0.28 + violet * 0.55;
    ctx.beginPath();
    ctx.strokeStyle = error
      ? `rgba(255, 150, 160, ${0.28 + (i % 3) * 0.08})`
      : purple
        ? `rgba(${190 + violet * 50}, ${90 + (1 - violet) * 40}, 255, ${0.28 + violet * 0.4})`
        : `rgba(150, 225, 255, ${0.2 + (i % 4) * 0.06})`;
    const steps = 26;
    for (let s = 0; s <= steps; s += 1) {
      const u = s / steps;
      const ang = phase + u * Math.PI * (1.15 + (i % 4) * 0.28) + Math.sin(u * 7 + phase) * 0.55;
      const rad = body * (0.06 + u * 0.9) * (0.72 + 0.28 * Math.sin(i * 1.7 + u * 5));
      const x = cx + Math.cos(ang) * rad;
      const y = cy + Math.sin(ang * 0.82 + i) * rad * 0.9;
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  for (let i = 0; i < 48; i += 1) {
    const ang = t * (0.4 + (i % 5) * 0.05) + i * 2.17;
    const rad = body * (0.12 + ((i * 47) % 80) / 100);
    const x = cx + Math.cos(ang) * rad;
    const y = cy + Math.sin(ang * 0.9 + i) * rad * 0.86;
    ctx.fillStyle =
      i % 5 === 0 ? `rgba(230, 190, 255, ${0.45 + violet * 0.45})` : "rgba(236, 250, 255, 0.75)";
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.8, body * 0.012), 0, TAU);
    ctx.fill();
  }

  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, body * 0.985, 0, TAU);
  ctx.strokeStyle = error
    ? "rgba(255, 170, 180, 0.7)"
    : violet > 0.5
      ? "rgba(190, 150, 255, 0.45)"
      : "rgba(120, 210, 255, 0.4)";
  ctx.lineWidth = Math.max(1, body * 0.012);
  ctx.stroke();

  ctx.save();
  ctx.shadowColor = error ? "rgba(255, 80, 100, 0.9)" : "rgba(80, 210, 255, 0.95)";
  ctx.shadowBlur = 22 * (body / 150);
  ctx.beginPath();
  ctx.arc(cx, cy, body, 0, TAU);
  ctx.strokeStyle = error ? "rgba(255, 186, 196, 0.95)" : "rgba(214, 252, 255, 0.96)";
  ctx.lineWidth = Math.max(1.6, body * 0.018);
  ctx.stroke();
  ctx.restore();

  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, body * 0.16);
  core.addColorStop(0, "rgba(255, 255, 255, 1)");
  core.addColorStop(0.45, "rgba(214, 248, 255, 0.9)");
  core.addColorStop(1, "rgba(80, 180, 255, 0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, body * 0.16, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
  ctx.lineWidth = Math.max(1, body * 0.006);
  const arm = body * 0.055;
  ctx.beginPath();
  ctx.moveTo(cx - arm, cy);
  ctx.lineTo(cx + arm, cy);
  ctx.moveTo(cx, cy - arm);
  ctx.lineTo(cx, cy + arm);
  ctx.stroke();

  if (motion.pace === "thinking") {
    const pulse = body * (1.08 + ((Math.sin(time * 6.2) + 1) / 2) * 0.22);
    ctx.beginPath();
    ctx.arc(cx, cy, pulse, 0, TAU);
    ctx.strokeStyle = "rgba(220, 248, 255, 0.28)";
    ctx.lineWidth = Math.max(1, body * 0.01);
    ctx.stroke();
  }
}

function drawBeam(ctx, layout, time, unit, error) {
  const { cx, cy, radius, platformY } = layout;
  const top = cy + radius * 0.92;
  const grad = ctx.createLinearGradient(cx, top, cx, platformY);
  grad.addColorStop(0, "rgba(230, 250, 255, 0.75)");
  grad.addColorStop(0.25, error ? "rgba(255, 140, 160, 0.28)" : "rgba(120, 210, 255, 0.35)");
  grad.addColorStop(1, "rgba(80, 160, 255, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(cx - 2 * unit, top);
  ctx.lineTo(cx + 2 * unit, top);
  ctx.lineTo(cx + 16 * unit, platformY);
  ctx.lineTo(cx - 16 * unit, platformY);
  ctx.closePath();
  ctx.fill();

  const travel = (time * 0.45) % 1;
  const y = top + (platformY - top) * travel;
  drawNode(ctx, cx, y, 3.2 * unit, 0.9);
}

function drawPlatform(ctx, layout, time, unit, error) {
  const { cx, platformY } = layout;
  const rings = [2.55, 1.85, 1.22, 0.62];
  rings.forEach((scale, index) => {
    const y = platformY + index * 5 * unit;
    const rx = layout.radius * scale;
    const ry = Math.max(8, layout.radius * 0.16 * scale);
    ctx.beginPath();
    ctx.ellipse(cx, y, rx, ry, 0, 0, TAU);
    ctx.strokeStyle = error
      ? `rgba(255, 150, 170, ${0.28 + index * 0.08})`
      : `rgba(110, 220, 255, ${0.28 + index * 0.1})`;
    ctx.lineWidth = Math.max(1, (2.4 - index * 0.35) * unit);
    ctx.stroke();
    const head = time * (0.7 + index * 0.25) * (index % 2 === 0 ? 1 : -1);
    const x = cx + Math.cos(head) * rx;
    const yy = y + Math.sin(head) * ry;
    drawNode(ctx, x, yy, (index === 0 ? 3.4 : 2.2) * unit, 0.85);
  });

  const floor = ctx.createRadialGradient(cx, platformY, 0, cx, platformY, layout.radius * 0.45);
  floor.addColorStop(0, "rgba(230, 250, 255, 0.95)");
  floor.addColorStop(0.4, "rgba(80, 180, 255, 0.35)");
  floor.addColorStop(1, "rgba(40, 100, 255, 0)");
  ctx.fillStyle = floor;
  ctx.beginPath();
  ctx.ellipse(cx, platformY + 8 * unit, layout.radius * 0.42, layout.radius * 0.07, 0, 0, TAU);
  ctx.fill();
}

export function drawChiefScene(ctx, width, height, time, motion, level = 0) {
  const layout = sceneLayout(width, height);
  const unit = layout.radius / 150;
  const error = motion.pace === "error";
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  drawOrbits(ctx, layout, time, "back", unit);
  drawBeam(ctx, layout, time, unit, error);
  drawPlasma(ctx, layout, time, motion, level);
  drawOrbits(ctx, layout, time, "front", unit);
  drawPlatform(ctx, layout, time, unit, error);
  ctx.restore();
}
