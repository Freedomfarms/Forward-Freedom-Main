import { useEffect, useRef, useState } from "react";
import { LegalModal } from "../LegalDocuments.jsx";
import { createChiefIntroRenderer } from "../../visual/chiefIntro/chiefIntroRenderer.js";
import {
  hasChiefIntroPlayed,
  markChiefIntroPlayed,
} from "../../visual/chiefIntro/chiefIntroSession.js";
import "../../visual/chiefIntro/chief-intro.css";

// The approved CHIEF Draft 4 cinematic as the public Freedom OS homepage:
// Draft 1 choreography, lightning-blue palette, Draft 2 sphere, six capability
// panels with staggered entrances that remain visible, at the 6 second pace,
// with Skip and reduced-motion support.
//
// Adaptations from the prototype, per the public-page scope:
// - The demo conversation composer became the sign-in / create-account entry
//   (the prototype's was presentation-only and not connected to CHIEF).
// - Capability panels open concise explanatory dialogs describing capability
//   categories; nothing implies live data, tools, memories, or agents for a
//   signed-out visitor, and no protected endpoint is called.
// - Sign-in stays on the bottom dock, so the intro never blocks authentication.

const CAPABILITIES = [
  {
    code: "COGNITION / 01",
    symbol: "\u25C7",
    title: "REASONING",
    blurb: "Clarity from complexity.",
    detail:
      "Explore questions, weigh information, and turn complexity into a useful answer. Reasoning happens inside your own CHIEF conversation after you sign in.",
  },
  {
    code: "CONTEXT / 02",
    symbol: "\u22EE",
    title: "MEMORY",
    blurb: "Context that stays with you.",
    detail:
      "Context that follows your conversations instead of starting over. Memories belong to your account; nothing personal is shown or stored on this public page.",
  },
  {
    code: "DISCOVERY / 03",
    symbol: "\u2315",
    title: "KNOWLEDGE",
    blurb: "The information you permit.",
    detail:
      "A home for the information you permit. What CHIEF can reach depends entirely on the sources and permissions you enable inside Freedom OS.",
  },
  {
    code: "AWARENESS / 04",
    symbol: "\u2318",
    title: "SYSTEM INTELLIGENCE",
    blurb: "Your OS, understood.",
    detail:
      "An understanding of Freedom OS modules and how they fit together. This panel describes a capability category, not a live diagnostic of any system.",
  },
  {
    code: "ACTION / 05",
    symbol: "\u2197",
    title: "EXECUTION",
    blurb: "Tools. Permissions. Control.",
    detail:
      "Tools and actions that run only with your explicit approval. No tools are connected and nothing executes from this public page.",
  },
  {
    code: "PRESENCE / 06",
    symbol: "\u25CC",
    title: "LIVE STATUS",
    blurb: "Conversation state, in view.",
    detail:
      "Where a real conversation's state lives \u2014 listening, thinking, responding, or idle. It becomes live once you sign in and start talking to CHIEF.",
  },
];

export function ChiefIntroHome({ onSignIn, onCreateAccount, onExploreFreedomFinancial }) {
  const rootRef = useRef(null);
  const controllerRef = useRef(null);
  const detailCloseRef = useRef(null);
  const detailTriggerRef = useRef(null);
  const [activeCapability, setActiveCapability] = useState(null);
  const [activeDocument, setActiveDocument] = useState(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const controller = createChiefIntroRenderer(root, {
      startSettled: hasChiefIntroPlayed(),
      onReady: markChiefIntroPlayed,
    });
    if (!controller) return undefined;
    controllerRef.current = controller;
    return () => {
      // Navigating away mid-intro (e.g. homepage -> login) counts as played
      // so the next public screen does not restart it. A React Strict Mode
      // remount destroys within milliseconds and does not mark it.
      if (controller.inspect().elapsed > 600) markChiefIntroPlayed();
      controller.destroy();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (activeCapability !== null) detailCloseRef.current?.focus();
  }, [activeCapability]);

  const openCapability = (index, event) => {
    detailTriggerRef.current = event.currentTarget;
    setActiveCapability(index);
  };

  const closeCapability = () => {
    setActiveCapability(null);
    detailTriggerRef.current?.focus();
    detailTriggerRef.current = null;
  };

  const handleDetailKeyDown = (event) => {
    if (activeCapability === null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeCapability();
    } else if (event.key === "Tab") {
      event.preventDefault();
      detailCloseRef.current?.focus();
    }
  };

  const detailOpen = activeCapability !== null;
  const capability = detailOpen ? CAPABILITIES[activeCapability] : null;

  return (
    <>
      <div className="fc-page">
        <div ref={rootRef} className="fc-root" onKeyDown={handleDetailKeyDown}>
          <div className="fc-stage" inert={detailOpen || undefined}>
            <canvas className="fc-canvas" aria-hidden="true" />
            <h1 className="fc-wordmark">FREEDOM OS</h1>
            <p className="fc-kicker">PERSONAL INTELLIGENCE SYSTEM</p>
            <button
              type="button"
              className="fc-control fc-skip"
              onClick={() => {
                controllerRef.current?.skip();
                markChiefIntroPlayed();
              }}
            >
              Skip
            </button>
            {CAPABILITIES.map((item, index) => (
              <button
                key={item.title}
                type="button"
                className="fc-panel"
                data-side={index % 2 === 0 ? "left" : "right"}
                data-row={String(Math.floor(index / 2))}
                aria-haspopup="dialog"
                onClick={(event) => openCapability(index, event)}
              >
                <span className="fc-panel-top">
                  <span>{item.code}</span>
                  <span className="fc-symbol" aria-hidden="true">
                    {item.symbol}
                  </span>
                </span>
                <h3>{item.title}</h3>
                <p>{item.blurb}</p>
              </button>
            ))}
            <div className="fc-center-label" aria-hidden="true">
              <strong>CHIEF</strong>
              <small>YOUR SECOND MIND</small>
            </div>
            <div className="fc-phase">
              <span className="fc-phase-dot" aria-hidden="true" />
              <span className="fc-phase-text">AWAKENING</span>
            </div>
            <div className="fc-progress" aria-hidden="true">
              <i />
            </div>
          </div>

          <div className="fc-dock">
            <div className="fc-input-wrap">
              <button type="button" className="fc-cta" onClick={onSignIn}>
                Enter Freedom OS
              </button>
              <button type="button" className="fc-cta fc-cta--quiet" onClick={onCreateAccount}>
                Create Account
              </button>
            </div>
            <div className="fc-dock-meta">
              <span>CHIEF &mdash; PERSONAL INTELLIGENCE SYSTEM</span>
              <span>Sign in to start your own conversation.</span>
            </div>
          </div>

          <footer className="fc-footer" inert={detailOpen || undefined}>
            <span>FREEDOM TO THINK BIGGER.</span>
            <span className="fc-footer-links">
              {typeof onExploreFreedomFinancial === "function" ? (
                <button
                  type="button"
                  className="fc-footer-link"
                  onClick={onExploreFreedomFinancial}
                >
                  Freedom Financial
                </button>
              ) : null}
              <button
                type="button"
                className="fc-footer-link"
                onClick={() => setActiveDocument("terms")}
              >
                Terms of Service
              </button>
              <button
                type="button"
                className="fc-footer-link"
                onClick={() => setActiveDocument("privacy")}
              >
                Privacy Policy
              </button>
            </span>
          </footer>

          {detailOpen ? (
            <>
              <div className="fc-scrim" onClick={closeCapability} aria-hidden="true" />
              <div
                className="fc-detail"
                role="dialog"
                aria-modal="true"
                aria-labelledby="fc-detail-title"
              >
                <button
                  type="button"
                  className="fc-detail-close"
                  aria-label="Close capability details"
                  ref={detailCloseRef}
                  onClick={closeCapability}
                >
                  &times;
                </button>
                <small>CHIEF CAPABILITY &mdash; AVAILABLE AFTER SIGN-IN</small>
                <h2 id="fc-detail-title">{capability.title}</h2>
                <p>{capability.detail}</p>
              </div>
            </>
          ) : null}
        </div>
      </div>
      <LegalModal activeDocument={activeDocument} closeDocument={() => setActiveDocument(null)} />
    </>
  );
}
