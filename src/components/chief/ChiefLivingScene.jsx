import { useEffect, useRef } from "react";
import { drawLivingCore } from "./chiefLivingCore.js";
import { LIVING_VIEW, livingMotion, motionForPace } from "./chiefLivingMotion.js";
import "./ChiefLivingScene.css";

const CALLOUTS = [
  ["analyzing", "Analyzing", 118, 248],
  ["reasoning", "Reasoning", 742, 196],
  ["searching", "Searching", 96, 548],
  ["connecting", "Connecting", 748, 512],
];

function calloutLive(activity, id) {
  if (id === "analyzing") return activity.processing || activity.reasoning;
  if (id === "reasoning") return activity.reasoning;
  if (id === "searching") return activity.searching;
  if (id === "connecting") return activity.connecting;
  return false;
}

export function ChiefLivingScene({
  scenePhase = "idle",
  assistantState = "idle",
  status = "",
  statusTone = "ready",
  reducedMotion = false,
  audioLevelRef = null,
}) {
  const rootRef = useRef(null);
  const canvasRef = useRef(null);
  const motion = livingMotion({ scenePhase, assistantState, status, statusTone });

  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return undefined;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return undefined;

    let raf = 0;
    let alive = true;
    let visible = true;
    const started = performance.now();
    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return { w, h };
    }

    function frame(now) {
      raf = 0;
      if (!alive) return;
      const { w, h } = resize();
      const off = root.dataset.motion === "off" || reducedQuery.matches;
      const seconds = off ? 0 : (now - started) / 1000;
      const pace = root.dataset.pace || "idle";
      const pose = motionForPace(pace);
      const level = Number(audioLevelRef?.current) || 0;
      if (pace === "listening") {
        root.style.setProperty("--level", String(Math.max(0, Math.min(1, level))));
      }
      drawLivingCore(context, w, h, seconds, pose, level);
      if (!off && visible && document.visibilityState !== "hidden") {
        raf = requestAnimationFrame(frame);
      }
    }

    function schedule() {
      if (!alive || raf) return;
      raf = requestAnimationFrame(frame);
    }

    const observer = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible) schedule();
    });
    observer.observe(root);
    const onVisibility = () => {
      if (document.visibilityState === "visible") schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const onReduce = () => schedule();
    reducedQuery.addEventListener?.("change", onReduce);
    schedule();

    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reducedQuery.removeEventListener?.("change", onReduce);
    };
  }, [audioLevelRef, reducedMotion]);

  return (
    <div
      ref={rootRef}
      className="chief-living"
      data-pace={motion.pace}
      data-motion={reducedMotion ? "off" : "on"}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="chief-living-canvas" />
      <svg className="chief-living-svg" viewBox={`0 0 ${LIVING_VIEW.width} ${LIVING_VIEW.height}`}>
        <g className="chief-beam">
          <line x1="500" y1="560" x2="500" y2="748" />
        </g>

        <g className="chief-spin chief-spin-d">
          <circle className="chief-ring chief-ring-ticks" cx="500" cy="408" r="372" />
          <circle className="chief-marker chief-marker-dim" cx="872" cy="408" r="3.5" />
        </g>
        <g className="chief-spin chief-spin-c">
          <ellipse className="chief-ring chief-ring-c" cx="500" cy="408" rx="304" ry="186" />
          <circle className="chief-marker" cx="804" cy="408" r="6" />
          <circle className="chief-marker chief-marker-dim" cx="250" cy="500" r="3.5" />
        </g>
        <g className="chief-spin chief-spin-b">
          <ellipse className="chief-ring chief-ring-b" cx="500" cy="408" rx="220" ry="148" />
          <circle className="chief-marker" cx="280" cy="408" r="5.5" />
          <circle className="chief-marker chief-marker-soft" cx="680" cy="330" r="3" />
        </g>
        <g className="chief-spin chief-spin-a">
          <circle className="chief-ring chief-ring-a" cx="500" cy="408" r="186" />
          <circle className="chief-marker chief-marker-hot" cx="686" cy="408" r="5" />
          <circle className="chief-marker" cx="392" cy="276" r="3.2" />
        </g>

        <ellipse className="chief-wave chief-wave-a" cx="500" cy="408" rx="248" ry="162" />
        <ellipse className="chief-wave chief-wave-b" cx="500" cy="408" rx="318" ry="196" />
        <ellipse
          className="chief-wave chief-wave-c chief-wave-inner"
          cx="500"
          cy="408"
          rx="188"
          ry="132"
        />

        <g className="chief-deck">
          <ellipse className="chief-deck-glow" cx="500" cy="792" rx="330" ry="42" />
          <ellipse className="chief-deck-ring chief-deck-a" cx="500" cy="792" rx="292" ry="34" />
          <ellipse className="chief-deck-ring chief-deck-b" cx="500" cy="798" rx="214" ry="24" />
          <ellipse className="chief-deck-ring chief-deck-c" cx="500" cy="804" rx="136" ry="15" />
          <ellipse className="chief-deck-core" cx="500" cy="808" rx="62" ry="8" />
        </g>

        {CALLOUTS.map(([id, label, x, y]) => (
          <g
            key={id}
            className={calloutLive(motion.activity, id) ? "chief-callout is-live" : "chief-callout"}
            transform={`translate(${x} ${y})`}
          >
            <text className="chief-callout-label">{label}</text>
            <rect className="chief-callout-track" x="0" y="16" width="92" height="3" rx="1.5" />
            <rect className="chief-callout-fill" x="0" y="16" width="54" height="3" rx="1.5" />
          </g>
        ))}
      </svg>
    </div>
  );
}
