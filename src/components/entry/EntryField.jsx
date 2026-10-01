import { useEffect, useRef } from "react";

import {
  CHIEF_FIELD,
  createDiamondPoints,
  formationFrame,
  rotateView,
} from "../chief/chiefField.js";
import {
  createCurrent,
  fieldBudget,
  fieldPointToScreen,
  frameRings,
  placeParticle,
  sceneAnchors,
  stepCurrent,
} from "./entryField.js";

const SHELLS = [{ scale: 1, start: 0.86 }];

function diamondInk(alpha) {
  return `rgba(185, 215, 255, ${alpha})`;
}

export function EntryField({ sceneRef }) {
  const canvasRef = useRef(null);
  const hostRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return undefined;

    const mobileQuery = window.matchMedia("(max-width: 1023px)");
    const size = { width: 1, height: 1, ratio: 1 };
    let particles = createCurrent(fieldBudget(mobileQuery.matches), 7);
    let corners = createDiamondPoints(4, 1);
    let frame = 0;
    let alive = true;
    let last = performance.now();
    const motion = { ...CHIEF_FIELD.forming, assemble: 1 };

    function resize() {
      const rect = host.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.floor(rect.width * ratio));
      const height = Math.max(1, Math.floor(rect.height * ratio));
      size.width = width;
      size.height = height;
      size.ratio = ratio;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }

    function paintOrb(context, view, width, height) {
      const anchors = sceneAnchors(view);
      const core = fieldPointToScreen(anchors.core.x, anchors.core.y, width, height);
      const intensity = anchors.weights.core;
      if (intensity < 0.02) return;
      const unit = Math.min(width, height);
      const layers = [
        { radius: unit * 0.22, color: `rgba(106, 92, 255, ${0.18 * intensity})` },
        { radius: unit * 0.11, color: `rgba(61, 124, 255, ${0.55 * intensity})` },
        { radius: unit * 0.048, color: `rgba(186, 224, 255, ${0.82 * intensity})` },
        { radius: unit * 0.02, color: `rgba(248, 252, 255, ${1 * intensity})` },
      ];
      for (const layer of layers) {
        const gradient = context.createRadialGradient(
          core.sx,
          core.sy,
          0,
          core.sx,
          core.sy,
          layer.radius
        );
        gradient.addColorStop(0, layer.color);
        gradient.addColorStop(1, "rgba(2, 3, 8, 0)");
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(core.sx, core.sy, layer.radius, 0, Math.PI * 2);
        context.fill();
      }
    }

    function paintRings(context, view, time, width, height) {
      const unit = Math.min(width, height);
      context.lineWidth = Math.max(1, size.ratio);
      for (const ring of frameRings(view, time)) {
        if (ring.alpha < 0.02) continue;
        const center = fieldPointToScreen(ring.x, ring.y, width, height);
        context.strokeStyle = `rgba(150, 196, 255, ${ring.alpha})`;
        context.beginPath();
        context.arc(center.sx, center.sy, ring.norm * unit, 0, Math.PI * 2);
        context.stroke();
      }
    }

    function paintDiamond(context, view, time, width, height) {
      const anchors = sceneAnchors(view, time);
      const { form, space, rotation } = anchors;
      if (form < 0.45) return;
      const order = ["n", "e", "s", "w"];
      for (const shell of SHELLS) {
        const alpha = smoothAppear(shell.start, form) * 0.75;
        if (alpha < 0.03) continue;
        const placed = [];
        for (const point of corners) {
          const posed = formationFrame(point, motion, time);
          const turned = rotateView(posed.x * shell.scale, posed.y * shell.scale, rotation);
          const vertex = fieldPointToScreen(
            space.centerX + turned.x * space.halfX,
            space.centerY - turned.y * space.halfY,
            width,
            height
          );
          placed.push({ id: point.corner, ...vertex });
        }
        context.strokeStyle = diamondInk(alpha);
        context.lineWidth = (shell.scale === 1 ? 1.35 : 0.9) * size.ratio;
        context.beginPath();
        order.forEach((id, index) => {
          const corner = placed.find((item) => item.id === id);
          if (!corner) return;
          if (index === 0) context.moveTo(corner.sx, corner.sy);
          else context.lineTo(corner.sx, corner.sy);
        });
        context.closePath();
        context.stroke();
        if (shell.scale === 1 && form > 0.6) {
          for (const corner of placed) {
            const flare = (3.2 + form * 3.5) * size.ratio;
            context.fillStyle = `rgba(231, 242, 255, ${0.35 + form * 0.5})`;
            context.beginPath();
            context.arc(corner.sx, corner.sy, flare, 0, Math.PI * 2);
            context.fill();
          }
        }
      }
      if (form > 0.5) {
        const focus = fieldPointToScreen(space.centerX, space.centerY, width, height);
        const radius = Math.min(space.halfX * width * 0.5, space.halfY * height) * 0.55;
        const glow = context.createRadialGradient(
          focus.sx,
          focus.sy,
          0,
          focus.sx,
          focus.sy,
          radius
        );
        const alpha = (form - 0.45) * 0.9;
        glow.addColorStop(0, `rgba(236, 246, 255, ${alpha})`);
        glow.addColorStop(0.45, `rgba(61, 124, 255, ${alpha * 0.45})`);
        glow.addColorStop(1, "rgba(2, 3, 8, 0)");
        context.fillStyle = glow;
        context.beginPath();
        context.arc(focus.sx, focus.sy, radius, 0, Math.PI * 2);
        context.fill();
      }
    }

    function paint(now) {
      if (!alive) return;
      if (document.visibilityState === "hidden") return;

      const source = sceneRef.current || {};
      const reduced = source.variant === "reduced" || source.population === "reduced";
      const dt = reduced ? 0 : Math.min(0.05, (now - last) / 1000);
      last = now;
      const mobile = mobileQuery.matches;
      const budget = fieldBudget(mobile);
      if (particles.length !== budget) particles = createCurrent(budget, 7);
      const view = { ...source, mobile };
      if (!reduced) stepCurrent(particles, dt, view);
      if (view.pulse > 0) view.pulse = Math.max(0, view.pulse - dt * 1.7);
      if (sceneRef.current) sceneRef.current.pulse = view.pulse;

      const context = canvas.getContext("2d");
      const { width, height, ratio } = size;
      const time = reduced ? 0 : now / 1000;
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = "lighter";
      context.lineCap = "round";
      paintOrb(context, view, width, height);
      paintRings(context, view, time, width, height);

      for (let index = 0; index < particles.length; index += 1) {
        const placed = placeParticle(particles[index], view, time);
        if (!placed.visible || placed.a < 0.02) continue;
        const copies = placed.copies || 1;
        const spread = placed.spread || 0;
        for (let copy = 0; copy < copies; copy += 1) {
          const offset = (copy - (copies - 1) / 2) * spread;
          const point = fieldPointToScreen(
            placed.x + (placed.nx || 0) * offset,
            placed.y + (placed.ny || 0) * offset,
            width,
            height
          );
          const tangentX = placed.tx * width * 0.5;
          const tangentY = -placed.ty * height;
          const tangent = Math.hypot(tangentX, tangentY) || 1;
          const length = placed.stretch * height;
          if (length > 1.2) {
            context.strokeStyle = `rgba(${placed.r}, ${placed.g}, ${placed.b}, ${placed.a * 0.85})`;
            context.lineWidth = Math.max(0.7, ratio);
            context.beginPath();
            context.moveTo(
              point.sx - (tangentX / tangent) * length,
              point.sy - (tangentY / tangent) * length
            );
            context.lineTo(point.sx, point.sy);
            context.stroke();
          }
          const radius = (placed.scatter ? 2.2 : 0.95 + placed.lock * 0.35) * ratio;
          context.fillStyle = `rgba(${placed.r}, ${placed.g}, ${placed.b}, ${Math.min(1, placed.a)})`;
          context.beginPath();
          context.arc(point.sx, point.sy, radius, 0, Math.PI * 2);
          context.fill();
        }
      }

      paintDiamond(context, view, time, width, height);
      context.globalCompositeOperation = "source-over";
      if (!reduced) frame = requestAnimationFrame(paint);
    }

    function start() {
      cancelAnimationFrame(frame);
      last = performance.now();
      frame = requestAnimationFrame(paint);
    }

    function onVisible() {
      if (document.visibilityState === "visible") start();
    }

    const observer = new ResizeObserver(() => {
      resize();
      if (sceneRef.current?.population === "reduced") paint(performance.now());
    });
    observer.observe(host);
    resize();
    start();
    document.addEventListener("visibilitychange", onVisible);
    mobileQuery.addEventListener("change", start);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisible);
      mobileQuery.removeEventListener("change", start);
    };
  }, [sceneRef]);

  return (
    <div ref={hostRef} className="mf-field-host" aria-hidden="true">
      <canvas ref={canvasRef} className="mf-field-canvas" />
    </div>
  );
}

function smoothAppear(start, form) {
  const t = Math.min(1, Math.max(0, (form - start) / (1 - start || 1)));
  return t * t * (3 - 2 * t);
}
