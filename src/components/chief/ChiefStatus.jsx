export function ChiefStatus({ status = "Ready" }) {
  const waiting = status === "Waiting for approval";
  const failed = status === "Error";
  const quiet = status === "Ready";
  const color = failed ? "#ff8f8f" : waiting ? "#ffd38a" : quiet ? "#8feaff" : "#7cf1af";
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 28 }}
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
          boxShadow: quiet ? "none" : `0 0 10px ${color}`,
          flexShrink: 0,
        }}
      />
      <span style={{ color, fontSize: 12, fontWeight: 800, letterSpacing: 0.4 }}>{status}</span>
    </div>
  );
}
