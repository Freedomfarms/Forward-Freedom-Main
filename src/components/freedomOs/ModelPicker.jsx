import { AGENT_MODEL_OPTIONS } from "./freedomOsShared.js";

/**
 * Shared Haiku / Sonnet / Opus picker for CEO settings, onboarding, and
 * sub-agent detail. Labels stay capability-focused (no billing copy).
 */
export function ModelPicker({
  value,
  onChange,
  disabled = false,
  name = "model",
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Claude model"
      style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}
    >
      {AGENT_MODEL_OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            name={name}
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange?.(option.value)}
            style={{
              textAlign: "left",
              borderRadius: 12,
              padding: "14px 16px",
              cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.6 : 1,
              border: selected
                ? "1px solid rgba(120,220,255,.6)"
                : "1px solid rgba(0,216,255,.16)",
              background: selected
                ? "linear-gradient(180deg, rgba(0,119,255,.24), rgba(0,216,255,.10))"
                : "rgba(0,136,255,.05)",
              color: "#eef6ff",
            }}
          >
            <div style={{ fontWeight: 800, fontSize: 13 }}>{option.label}</div>
            <div style={{ color: "#9fb0c9", fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
              {option.description}
            </div>
          </button>
        );
      })}
    </div>
  );
}
