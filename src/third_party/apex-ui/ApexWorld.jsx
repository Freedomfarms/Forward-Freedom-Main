"use client";

/**
 * ApexWorld composition from APEX-UI (commit a8732fad).
 * Backdrop, shader, reasoning web, hero orb, and status bar are unchanged.
 * The site tap-cycle and agent overview card are not used: orb/web state and
 * node selection are props so CHIEF can drive them.
 */

import { useEffect, useState } from "react";
import ApexHeroOrb from "./ApexHeroOrb";
import ReasoningWeb from "./ReasoningWeb";
import ShaderBackground from "./ShaderBackground";
import OrbStatusBar from "./OrbStatusBar";
import "./apex-ui.css";

export default function ApexWorld({
  orbState = "idle",
  webState = "standby",
  roster = null,
  onSelect = null,
  onCoreActivate = null,
  coreListening = false,
  audioLevelRef = null,
  motionPreference = "system",
  animationIntensity = "full",
  showLabels = true,
  showStatus = true,
  statusHint,
  webLabel,
}) {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const nodes = Array.isArray(roster) ? roster : [];
  const motionOff =
    animationIntensity === "off" ||
    motionPreference === "reduce" ||
    (motionPreference === "system" && reduced);
  const resolvedMotion = motionOff ? "off" : animationIntensity === "low" ? "low" : "full";

  return (
    <div
      className="apex-ui-root"
      style={{ position: "absolute", inset: 0, overflow: "hidden", userSelect: "none" }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 95% 88% at 50% 42%, #122c43 0%, #0c1d30 38%, #07111f 72%, #050b14 100%)",
        }}
      />

      {resolvedMotion !== "off" && (
        <div aria-hidden="true" style={{ position: "absolute", inset: 0, zIndex: 0 }}>
          <ShaderBackground
            opacity={resolvedMotion === "low" ? 0.04 : 0.12}
            voiceActive={orbState === "speaking"}
            gold={false}
          />
        </div>
      )}

      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1,
          pointerEvents: "none",
          mixBlendMode: "screen",
          background: `radial-gradient(circle at 50% 42%, rgba(13,210,255,${orbState === "speaking" ? 0.3 : 0.18}) 0%, rgba(13,170,228,0.08) 30%, rgba(8,17,31,0) 62%)`,
          transition: "background 0.6s ease",
        }}
      />

      <div
        aria-hidden="true"
        style={{ position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none" }}
      >
        <ReasoningWeb
          state={webState}
          mode="full"
          coreless
          roster={roster}
          onSelect={onSelect}
          showLabels={showLabels}
          motion={resolvedMotion}
          label={webLabel}
        />
      </div>

      {nodes.length > 0 ? (
        <nav className="visually-hidden" aria-label="CHIEF">
          <ul>
            {nodes.map((node) => (
              <li key={node[0]}>
                <button
                  type="button"
                  onClick={() => onSelect?.({ key: node[0], name: node[1], color: "#00e5ff" })}
                >
                  {node[1]}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "var(--freedom-core-y, 50%)",
          width: "min(560px, 58vw)",
          height: "min(500px, 56vw, 70vh)",
          transform: "translate(-50%, -50%)",
          zIndex: 3,
          pointerEvents: "none",
        }}
      >
        <ApexHeroOrb
          state={orbState}
          interactive={false}
          audioLevelRef={audioLevelRef}
          staticCore={resolvedMotion === "off"}
        />
      </div>

      {onCoreActivate ? (
        <button
          type="button"
          className="chief-core-hit"
          aria-label={coreListening ? "Stop listening" : "Speak to CHIEF"}
          aria-pressed={coreListening}
          onClick={onCoreActivate}
          style={{
            position: "absolute",
            left: "50%",
            top: "var(--freedom-core-y, 50%)",
            width: "min(240px, 32vw)",
            height: "min(240px, 32vw)",
            transform: "translate(-50%, -50%)",
            zIndex: 4,
            border: 0,
            borderRadius: "50%",
            background: "transparent",
            cursor: "pointer",
            pointerEvents: "auto",
          }}
        />
      ) : null}

      {showStatus ? <OrbStatusBar state={orbState} hint={statusHint} /> : null}
    </div>
  );
}
