import ApexClock from "../../third_party/apex-ui/ApexClock.jsx";
import ApexWorld from "../../third_party/apex-ui/ApexWorld.jsx";

// Public entry rooms reuse the CHIEF scene. CHIEF's own home keeps calling
// ApexWorld directly so this wrapper cannot change that screen.
const ENTRY_ROSTER = Object.freeze([]);

export function ChiefAtmosphere({
  orbState = "idle",
  webState = "standby",
  roster = ENTRY_ROSTER,
  showClock = true,
  showLabels = false,
  showStatus = true,
  statusHint = false,
  webLabel = "Freedom OS",
}) {
  return (
    <>
      {showClock ? <ApexClock /> : null}
      <ApexWorld
        orbState={orbState}
        webState={webState}
        roster={roster}
        showLabels={showLabels}
        showStatus={showStatus}
        statusHint={statusHint}
        webLabel={webLabel}
      />
    </>
  );
}
