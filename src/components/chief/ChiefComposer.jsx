export function ChiefComposer({
  value,
  onChange,
  onSubmit,
  onVoice,
  voiceActive = false,
  enterToSend = true,
  disabled = false,
  placeholder = "Ask CHIEF anything...",
  inputRef = null,
}) {
  return (
    <form
      className="chief-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) onSubmit();
      }}
    >
      <button
        type="button"
        className={voiceActive ? "chief-mic is-live" : "chief-mic"}
        aria-label="CHIEF voice"
        aria-pressed={voiceActive}
        title="Tap to talk"
        onClick={onVoice}
      >
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="6" y="1.5" width="4" height="8" rx="2" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M3.5 7.5a4.5 4.5 0 0 0 9 0"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <path d="M8 12v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      <label htmlFor="chief-composer" className="chief-sr">
        Message CHIEF
      </label>
      <textarea
        id="chief-composer"
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        onKeyDown={(event) => {
          if (!enterToSend) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!disabled) onSubmit();
          }
        }}
      />
      <button type="submit" className="chief-action" disabled={disabled || !value.trim()}>
        Send
      </button>
    </form>
  );
}
