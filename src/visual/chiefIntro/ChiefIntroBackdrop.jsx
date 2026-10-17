import { useEffect, useRef } from "react";
import { createChiefIntroRenderer } from "./chiefIntroRenderer.js";
import { hasChiefIntroPlayed, markChiefIntroPlayed } from "./chiefIntroSession.js";
import "./chief-intro.css";

// The CHIEF Draft 4 scene as a full-bleed decorative backdrop for the login
// screen. Same renderer and palette as the public homepage, without the
// capability-panel composition, so the real authentication form stays primary.
// A direct visit to /login plays the intro once per browser-tab session; when
// the homepage already played it, the scene mounts settled. The host screen
// re-renders freely (typing, validation, busy states) without touching this
// component: the renderer is created once per mount and animation state never
// enters React.
export function ChiefIntroBackdrop() {
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const controller = createChiefIntroRenderer(root, {
      startSettled: hasChiefIntroPlayed(),
      onReady: markChiefIntroPlayed,
    });
    if (!controller) return undefined;
    return () => {
      // Leaving mid-intro (e.g. login -> homepage) still counts as played so
      // the next public screen does not restart it. A React Strict Mode
      // remount destroys within milliseconds and does not mark it.
      if (controller.inspect().elapsed > 600) markChiefIntroPlayed();
      controller.destroy();
    };
  }, []);

  return (
    <div ref={rootRef} className="fc-root fc-root--backdrop" aria-hidden="true">
      <div className="fc-stage">
        <canvas className="fc-canvas" />
        <div className="fc-center-label">
          <strong>CHIEF</strong>
          <small>YOUR SECOND MIND</small>
        </div>
      </div>
    </div>
  );
}
