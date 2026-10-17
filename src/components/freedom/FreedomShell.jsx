import { Component, lazy, Suspense } from "react";
import "./freedom.css";

// The CHIEF Draft 4 scene as the public-entry backdrop. One full-bleed slot,
// one 2D canvas, one animation loop. The loading shell passes showCore={false}
// so a route transition cannot mount a second scene. The authenticated CHIEF
// conversation keeps its own separate renderer untouched.
const ChiefIntroBackdrop = lazy(() =>
  import("../../visual/chiefIntro/ChiefIntroBackdrop.jsx").then((module) => ({
    default: module.ChiefIntroBackdrop,
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

export function FreedomShell({ children, variant = "entry", showCore = true }) {
  const className = variant === "auth" ? "freedom-shell freedom-shell--auth" : "freedom-shell";

  // Reduced motion is handled inside the renderer: it settles the scene on a
  // single static frame instead of unmounting, so reduced-motion visitors
  // still get the finished composition behind the entry controls.
  return (
    <section className={className} aria-label="Freedom OS">
      {showCore ? (
        <CoreBoundary>
          <div className="freedom-core-slot">
            <Suspense fallback={null}>
              <ChiefIntroBackdrop />
            </Suspense>
          </div>
        </CoreBoundary>
      ) : null}
      {children}
    </section>
  );
}
