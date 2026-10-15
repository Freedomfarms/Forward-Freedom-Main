import { useEffect, useRef } from "react";
import { drawChiefScene } from "./chiefSceneDraw.js";
import { sceneMotion } from "./chiefSceneMotion.js";
import "./ChiefScene.css";

const CALLOUTS = [
  ["analyzing", "Analyzing", "chief-callout-analyzing"],
  ["reasoning", "Reasoning", "chief-callout-reasoning"],
  ["searching", "Searching", "chief-callout-searching"],
  ["connecting", "Connecting", "chief-callout-connecting"],
];

function calloutLive(activity, id) {
  if (id === "analyzing") return activity.processing || activity.reasoning;
  if (id === "reasoning") return activity.reasoning;
  if (id === "searching") return activity.searching;
  if (id === "connecting") return activity.connecting;
  return false;
}

export function ChiefScene({
  scenePhase = "idle",
  assistantState = "idle",
  status = "",
  statusTone = "ready",
  reducedMotion = false,
  audioLevelRef = null,
  shellRef = null,
}) {
  const rootRef = useRef(null);
  const canvasRef = useRef(null);
  const motion = sceneMotion({ scenePhase, assistantState, status, statusTone });

  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return undefined;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return undefined;

    let raf = 0;
    let alive = true;
    let visible = true;
    let elapsed = 0;
    let last = performance.now();
    const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.35);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      return { width, height };
    }

    function frame(now) {
      raf = 0;
      if (!alive) return;
      const { width, height } = resize();
      const reduced = root.dataset.motion === "off" || reducedQuery.matches;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const pose = sceneMotion({
        scenePhase: root.dataset.phase,
        assistantState: root.dataset.state,
        status: root.dataset.status,
        statusTone: root.dataset.tone,
      });
      if (!reduced && visible && document.visibilityState !== "hidden") elapsed += dt * pose.speed;
      const level = Number(audioLevelRef?.current) || 0;
      if (pose.pace === "listening" && shellRef?.current) {
        shellRef.current.style.setProperty(
          "--chief-level",
          String(Math.max(0, Math.min(1, level)))
        );
      }
      drawChiefScene(context, width, height, reduced ? 0 : elapsed, pose, level);
      if (!reduced && visible && document.visibilityState !== "hidden") {
        raf = requestAnimationFrame(frame);
      }
    }

    function schedule() {
      if (!alive || raf) return;
      last = performance.now();
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
  }, [audioLevelRef, shellRef]);

  return (
    <div
      ref={rootRef}
      className="chief-scene-layers"
      data-pace={motion.pace}
      data-phase={scenePhase}
      data-state={assistantState}
      data-status={status}
      data-tone={statusTone}
      data-motion={reducedMotion ? "off" : "on"}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="chief-scene-canvas" />
      {CALLOUTS.map(([id, label, className]) => (
        <div
          key={id}
          className={
            calloutLive(motion.activity, id)
              ? `chief-callout is-live ${className}`
              : `chief-callout ${className}`
          }
        >
          <span>{label}</span>
          <i />
        </div>
      ))}
    </div>
  );
}
