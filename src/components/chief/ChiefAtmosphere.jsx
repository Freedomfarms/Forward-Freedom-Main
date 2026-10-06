import { Component, lazy, Suspense } from "react";

// Homepage and login only. The signed-in CHIEF room mounts ApexWorld from
// ChiefPage and must not import this sandbox.
const ChiefCore = lazy(() => import("../../visual/chiefCore/ChiefCore.jsx"));

class CoreBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <div className="chief-core-boot" aria-hidden="true" />;
    return this.props.children;
  }
}

export function ChiefAtmosphere({ orbState = "idle", layout = "home", preview = false }) {
  return (
    <CoreBoundary>
      <Suspense fallback={<div className="chief-core-boot" aria-hidden="true" />}>
        <ChiefCore state={orbState} layout={layout} preview={preview} />
      </Suspense>
    </CoreBoundary>
  );
}
