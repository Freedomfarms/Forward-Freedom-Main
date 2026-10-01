export function ChiefStatus({ status = "Ready", detail = "" }) {
  const text = detail || status;
  const tone =
    detail || status === "Error"
      ? "chief-state chief-state--error"
      : status === "Waiting for approval"
        ? "chief-state chief-state--wait"
        : "chief-state";
  return (
    <span className={tone} role="status">
      {text}
    </span>
  );
}
