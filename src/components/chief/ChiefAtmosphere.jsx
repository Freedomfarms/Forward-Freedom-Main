import { Component, lazy, Suspense } from "react";
import { CHIEF_STATUS } from "../../utils/chiefProtocol.js";

// Public homepage and login backdrop only. The signed-in CHIEF room mounts
// the same world with its own chrome. This file must not mount the old core.
const ChiefWorld = lazy(() =>
  import("../../visual/chiefWorld/ChiefWorld.jsx").then((mod) => ({ default: mod.ChiefWorld }))
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
    if (this.state.failed) return <div className="chief-core-boot" aria-hidden="true" />;
    return this.props.children;
  }
}

function backdropForOrb(orbState) {
  if (orbState === "listening") return { listening: true, status: CHIEF_STATUS.READY };
  if (orbState === "thinking" || orbState === "processing") {
    return { status: CHIEF_STATUS.WORKING };
  }
  if (orbState === "speaking" || orbState === "responding") {
    return { speaking: true, status: CHIEF_STATUS.RESPONDING };
  }
  return { status: CHIEF_STATUS.READY };
}

export function ChiefAtmosphere({ orbState = "idle" }) {
  return (
    <CoreBoundary>
      <Suspense fallback={<div className="chief-core-boot" aria-hidden="true" />}>
        <ChiefWorld showChrome={false} {...backdropForOrb(orbState)} />
      </Suspense>
    </CoreBoundary>
  );
}
