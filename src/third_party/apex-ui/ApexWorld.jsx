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

export default function ApexWorld({ orbState = "idle", webState = "standby", roster = null, onSelect = null, onCoreTap = null, audioLevelRef = null, caption = "" }) {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const nodes = Array.isArray(roster) ? roster : [];

  return (
    <div className="apex-ui-root" style={{ position: "absolute", inset: 0, overflow: "hidden", userSelect: "none" }}>
      <div aria-hidden="true" style={{
        position: "absolute", inset: 0,
        background: "radial-gradient(ellipse 95% 88% at 50% 42%, #122c43 0%, #0c1d30 38%, #07111f 72%, #050b14 100%)",
      }} />

      {!reduced && (
        <div aria-hidden="true" style={{ position: "absolute", inset: 0, zIndex: 0 }}>
          <ShaderBackground opacity={0.12} voiceActive={orbState === "speaking"} gold={false} />
        </div>
      )}

      <div aria-hidden="true" style={{
        position: "absolute", inset: 0, zIndex: 1, pointerEvents: "none", mixBlendMode: "screen",
        background: `radial-gradient(circle at 50% 42%, rgba(13,210,255,${orbState === "speaking" ? 0.30 : 0.18}) 0%, rgba(13,170,228,0.08) 30%, rgba(8,17,31,0) 62%)`,
        transition: "background 0.6s ease",
      }} />

      <div aria-hidden="true" style={{ position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none" }}>
        <ReasoningWeb
          state={webState}
          mode="full"
          coreless
          roster={roster}
          onSelect={onSelect}
        />
      </div>

      {nodes.length > 0 ? (
        <nav className="visually-hidden" aria-label="CHIEF">
          <ul>
            {nodes.map((node) => (
              <li key={node[0]}>
                <button type="button" onClick={() => onSelect?.({ key: node[0], name: node[1], color: "#00e5ff" })}>
                  {node[1]}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      <div className="apex-core-anchor">
        <ApexHeroOrb state={orbState} interactive={false} audioLevelRef={audioLevelRef} />
        <div
          role="button"
          tabIndex={0}
          aria-label="CHIEF voice"
          onClick={() => onCoreTap?.()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onCoreTap?.();
            }
          }}
          onMouseDown={(event) => event.preventDefault()}
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: "min(340px, 36vw)",
            height: "min(340px, 36vw)",
            borderRadius: "50%",
            zIndex: 4,
            cursor: "pointer",
            background: "transparent",
            border: "none",
            userSelect: "none",
            pointerEvents: "auto",
          }}
        />
        <div className="apex-core-status">
          <OrbStatusBar state={orbState} />
          {caption ? <p className="chief-voice-caption chief-voice-caption--inline">{caption}</p> : null}
        </div>
      </div>
    </div>
  );
}
