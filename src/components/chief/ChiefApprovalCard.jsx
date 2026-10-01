export function ChiefApprovalCard({ disabled = false, onApprove, onDeny }) {
  return (
    <div className="chief-approval" role="group" aria-label="CHIEF needs your approval">
      <button type="button" className="chief-action" disabled={disabled} onClick={onApprove}>
        Allow
      </button>
      <button
        type="button"
        className="chief-action chief-action--quiet"
        disabled={disabled}
        onClick={onDeny}
      >
        Don’t allow
      </button>
    </div>
  );
}
