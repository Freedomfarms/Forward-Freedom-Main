export function ChiefApprovalCard({ disabled = false, onApprove, onDeny }) {
  return (
    <div
      style={{
        borderRadius: 14,
        border: "1px solid rgba(255,211,138,.4)",
        background: "rgba(61,34,0,.28)",
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      <div style={{ color: "#ffd38a", fontWeight: 800, fontSize: 15 }}>
        CHIEF needs your approval
      </div>
      <div style={{ color: "#e8d9c2", fontSize: 14, lineHeight: 1.5 }}>
        This action requires your approval before it can continue.
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button type="button" className="chief-action" disabled={disabled} onClick={onApprove}>
          Approve
        </button>
        <button
          type="button"
          className="chief-action chief-action--quiet"
          disabled={disabled}
          onClick={onDeny}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
