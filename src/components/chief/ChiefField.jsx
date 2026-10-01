import { useEffect, useRef } from "react";

import {
  CHIEF_FIELD,
  createDiamondPoints,
  easeMotion,
  fieldMotionForStatus,
  pointColor,
  pointFrame,
} from "./chiefField.js";

function withAlpha(hex, alpha) {
  const value = Math.max(0, Math.min(1, alpha));
  const raw = hex.replace("#", "");
  const red = Number.parseInt(raw.slice(0, 2), 16);
  const green = Number.parseInt(raw.slice(2, 4), 16);
  const blue = Number.parseInt(raw.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${value})`;
}

export function ChiefField({ status }) {
  const canvasRef = useRef(null);
  const statusRef = useRef(status);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const mobileQuery = window.matchMedia("(max-width: 1023px)");
    let points = createDiamondPoints(
      mobileQuery.matches ? CHIEF_FIELD.mobilePoints : CHIEF_FIELD.desktopPoints
    );
    let motion = { ...CHIEF_FIELD.ready };
    let frame = 0;
    let loop = 0;
    let alive = true;

    function paint(now, token) {
      if (!alive || token !== loop) return;
      const count = mobileQuery.matches ? CHIEF_FIELD.mobilePoints : CHIEF_FIELD.desktopPoints;
      if (points.length !== count) points = createDiamondPoints(count);
      const reduce = media.matches;
      const target = reduce ? CHIEF_FIELD.ready : fieldMotionForStatus(statusRef.current);
      motion = easeMotion(motion, target, reduce ? 1 : CHIEF_FIELD.ease);
      const context = canvas.getContext("2d");
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.floor(rect.width * ratio));
      const height = Math.max(1, Math.floor(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.clearRect(0, 0, width, height);
      const scale = Math.min(width, height) * 0.36;
      const originX = width / 2;
      const originY = height / 2;
      const time = reduce ? 0 : now / 1000;
      for (const point of points) {
        const posed = pointFrame(point, motion, time);
        const color = pointColor(posed, motion);
        context.fillStyle = withAlpha(color, posed.alpha);
        context.beginPath();
        context.arc(
          originX + posed.x * scale,
          originY + posed.y * scale,
          Math.max(0.6, posed.size) * ratio,
          0,
          Math.PI * 2
        );
        context.fill();
      }
      if (!reduce) frame = requestAnimationFrame((next) => paint(next, token));
    }

    function start() {
      loop += 1;
      const token = loop;
      cancelAnimationFrame(frame);
      if (media.matches) paint(0, token);
      else frame = requestAnimationFrame((next) => paint(next, token));
    }

    const observer = new ResizeObserver(() => start());
    observer.observe(canvas);
    start();
    media.addEventListener("change", start);
    return () => {
      alive = false;
      observer.disconnect();
      cancelAnimationFrame(frame);
      media.removeEventListener("change", start);
    };
  }, []);

  return (
    <div className="chief-field-frame">
      <canvas ref={canvasRef} className="chief-field" aria-hidden="true" />
    </div>
  );
}
