import { Component, lazy, Suspense, useEffect, useState } from "react";
import "./freedom.css";

// The live CHIEF filament core. One full-bleed slot, same component the
// conversation face mounts. The loading shell passes showCore={false} so a
// route transition cannot open a second WebGL context.
const ChiefIntelligenceCore = lazy(() =>
  import("../../visual/chiefIntelligence/ChiefIntelligenceCore.jsx").then((module) => ({
    default: module.ChiefIntelligenceCore,
  }))
);

class CoreBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export function FreedomShell({ children, variant = "entry", orbState = "idle", showCore = true }) {
  const reducedMotion = usePrefersReducedMotion();
  const mountCore = showCore && !reducedMotion;
  const className = variant === "auth" ? "freedom-shell freedom-shell--auth" : "freedom-shell";

  return (
    <section className={className} aria-label="Freedom OS">
      {mountCore ? (
        <CoreBoundary>
          <div className="freedom-core-slot">
            <Suspense fallback={null}>
              <ChiefIntelligenceCore state={orbState} />
            </Suspense>
          </div>
        </CoreBoundary>
      ) : null}
      {children}
    </section>
  );
}
