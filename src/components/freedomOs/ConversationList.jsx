import { useEffect, useRef, useState } from "react";
import { formatRelativeTime, fosStyles } from "./freedomOsShared.js";

// Compact conversation switcher for CEO / sub-agent chat. Actions live in a
// ⋮ menu (rename / delete). Delete is hard and confirm-gated by the parent.

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
  onRename,
  onDelete,
}) {
  const [openMenuId, setOpenMenuId] = useState(null);
  const [menuPosition, setMenuPosition] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState("");
  const [isSavingRename, setIsSavingRename] = useState(false);
  const menuRef = useRef(null);
  const renameInputRef = useRef(null);

  const closeMenu = () => {
    setOpenMenuId(null);
    setMenuPosition(null);
  };

  useEffect(() => {
    if (!openMenuId) return undefined;
    const onPointerDown = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        closeMenu();
      }
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") closeMenu();
    };
    const onReposition = () => closeMenu();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [openMenuId]);

  useEffect(() => {
    if (!editingId) return;
    queueMicrotask(() => {
      renameInputRef.current?.focus?.();
      renameInputRef.current?.select?.();
    });
  }, [editingId]);

  const beginRename = (conversation) => {
    closeMenu();
    setEditingId(conversation.id);
    setEditDraft(displayTitle(conversation));
  };

  const openMenuFor = (conversationId, anchorEl) => {
    if (openMenuId === conversationId) {
      closeMenu();
      return;
    }
    const rect = anchorEl?.getBoundingClientRect?.();
    setOpenMenuId(conversationId);
    setMenuPosition(
      rect
        ? {
            top: rect.bottom + 4,
            right: Math.max(8, window.innerWidth - rect.right),
          }
        : { top: 0, right: 8 }
    );
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditDraft("");
    setIsSavingRename(false);
  };

  const commitRename = async (conversationId) => {
    const nextTitle = editDraft.trim();
    const current =
      conversations.find((row) => row.id === conversationId)?.title?.trim() || "New chat";
    if (!nextTitle || nextTitle === current) {
      cancelRename();
      return;
    }
    setIsSavingRename(true);
    try {
      await onRename?.(conversationId, nextTitle);
      cancelRename();
    } catch {
      setIsSavingRename(false);
    }
  };

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
          const menuOpen = openMenuId === conversation.id;
          const isEditing = editingId === conversation.id;

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
                position: "relative",
              }}
            >
              {isEditing ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void commitRename(conversation.id);
                  }}
                  style={{ minWidth: 0 }}
                >
                  <input
                    ref={renameInputRef}
                    value={editDraft}
                    disabled={isSavingRename}
                    maxLength={120}
                    onChange={(event) => setEditDraft(event.target.value)}
                    onBlur={() => {
                      if (!isSavingRename) void commitRename(conversation.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelRename();
                      }
                    }}
                    aria-label="Rename chat"
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      borderRadius: 8,
                      border: "1px solid rgba(0,216,255,.35)",
                      background: "rgba(0,136,255,.10)",
                      color: "#eef6ff",
                      padding: "6px 8px",
                      fontSize: 12,
                      fontWeight: 700,
                      outline: "none",
                    }}
                  />
                </form>
              ) : (
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
              )}

              <button
                type="button"
                title="Chat options"
                aria-label="Chat options"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                disabled={isEditing || isSavingRename}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  openMenuFor(conversation.id, event.currentTarget);
                }}
                style={{
                  ...iconButtonStyle,
                  opacity: isEditing || isSavingRename ? 0.45 : 1,
                  cursor: isEditing || isSavingRename ? "default" : "pointer",
                }}
              >
                ⋮
              </button>
            </div>
          );
        })}
      </div>

      {openMenuId && menuPosition ? (
        <div
          ref={menuRef}
          role="menu"
          style={{
            position: "fixed",
            top: menuPosition.top,
            right: menuPosition.right,
            zIndex: 40,
            minWidth: 120,
            borderRadius: 10,
            border: "1px solid rgba(0,216,255,.22)",
            background: "rgba(6,20,36,.98)",
            boxShadow: "0 10px 28px rgba(0,0,0,.35)",
            padding: 4,
            display: "grid",
            gap: 2,
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const conversation = conversations.find((row) => row.id === openMenuId);
              if (conversation) beginRename(conversation);
            }}
            style={menuItemStyle}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const id = openMenuId;
              closeMenu();
              onDelete?.(id);
            }}
            style={{ ...menuItemStyle, color: "#ffb4c0" }}
          >
            Delete
          </button>
        </div>
      ) : null}
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
  fontWeight: 900,
  fontSize: 16,
  lineHeight: 1,
  padding: 0,
};

const menuItemStyle = {
  border: "none",
  background: "transparent",
  color: "#eef6ff",
  textAlign: "left",
  cursor: "pointer",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 12,
  fontWeight: 700,
};
