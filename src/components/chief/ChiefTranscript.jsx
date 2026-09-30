function bubbleStyle(role) {
  const user = role === "user";
  return {
    justifySelf: user ? "end" : "start",
    maxWidth: "min(100%, 640px)",
    borderRadius: 14,
    padding: "12px 14px",
    border: user ? "1px solid rgba(0,216,255,.35)" : "1px solid rgba(30,144,255,.28)",
    background: user ? "rgba(0,136,255,.16)" : "rgba(3,17,32,.72)",
    color: "#eaf3ff",
    whiteSpace: "pre-wrap",
    lineHeight: 1.55,
    fontSize: 14,
  };
}

export function ChiefTranscript({
  messages = [],
  streamText = "",
  isLoading = false,
  error = "",
  notFound = false,
  showEmpty = false,
  onRetry,
  onBackToList,
}) {
  if (notFound) {
    return (
      <div style={{ display: "grid", gap: 12, justifyItems: "start" }}>
        <div style={{ color: "#ffd38a", fontSize: 15, lineHeight: 1.5 }}>
          That conversation is not available.
        </div>
        <button type="button" className="chief-action" onClick={onBackToList}>
          Back to conversations
        </button>
      </div>
    );
  }

  if (isLoading) {
    return <div style={{ color: "#8faecc", fontSize: 14 }}>Loading conversation...</div>;
  }

  return (
    <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
      {showEmpty ? (
        <div style={{ display: "grid", gap: 8, padding: "12px 0 4px" }}>
          <div style={{ color: "white", fontSize: 28, fontWeight: 800 }}>CHIEF</div>
          <div style={{ color: "#9fb0c9", fontSize: 15, lineHeight: 1.5 }}>
            Start a conversation with CHIEF.
          </div>
        </div>
      ) : null}
      {messages.map((message) => (
        <div key={message.id} style={bubbleStyle(message.role)}>
          <div
            style={{
              color: "#8feaff",
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 0.6,
              marginBottom: 6,
            }}
          >
            {message.role === "user" ? "You" : "CHIEF"}
          </div>
          {message.text || ""}
        </div>
      ))}
      {streamText ? (
        <div style={bubbleStyle("assistant")}>
          <div
            style={{
              color: "#8feaff",
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 0.6,
              marginBottom: 6,
            }}
          >
            CHIEF
          </div>
          {streamText}
        </div>
      ) : null}
      {error ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ color: "#ffb4b4", fontSize: 14, lineHeight: 1.5 }}>{error}</div>
          {onRetry ? (
            <button type="button" className="chief-action" onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
