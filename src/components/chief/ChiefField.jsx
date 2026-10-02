import { useEffect, useRef } from "react";

import {
  EASE,
  easeMotion,
  motionPreset,
  resolveAmplitude,
  visualStateForStatus,
} from "./intelligence/chiefIntelligence.js";
import { renderIntelligence } from "./intelligence/renderIntelligence.js";

export function ChiefField({ status, phase = null, amplitude = null }) {
  const canvasRef = useRef(null);
  const statusRef = useRef(status);
  const phaseRef = useRef(phase);
  const amplitudeRef = useRef(amplitude);

  useEffect(() => {
    statusRef.current = status;
    phaseRef.current = phase;
    amplitudeRef.current = amplitude;
  }, [status, phase, amplitude]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let motion = { ...motionPreset("idle") };
    let frame = 0;
    let loop = 0;
    let alive = true;

    function paint(now, token) {
      if (!alive || token !== loop) return;
      const reduce = media.matches;
      const state = phaseRef.current || visualStateForStatus(statusRef.current);
      const target = motionPreset(state);
      motion = easeMotion(motion, target, reduce ? 1 : EASE);
      const context = canvas.getContext("2d");
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.floor(rect.width * ratio));
      const height = Math.max(1, Math.floor(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      renderIntelligence(context, {
        width,
        height,
        time: reduce ? 0 : now / 1000,
        motion: reduce ? target : motion,
        amplitude: resolveAmplitude(amplitudeRef.current),
      });
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
