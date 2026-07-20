import { fosStyles } from "./freedomOsShared.js";

// Display-only trust ladder. All four levels exist in the schema, but the
// runtime only honors read-only in this release — steps 3–4 are locked and
// no upgrade action exists in the UI (v1 contract).

const TRUST_STEPS = [
  {
    level: "READ_ONLY",
    label: "Read-only",
    description: "Reads the data it is allowed to see and reports back. Nothing else.",
  },
  {
    level: "DRAFT_ONLY",
    label: "Draft-only",
    description: "Can prepare drafts for you to review. Never sends or executes.",
  },
  {
    level: "ACTION_REQUIRED_APPROVAL",
    label: "Approval required",
    description: "Proposes actions that only run after you explicitly approve each one.",
  },
  {
    level: "AUTONOMOUS",
    label: "Autonomous",
    description: "Acts on its own within the boundaries you set.",
  },
];

const LOCKED_COPY =
  "Review this agent's outputs over time. Higher trust levels unlock in a future release.";

export function TrustLadder({ permissionLevel = "READ_ONLY" }) {
  const currentIndex = Math.max(
    TRUST_STEPS.findIndex((step) => step.level === permissionLevel),
    0
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={fosStyles.sectionLabel}>Trust ladder</div>
      <div style={{ display: "grid", gap: 8 }}>
        {TRUST_STEPS.map((step, index) => {
          const isCurrent = index === currentIndex;
          const isLocked = index >= 2;
          return (
            <div
              key={step.level}
              aria-current={isCurrent ? "step" : undefined}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
                borderRadius: 12,
                padding: "12px 14px",
                border: isCurrent
                  ? "1px solid rgba(0,216,255,.45)"
                  : "1px solid rgba(30,144,255,.16)",
                background: isCurrent
                  ? "linear-gradient(90deg, rgba(0,119,255,.16), rgba(0,216,255,.08))"
                  : "rgba(3,17,32,.6)",
                opacity: isLocked && !isCurrent ? 0.6 : 1,
              }}
            >
              <div
                style={{
                  width: 26,
                  height: 26,
                  flexShrink: 0,
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  fontSize: 12,
                  fontWeight: 900,
                  color: isCurrent ? "#04121f" : "#8feaff",
                  background: isCurrent ? "linear-gradient(90deg,#0077ff,#00d8ff)" : "rgba(0,136,255,.10)",
                  border: isCurrent ? "none" : "1px solid rgba(0,216,255,.22)",
                }}
              >
                {isLocked ? "🔒" : index + 1}
              </div>
              <div>
                <div style={{ color: isCurrent ? "white" : "#cfe6ff", fontWeight: 800, fontSize: 13 }}>
                  {step.label}
                  {isCurrent ? (
                    <span style={{ color: "#8feaff", fontWeight: 700, marginLeft: 8, fontSize: 11 }}>
                      Current level
                    </span>
                  ) : null}
                </div>
                <div style={{ color: "#9fb0c9", fontSize: 12, lineHeight: 1.55, marginTop: 4 }}>
                  {step.description}
                </div>
                {isLocked ? (
                  <div style={{ color: "#8faecc", fontSize: 11, lineHeight: 1.5, marginTop: 6, fontStyle: "italic" }}>
                    {LOCKED_COPY}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
