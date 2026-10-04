import { useEffect } from "react";

function resize(node) {
  if (!node) return;
  node.style.height = "auto";
  node.style.height = `${Math.min(node.scrollHeight, 120)}px`;
}

export function ChiefComposer({
  value,
  onChange,
  onSubmit,
  onMicrophone,
  listening = false,
  disabled = false,
  placeholder = "Ask CHIEF anything...",
  inputRef = null,
}) {
  useEffect(() => {
    if (inputRef && typeof inputRef === "object") resize(inputRef.current);
  }, [value, inputRef]);

  return (
    <form
      className="chief-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) onSubmit();
      }}
    >
      <label htmlFor="chief-composer" className="chief-sr">
        Message CHIEF
      </label>
      <textarea
        id="chief-composer"
        ref={inputRef}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          resize(event.target);
        }}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!disabled) onSubmit();
          }
        }}
      />
      <button
        type="button"
        className={listening ? "chief-mic is-listening" : "chief-mic"}
        disabled={disabled}
        aria-pressed={listening}
        aria-label={listening ? "Stop listening" : "Speak to CHIEF"}
        title={listening ? "Stop listening" : "Speak to CHIEF"}
        onClick={() => onMicrophone?.()}
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
      <button type="submit" className="chief-action" disabled={disabled || !value.trim()}>
        Send
      </button>
    </form>
  );
}
