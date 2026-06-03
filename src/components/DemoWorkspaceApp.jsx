import { useMemo } from "react";
import ForwardFreedomDashboard from "../ForwardFreedomDashboard.jsx";
import { createDemoAppState } from "../utils/appState.js";

export function DemoWorkspaceApp({ onExit }) {
  const demoState = useMemo(() => createDemoAppState(), []);
  const sessionControls = useMemo(
    () => ({
      isDemoMode: true,
      workspaceStatus: "Demo sandbox — changes are not saved",
      notice: "Explore with sample accounts, budgets, and transactions. Sign in to save your own workspace.",
      onSignOut: onExit,
      isBusy: false,
    }),
    [onExit]
  );

  return (
    <ForwardFreedomDashboard
      initialView="app"
      initialAppStateOverride={demoState}
      persistLocally={false}
      sessionControls={sessionControls}
      isDemoMode
      onExitDemo={onExit}
    />
  );
}
