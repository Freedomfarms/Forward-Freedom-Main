import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChiefWorldScene } from "./ChiefWorldScene.jsx";
import {
  activityForStatus,
  railsForRoster,
  resolveEntities,
  resolveWorldMotion,
  worldPhase,
} from "./chiefWorldPhase.js";
import "./chiefWorld.css";

const PHASE_WORD = Object.freeze({
  listening: "Listening",
  thinking: "Thinking",
});

class WorldBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <WorldFallback />;
    return this.props.children;
  }
}

function prefersReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function supportsWorldWebGL() {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function WorldFallback() {
  return (
    <div className="chief-world-fallback" aria-hidden="true">
      <div className="chief-world-fallback-far" />
      <div className="chief-world-fallback-mid" />
      <div className="chief-world-fallback-near" />
    </div>
  );
}

function WorldClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return (
    <div className="chief-world-clock">
      <time dateTime={now.toISOString()}>{time}</time>
      <span>{date}</span>
    </div>
  );
}

function Rail({ side, items, showLabels, onSelect, children }) {
  if (!items.length && !children) return null;
  return (
    <nav className={`chief-world-rail chief-world-rail--${side}`} aria-label="CHIEF">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onSelect?.({ key: item.key, name: item.name })}
        >
          {showLabels ? item.name : <span className="chief-sr">{item.name}</span>}
        </button>
      ))}
      {children}
    </nav>
  );
}

export function ChiefWorld({
  status,
  listening = false,
  speaking = false,
  entities = null,
  roster = null,
  onSelect = null,
  onCoreTap = null,
  coreListening = false,
  audioLevelRef = null,
  caption = "",
  motionPreference = "system",
  animationIntensity = "full",
  showLabels = true,
  showChrome = true,
}) {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [webgl] = useState(supportsWorldWebGL);
  const phaseRef = useRef("idle");
  const entitiesRef = useRef([]);
  const levelRef = useRef(audioLevelRef);
  const motionRef = useRef("full");
  const parallaxRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(media.matches);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  const phase = worldPhase({ status, listening, speaking });
  const activity = activityForStatus(status);
  const resolvedEntities = resolveEntities(activity, entities);
  const rails = useMemo(() => railsForRoster(roster), [roster]);
  const motion = resolveWorldMotion(motionPreference, animationIntensity, reduced);

  useLayoutEffect(() => {
    phaseRef.current = phase;
    entitiesRef.current = resolvedEntities;
    levelRef.current = audioLevelRef;
    motionRef.current = motion;
  }, [audioLevelRef, motion, phase, resolvedEntities]);

  function moveParallax(event) {
    if (motion === "off") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    parallaxRef.current.x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
    parallaxRef.current.y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
  }

  const activityLine = phase === "working" && activity?.label ? activity.label : "";
  const phaseWord = activityLine ? "" : PHASE_WORD[phase] || "";

  return (
    <div
      className="chief-world"
      data-phase={phase}
      onPointerMove={moveParallax}
      onPointerLeave={() => {
        parallaxRef.current.x = 0;
        parallaxRef.current.y = 0;
      }}
    >
      {webgl ? (
        <div className="chief-world-scene" aria-hidden="true">
          <WorldBoundary>
            <ChiefWorldScene
              phaseRef={phaseRef}
              entitiesRef={entitiesRef}
              levelRef={levelRef}
              motionRef={motionRef}
              parallaxRef={parallaxRef}
            />
          </WorldBoundary>
        </div>
      ) : (
        <WorldFallback />
      )}
      <div className="chief-world-vignette" aria-hidden="true" />
      {showChrome ? <WorldClock /> : null}
      {showChrome && phaseWord ? (
        <p className="chief-world-phase" aria-hidden="true">
          {phaseWord}
        </p>
      ) : null}
      {showChrome ? (
        <Rail side="left" items={rails.left} showLabels={showLabels} onSelect={onSelect}>
          {onCoreTap ? (
            <button
              type="button"
              className="chief-world-speak"
              aria-label={coreListening ? "Stop listening" : "Speak to CHIEF"}
              aria-pressed={coreListening}
              onClick={onCoreTap}
            >
              {coreListening ? "Listening" : "Speak"}
            </button>
          ) : null}
        </Rail>
      ) : null}
      {showChrome ? (
        <Rail side="right" items={rails.right} showLabels={showLabels} onSelect={onSelect}>
          {activityLine && showLabels ? (
            <p className="chief-world-activity">{activityLine}</p>
          ) : null}
        </Rail>
      ) : null}
      {showChrome && caption ? <p className="chief-world-caption">{caption}</p> : null}
    </div>
  );
}
