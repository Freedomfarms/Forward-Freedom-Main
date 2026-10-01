export function ChiefComposer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = "Ask CHIEF",
  inputRef = null,
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) onSubmit();
      }}
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-end",
        position: "relative",
        border: "1px solid rgba(30,144,255,.32)",
        background: "rgba(3,17,32,.82)",
        borderRadius: 14,
        padding: 10,
      }}
    >
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
        rows={2}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!disabled) onSubmit();
          }
        }}
        style={{
          flex: 1,
          minWidth: 0,
          resize: "none",
          border: "none",
          background: "transparent",
          color: "#eaf3ff",
          fontSize: 15,
          lineHeight: 1.45,
          minHeight: 44,
          padding: "10px 8px",
        }}
      />
      <button type="submit" className="chief-action" disabled={disabled || !value.trim()}>
        Send
      </button>
    </form>
  );
}
