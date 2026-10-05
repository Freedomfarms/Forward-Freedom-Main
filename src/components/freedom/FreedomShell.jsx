import { ChiefAtmosphere } from "../chief/ChiefAtmosphere.jsx";
import "./freedom.css";

export function FreedomShell({
  children,
  variant = "entry",
  orbState = "idle",
  webState = "standby",
  showClock = true,
  showStatus = true,
  statusHint = false,
}) {
  const className = variant === "auth" ? "freedom-shell freedom-shell--auth" : "freedom-shell";
  return (
    <section className={className} aria-label="Freedom OS">
      <ChiefAtmosphere
        orbState={orbState}
        webState={webState}
        showClock={showClock}
        showStatus={showStatus}
        statusHint={statusHint}
      />
      {children}
    </section>
  );
}
