import { useEffect, useRef } from "react";

import {
  EASE,
  easeMotion,
  motionPreset,
  resolveAmplitude,
  visualStateForStatus,
} from "./intelligence/chiefIntelligence.js";
import { createIntelligenceRenderer } from "./intelligence/renderIntelligence.js";

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
    let view;
    try {
      view = createIntelligenceRenderer(canvas);
    } catch {
      return undefined;
    }
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
      const rect = canvas.getBoundingClientRect();
      view.render({
        cssWidth: Math.max(1, rect.width),
        cssHeight: Math.max(1, rect.height),
        pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
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
      view.dispose();
    };
  }, []);

  return (
    <div className="chief-field-frame">
      <canvas ref={canvasRef} className="chief-field" aria-hidden="true" />
    </div>
  );
}
