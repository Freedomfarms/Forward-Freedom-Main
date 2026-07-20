import { fosStyles } from "./freedomOsShared.js";

// Static transparency card: what this agent CAN read, and what it will NEVER
// do. The "never" copy is fixed per agent type — it mirrors the server-side
// safety contract and is intentionally not configurable from the UI.

const CAN_ACCESS_BY_TYPE = {
  finance: ["Transaction aggregates and category totals", "Budget data and monthly targets"],
  research: ["The research topics you give it", "Provider-run web search (read-only)"],
  reminders: ["The reminders and schedules you configure"],
  email: ["Email drafting only (runtime not available yet)"],
};

const WILL_NEVER_DO_BY_TYPE = {
  finance: "Never moves money. Never gives buy/sell advice. Never contacts anyone.",
  research: "Never takes actions on your behalf. Never contacts anyone.",
  reminders: "Only notifies you. Never contacts third parties.",
  email: "Read and draft only. Never sends email without your explicit approval.",
};

const TOOL_ACCESS_LABELS = {
  email: "Email delivery — reminders may also be emailed to your own account address",
};

export function PermissionLedger({ agentType, toolAccess = null, permissionLevel = "READ_ONLY" }) {
  const canAccess = CAN_ACCESS_BY_TYPE[agentType] || ["Only the data you explicitly give it"];
  const willNeverDo =
    WILL_NEVER_DO_BY_TYPE[agentType] ||
    "Never takes actions on your behalf. Never contacts anyone.";
  const enabledTools = Object.entries(toolAccess || {})
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => TOOL_ACCESS_LABELS[key] || key);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={fosStyles.sectionLabel}>Permission ledger</div>
      <div style={{ display: "grid", gap: 12 }}>
        <div
          style={{
            borderRadius: 12,
            border: "1px solid rgba(0,216,255,.18)",
            background: "rgba(0,136,255,.05)",
            padding: "14px 16px",
          }}
        >
          <div style={{ color: "#8feaff", fontSize: 12, fontWeight: 900, marginBottom: 8 }}>
            Can access
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
            {canAccess.map((item) => (
              <li key={item} style={{ color: "#d7ebff", fontSize: 13, lineHeight: 1.5 }}>
                {item}
              </li>
            ))}
            {enabledTools.map((item) => (
              <li key={item} style={{ color: "#d7ebff", fontSize: 13, lineHeight: 1.5 }}>
                {item}
              </li>
            ))}
          </ul>
          <div style={{ color: "#8faecc", fontSize: 11, marginTop: 10 }}>
            Current permission level: {String(permissionLevel).replaceAll("_", " ").toLowerCase()}
          </div>
        </div>

        <div
          style={{
            borderRadius: 12,
            border: "1px solid rgba(255,93,122,.22)",
            background: "rgba(255,36,77,.05)",
            padding: "14px 16px",
          }}
        >
          <div style={{ color: "#ff8ba0", fontSize: 12, fontWeight: 900, marginBottom: 8 }}>
            Will never do
          </div>
          <div style={{ color: "#f4d7dd", fontSize: 13, lineHeight: 1.6 }}>{willNeverDo}</div>
        </div>
      </div>
    </div>
  );
}
