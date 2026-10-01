import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { LegalModal } from "../LegalDocuments.jsx";
import { EntryField } from "./EntryField.jsx";
import {
  entryDurationMs,
  entryPresentation,
  markEntrySeen,
  readEntrySeen,
} from "./entryTimeline.js";
import "./entry.css";

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

function applyScene(root, scene, view) {
  const hover = scene.hover;
  const pulse = scene.pulse;
  Object.assign(scene, view, { hover, pulse });
  if (!root) return;
  root.style.setProperty("--mf-reveal", String(view.wordmark));
  root.style.setProperty("--mf-command", String(view.command));
  root.dataset.phase = view.phase;
  root.classList.toggle("is-ready", view.interactive);
  const command = root.querySelector(".mf-command");
  if (!command) return;
  if (view.interactive) command.removeAttribute("inert");
  else command.setAttribute("inert", "");
}

export function MadFuturicsGateway({
  variant = "home",
  children = null,
  onEnter,
  onCreateAccount,
  onExploreFinance,
  message = "",
  progress = null,
}) {
  const reduced = useReducedMotion();
  const boot = variant === "boot";
  const [returning] = useState(() => (variant === "home" ? readEntrySeen(safeStorage()) : false));
  const abbreviated = variant !== "home" || returning;
  const rootRef = useRef(null);
  const sceneRef = useRef({
    ...entryPresentation({
      elapsedMs: boot ? 5000 : 0,
      reducedMotion: boot ? false : reduced,
      abbreviated: boot ? false : abbreviated,
    }),
    surge: boot,
    hover: false,
    pulse: 0,
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    const scene = sceneRef.current;
    if (boot) {
      const view = entryPresentation({ elapsedMs: 5000, reducedMotion: false, abbreviated: false });
      applyScene(root, scene, { ...view, surge: true });
      return undefined;
    }

    const duration = entryDurationMs({ reducedMotion: reduced, abbreviated });
    const started = performance.now();
    let frame = 0;
    let stopped = false;

    const tick = (now) => {
      if (stopped) return;
      const elapsed = now - started;
      const view = entryPresentation({
        elapsedMs: elapsed,
        reducedMotion: reduced,
        abbreviated,
      });
      applyScene(root, scene, { ...view, surge: false });
      if (elapsed < duration) {
        frame = requestAnimationFrame(tick);
        return;
      }
      if (variant === "home" && !abbreviated && !reduced) markEntrySeen(safeStorage());
    };

    frame = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
    };
  }, [abbreviated, boot, reduced, variant]);

  const [activeDocument, setActiveDocument] = useState(null);

  return (
    <div
      ref={rootRef}
      className={boot ? "mf-gateway is-ready" : "mf-gateway"}
      data-variant={variant}
    >
      <EntryField sceneRef={sceneRef} />
      <div className="mf-stage">
        <header className="mf-brand">
          <h1 className="mf-wordmark">FREEDOM OS</h1>
        </header>
        <button
          type="button"
          className="mf-core"
          aria-label="Freedom Diamond"
          onMouseEnter={() => {
            sceneRef.current.hover = true;
          }}
          onMouseLeave={() => {
            sceneRef.current.hover = false;
          }}
          onFocus={() => {
            sceneRef.current.hover = true;
          }}
          onBlur={() => {
            sceneRef.current.hover = false;
          }}
          onClick={() => {
            sceneRef.current.pulse = 1;
          }}
        />
        <div className="mf-command">
          {boot ? (
            <div className="mf-boot-status" role="status" aria-live="polite">
              <div className="mf-meter" aria-hidden="true">
                <span style={{ width: `${Math.max(0, Math.min(100, Number(progress) || 0))}%` }} />
              </div>
              <p className="mf-boot-message">{message}</p>
            </div>
          ) : null}
          {variant === "home" ? (
            <div className="mf-command-stack">
              <button type="button" className="mf-enter" onClick={onEnter}>
                ENTER THE SYSTEM
              </button>
              <button type="button" className="mf-quiet" onClick={onCreateAccount}>
                Create account
              </button>
            </div>
          ) : null}
          {variant === "login" || variant === "signup" ? children : null}
        </div>
        {boot ? (
          <div />
        ) : (
          <footer className="mf-footer">
            <div>Freedom OS</div>
            <div className="mf-footer-links">
              {typeof onExploreFinance === "function" ? (
                <button type="button" className="mf-quiet" onClick={onExploreFinance}>
                  Freedom Financial
                </button>
              ) : null}
              <button type="button" className="mf-quiet" onClick={() => setActiveDocument("terms")}>
                Terms
              </button>
              <button
                type="button"
                className="mf-quiet"
                onClick={() => setActiveDocument("privacy")}
              >
                Privacy
              </button>
            </div>
          </footer>
        )}
      </div>
      {boot ? null : (
        <LegalModal activeDocument={activeDocument} closeDocument={() => setActiveDocument(null)} />
      )}
    </div>
  );
}

export function MadFuturicsBoot({ message, progress }) {
  return <MadFuturicsGateway variant="boot" message={message} progress={progress} />;
}
