import { conversationLabel, formatChiefTime } from "../../utils/chiefApi.js";

const buttonStyle = {
  width: "100%",
  minHeight: 44,
  borderRadius: 10,
  border: "1px solid rgba(0,216,255,.35)",
  background: "rgba(0,136,255,.12)",
  color: "#eaf3ff",
  fontWeight: 800,
  cursor: "pointer",
  textAlign: "left",
  padding: "10px 12px",
};

export function ChiefConversationList({
  sessions = [],
  activeSessionId = null,
  isLoading = false,
  error = "",
  disabled = false,
  onNewConversation,
  onSelect,
  onRetry,
}) {
  return (
    <div style={{ display: "grid", alignContent: "start", gap: 12, minWidth: 0 }}>
      <div
        style={{
          color: "#9fb0c9",
          fontSize: 12,
          fontWeight: 800,
          letterSpacing: 1.2,
          textTransform: "uppercase",
        }}
      >
        Conversations
      </div>
      <button type="button" style={buttonStyle} onClick={onNewConversation} disabled={disabled}>
        + New conversation
      </button>
      {isLoading ? (
        <div style={{ color: "#8faecc", fontSize: 13 }}>Loading conversations...</div>
      ) : null}
      {error ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ color: "#ffb4b4", fontSize: 13, lineHeight: 1.5 }}>{error}</div>
          <button
            type="button"
            style={{ ...buttonStyle, background: "transparent" }}
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      ) : null}
      {!isLoading && !error && sessions.length === 0 ? (
        <div style={{ color: "#8faecc", fontSize: 13, lineHeight: 1.5 }}>No conversations yet.</div>
      ) : null}
      <div style={{ display: "grid", gap: 8 }}>
        {sessions.map((session) => {
          const active = session.sessionId === activeSessionId;
          return (
            <button
              key={session.sessionId}
              type="button"
              onClick={() => onSelect(session.sessionId)}
              disabled={disabled}
              aria-current={active ? "true" : undefined}
              style={{
                ...buttonStyle,
                background: active ? "rgba(0,136,255,.22)" : "rgba(3,17,32,.55)",
                border: active
                  ? "1px solid rgba(143,234,255,.7)"
                  : "1px solid rgba(30,144,255,.28)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <span
                style={{
                  color: "white",
                  fontWeight: 700,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {conversationLabel(session)}
              </span>
              <span style={{ color: "#8feaff", fontSize: 12, flexShrink: 0 }}>
                {formatChiefTime(session.updatedAt)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
