const CHIEF_RESPONSE_MODE_OPTIONS = Object.freeze([
  Object.freeze(["text", "Text"]),
  Object.freeze(["voice", "Voice"]),
  Object.freeze(["both", "Text + Voice"]),
]);

export function ChiefResponseMode({ mode = "both", onChange, disabled = false }) {
  return (
    <fieldset className="chief-response-mode" disabled={disabled}>
      <legend>Response mode</legend>
      <div className="chief-response-mode-options">
        {CHIEF_RESPONSE_MODE_OPTIONS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={mode === id ? "is-selected" : ""}
            aria-pressed={mode === id}
            onClick={() => {
              if (mode !== id) onChange?.(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
