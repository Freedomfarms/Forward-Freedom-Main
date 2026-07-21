import { formatRelativeTime, fosStyles } from "./freedomOsShared.js";

// Compact conversation switcher for CEO / sub-agent chat. Archive is soft
// (drops from the default list); delete is hard and confirm-gated by the parent.

function displayTitle(conversation) {
  const title = typeof conversation?.title === "string" ? conversation.title.trim() : "";
  return title || "New chat";
}

export function ConversationList({
  conversations = [],
  activeConversationId = null,
  isLoading = false,
  isCreating = false,
  error = "",
  sectionLabel = "Chats",
  listMaxHeight = 168,
  onSelect,
  onNewChat,
  onArchive,
  onDelete,
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: 8,
        borderRadius: 14,
        border: "1px solid rgba(0,216,255,.14)",
        background: "rgba(2,14,28,.72)",
        padding: 10,
        alignContent: "start",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ ...fosStyles.sectionLabel, fontSize: 11 }}>{sectionLabel}</div>
        <button
          type="button"
          onClick={() => onNewChat?.()}
          disabled={isCreating || isLoading}
          style={{
            ...fosStyles.subtleButton,
            opacity: isCreating || isLoading ? 0.55 : 1,
            cursor: isCreating || isLoading ? "default" : "pointer",
            padding: "6px 10px",
          }}
        >
          {isCreating ? "Creating…" : "+ New chat"}
        </button>
      </div>

      {error ? <div style={{ ...fosStyles.errorBox, padding: "8px 10px", fontSize: 12 }}>{error}</div> : null}

      <div
        style={{
          display: "grid",
          gap: 4,
          maxHeight: listMaxHeight,
          overflowY: "auto",
        }}
      >
        {isLoading && conversations.length === 0 ? (
          <div style={{ color: "#8faecc", fontSize: 12, padding: "6px 4px" }}>Loading chats…</div>
        ) : null}
        {!isLoading && conversations.length === 0 ? (
          <div style={{ color: "#8faecc", fontSize: 12, padding: "6px 4px" }}>
            No chats yet — start one below.
          </div>
        ) : null}
        {conversations.map((conversation) => {
          const active = conversation.id === activeConversationId;
          return (
            <div
              key={conversation.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 6,
                alignItems: "center",
                borderRadius: 10,
                border: active
                  ? "1px solid rgba(0,216,255,.35)"
                  : "1px solid transparent",
                background: active ? "rgba(0,136,255,.14)" : "transparent",
                padding: "6px 8px",
              }}
            >
              <button
                type="button"
                onClick={() => onSelect?.(conversation.id)}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "#eef6ff",
                  textAlign: "left",
                  cursor: "pointer",
                  padding: 0,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: active ? 800 : 600,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {displayTitle(conversation)}
                </div>
                <div style={{ color: "#7f97b3", fontSize: 10, marginTop: 2 }}>
                  {formatRelativeTime(conversation.updatedAt)}
                </div>
              </button>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  type="button"
                  title="Archive"
                  aria-label="Archive conversation"
                  onClick={() => onArchive?.(conversation.id)}
                  style={{ ...iconButtonStyle, fontSize: 10, width: "auto", padding: "0 6px" }}
                >
                  Arch
                </button>
                <button
                  type="button"
                  title="Delete"
                  aria-label="Delete conversation"
                  onClick={() => onDelete?.(conversation.id)}
                  style={{ ...iconButtonStyle, color: "#ffb4c0" }}
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const iconButtonStyle = {
  border: "1px solid rgba(0,216,255,.16)",
  background: "rgba(0,136,255,.06)",
  color: "#9fb0c9",
  borderRadius: 8,
  width: 26,
  height: 26,
  cursor: "pointer",
  fontWeight: 800,
  fontSize: 13,
  lineHeight: 1,
  padding: 0,
};
