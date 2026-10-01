import { useEffect, useRef } from "react";

import {
  CHIEF_FIELD,
  createDiamondPoints,
  formationFrame,
  rotateView,
} from "../chief/chiefField.js";
import {
  createCurrent,
  diamondBudget,
  fieldBudget,
  stepCurrent,
  visiblePopulation,
} from "./entryField.js";

function withAlpha(hex, alpha) {
  const value = Math.max(0, Math.min(1, alpha));
  const raw = hex.replace("#", "");
  const red = Number.parseInt(raw.slice(0, 2), 16);
  const green = Number.parseInt(raw.slice(2, 4), 16);
  const blue = Number.parseInt(raw.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${value})`;
}

function diamondInk(point, posed) {
  if (point?.corner || posed?.corner) return "#e7f2ff";
  if (point?.edge) return "#b9d7ff";
  return "#7aa2ff";
}

export function EntryField({ sceneRef }) {
  const canvasRef = useRef(null);
  const hostRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return undefined;

    const mobileQuery = window.matchMedia("(max-width: 1023px)");
    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const size = { width: 1, height: 1, ratio: 1, cssHeight: 1 };
    let particles = createCurrent(fieldBudget(mobileQuery.matches), 7, {
      spread: reducedQuery.matches ? "settled" : "bottom",
    });
    let points = createDiamondPoints(diamondBudget(mobileQuery.matches), 11);
    let frame = 0;
    let alive = true;
    let last = performance.now();
    const motion = { ...CHIEF_FIELD.forming };

    function resize() {
      const rect = host.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.floor(rect.width * ratio));
      const height = Math.max(1, Math.floor(rect.height * ratio));
      size.width = width;
      size.height = height;
      size.ratio = ratio;
      size.cssHeight = rect.height || 1;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }

    function paint(now) {
      if (!alive) return;
      if (document.visibilityState === "hidden") return;

      const view = sceneRef.current || {};
      const reduced = Boolean(view.reduced);
      const dt = reduced ? 0 : Math.min(0.05, (now - last) / 1000);
      last = now;
      const mobile = mobileQuery.matches;
      const budget = fieldBudget(mobile);
      if (particles.length !== budget) {
        particles = createCurrent(budget, 7, { spread: reduced ? "settled" : "bottom" });
      }
      const diamondCount = diamondBudget(mobile);
      if (points.length !== diamondCount) points = createDiamondPoints(diamondCount, 11);
      if (!reduced) stepCurrent(particles, dt, view);
      if (view.pulse > 0) view.pulse = Math.max(0, view.pulse - dt * 1.7);

      const context = canvas.getContext("2d");
      const { width, height, ratio } = size;
      context.clearRect(0, 0, width, height);

      const anchor = size.cssHeight < 760 ? 0.36 : 0.44;
      const originX = width / 2;
      const originY = height * anchor;
      const energy = Number(view.energy) || 0;
      const bottomGlow = Number(view.bottomGlow) || 0;

      if (bottomGlow > 0.02) {
        const glow = context.createLinearGradient(0, height, 0, height * 0.62);
        glow.addColorStop(0, `rgba(185, 215, 255, ${0.2 * bottomGlow})`);
        glow.addColorStop(0.45, `rgba(61, 124, 255, ${0.05 * bottomGlow})`);
        glow.addColorStop(1, "rgba(2, 3, 8, 0)");
        context.fillStyle = glow;
        context.fillRect(0, 0, width, height);
      }

      const assemble = Number(view.assemble) || 0;
      if (energy > 0.25 || assemble > 0.2) {
        const pool = Math.min(width, height) * 0.42;
        const gradient = context.createRadialGradient(originX, originY, 0, originX, originY, pool);
        const poolAlpha = 0.05 + assemble * 0.07 + (view.surge ? 0.04 : 0);
        gradient.addColorStop(0, `rgba(106, 92, 255, ${poolAlpha})`);
        gradient.addColorStop(0.42, `rgba(61, 124, 255, ${poolAlpha * 0.55})`);
        gradient.addColorStop(1, "rgba(2, 3, 8, 0)");
        context.fillStyle = gradient;
        context.fillRect(0, 0, width, height);
      }

      const shown = visiblePopulation(particles.length, view.population || "rest");
      context.lineWidth = Math.max(1, ratio);
      for (let index = 0; index < shown; index += 1) {
        const particle = particles[index];
        const depthFade = 0.16 + particle.depth * 0.7;
        const alpha = depthFade * (0.35 + energy * 0.65);
        const x = (particle.x * 0.5 + 0.5) * width;
        const y = (1 - particle.y) * height;
        const streak = (4 + particle.speed * 18) * (0.45 + particle.depth) * ratio;
        context.strokeStyle = `rgba(185, 215, 255, ${alpha})`;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + particle.arc * 6 * ratio, y + streak);
        context.stroke();
        const partner = particle.link;
        if (partner >= 0 && partner < shown) {
          const other = particles[partner];
          const dx = particle.x - other.x;
          const dy = particle.y - other.y;
          if (dx * dx + dy * dy < 0.05) {
            context.strokeStyle = `rgba(122, 162, 255, ${alpha * 0.35})`;
            context.beginPath();
            context.moveTo(x, y);
            context.lineTo((other.x * 0.5 + 0.5) * width, (1 - other.y) * height);
            context.stroke();
          }
        }
      }

      motion.assemble = reduced ? 1 : assemble;
      const time = reduced ? 0 : now / 1000;
      const drift = view.drift && !reduced ? Math.sin(time * 0.38) * 0.055 : 0;
      const hover = view.hover ? 0.028 : 0;
      const rotation = drift + hover;
      const surge = view.surge && !reduced ? 1 + Math.sin(time * 1.6) * 0.03 : 1;
      const scale =
        Math.min(width, height) *
        (mobile ? 0.2 : 0.22) *
        surge *
        (1 + Math.max(0, view.pulse || 0) * 0.06);

      for (const point of points) {
        const posed = formationFrame(point, motion, time);
        if (posed.alpha < 0.02) continue;
        const turned = rotateView(posed.x, posed.y, rotation);
        context.fillStyle = withAlpha(diamondInk(point, posed), Math.min(1, posed.alpha));
        context.beginPath();
        context.arc(
          originX + turned.x * scale,
          originY + turned.y * scale,
          Math.max(0.7, posed.size) * ratio * (point.corner ? 1.35 : 1),
          0,
          Math.PI * 2
        );
        context.fill();
      }

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
      if (sceneRef.current?.reduced) paint(performance.now());
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
