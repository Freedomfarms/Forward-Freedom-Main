import { useEffect, useRef, useState } from "react";

import {
  CHIEF_FIELD,
  createDiamondPoints,
  easeMotion,
  fieldMotionForStatus,
  pointColor,
  pointFrame,
  rotateView,
} from "./chiefField.js";

function withAlpha(hex, alpha) {
  const value = Math.max(0, Math.min(1, alpha));
  const raw = hex.replace("#", "");
  const red = Number.parseInt(raw.slice(0, 2), 16);
  const green = Number.parseInt(raw.slice(2, 4), 16);
  const blue = Number.parseInt(raw.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${value})`;
}

function pointerAngle(event, element) {
  const rect = element.getBoundingClientRect();
  return Math.atan2(
    event.clientY - (rect.top + rect.height / 2),
    event.clientX - (rect.left + rect.width / 2)
  );
}

export function ChiefField({ status }) {
  const canvasRef = useRef(null);
  const frameRef = useRef(null);
  const statusRef = useRef(status);
  const rotationRef = useRef(0);
  const [turning, setTurning] = useState(false);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const frameEl = frameRef.current;
    if (!canvas || !frameEl) return undefined;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const mobileQuery = window.matchMedia("(max-width: 1023px)");
    let points = createDiamondPoints(
      mobileQuery.matches ? CHIEF_FIELD.mobilePoints : CHIEF_FIELD.desktopPoints
    );
    let motion = { ...CHIEF_FIELD.ready };
    let frame = 0;
    let loop = 0;
    let alive = true;
    let drag = null;

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
      const scale = Math.min(width, height) * CHIEF_FIELD.drawScale;
      const originX = width / 2;
      const originY = height / 2;
      const time = reduce ? 0 : now / 1000;
      const rotation = rotationRef.current;
      for (const point of points) {
        const posed = pointFrame(point, motion, time);
        const color = pointColor(posed, motion);
        const turned = rotateView(posed.x, posed.y, rotation);
        context.fillStyle = withAlpha(color, posed.alpha);
        context.beginPath();
        context.arc(
          originX + turned.x * scale,
          originY + turned.y * scale,
          Math.max(0.6, posed.size) * ratio,
          0,
          Math.PI * 2
        );
        context.fill();
      }
      if (!reduce) frame = requestAnimationFrame((next) => paint(next, token));
    }

    function paintStill() {
      if (media.matches) paint(0, loop);
    }

    function start() {
      loop += 1;
      const token = loop;
      cancelAnimationFrame(frame);
      if (media.matches) paint(0, token);
      else frame = requestAnimationFrame((next) => paint(next, token));
    }

    function onPointerDown(event) {
      if (event.button !== 0) return;
      drag = {
        pointerId: event.pointerId,
        startAngle: pointerAngle(event, frameEl),
        startRotation: rotationRef.current,
      };
      setTurning(true);
      if (frameEl.setPointerCapture) frameEl.setPointerCapture(event.pointerId);
    }

    function onPointerMove(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      rotationRef.current = drag.startRotation + (pointerAngle(event, frameEl) - drag.startAngle);
      paintStill();
    }

    function endDrag(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      setTurning(false);
    }

    const observer = new ResizeObserver(() => start());
    observer.observe(canvas);
    start();
    media.addEventListener("change", start);
    frameEl.addEventListener("pointerdown", onPointerDown);
    frameEl.addEventListener("pointermove", onPointerMove);
    frameEl.addEventListener("pointerup", endDrag);
    frameEl.addEventListener("pointercancel", endDrag);
    return () => {
      alive = false;
      observer.disconnect();
      cancelAnimationFrame(frame);
      media.removeEventListener("change", start);
      frameEl.removeEventListener("pointerdown", onPointerDown);
      frameEl.removeEventListener("pointermove", onPointerMove);
      frameEl.removeEventListener("pointerup", endDrag);
      frameEl.removeEventListener("pointercancel", endDrag);
    };
  }, []);

  return (
    <div ref={frameRef} className={turning ? "chief-field-frame is-turning" : "chief-field-frame"}>
      <canvas ref={canvasRef} className="chief-field" aria-hidden="true" />
    </div>
  );
}
