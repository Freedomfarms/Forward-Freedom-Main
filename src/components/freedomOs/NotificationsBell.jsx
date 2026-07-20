import { useEffect, useRef, useState } from "react";
import { fetchNotifications, markNotificationRead } from "../../utils/agentsApi.js";
import { describeAgentApiError, formatRelativeTime, fosStyles } from "./freedomOsShared.js";

// Notifications bell for the Freedom OS header. Unread count comes from the
// bootstrap hook; opening the dropdown loads the full recent list and lets the
// user mark entries read one at a time (PATCH /api/notifications/:id).

export function NotificationsBell({ user, unreadCount, onUnreadCountChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState(null);
  const [loadError, setLoadError] = useState("");
  const containerRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handlePointerDown = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const payload = await fetchNotifications({}, { user });
        if (!cancelled) {
          setNotifications(Array.isArray(payload?.notifications) ? payload.notifications : []);
          setLoadError("");
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(describeAgentApiError(error, "Unable to load notifications."));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [isOpen, user]);

  const handleMarkRead = async (notification) => {
    if (notification.readAt) return;
    try {
      await markNotificationRead(notification.id, { user });
      const readAt = new Date().toISOString();
      setNotifications((current) =>
        (current || []).map((item) => (item.id === notification.id ? { ...item, readAt } : item))
      );
      onUnreadCountChange?.(Math.max(0, (unreadCount || 0) - 1));
    } catch (error) {
      setLoadError(describeAgentApiError(error, "Unable to mark the notification read."));
    }
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ""}`}
        onClick={() => setIsOpen((current) => !current)}
        style={{
          position: "relative",
          borderRadius: 999,
          width: 40,
          height: 40,
          border: "1px solid rgba(0,216,255,.22)",
          background: "rgba(0,136,255,.08)",
          color: "#eef6ff",
          cursor: "pointer",
          fontSize: 17,
        }}
      >
        🔔
        {unreadCount > 0 ? (
          <span
            style={{
              position: "absolute",
              top: -5,
              right: -5,
              minWidth: 18,
              height: 18,
              borderRadius: 999,
              background: "linear-gradient(90deg,#0077ff,#00d8ff)",
              color: "white",
              fontSize: 10,
              fontWeight: 900,
              display: "grid",
              placeItems: "center",
              padding: "0 4px",
              boxSizing: "border-box",
            }}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: 48,
            width: "min(360px, 86vw)",
            maxHeight: 420,
            overflowY: "auto",
            zIndex: 200,
            borderRadius: 14,
            border: "1px solid rgba(0,216,255,.24)",
            background: "linear-gradient(180deg, rgba(5,19,37,.98), rgba(3,12,24,.98))",
            boxShadow: "0 18px 48px rgba(0,0,0,.5)",
            padding: 14,
            display: "grid",
            gap: 10,
          }}
        >
          <div style={fosStyles.sectionLabel}>Notifications</div>
          {loadError ? <div style={fosStyles.errorBox}>{loadError}</div> : null}
          {notifications === null && !loadError ? (
            <div style={{ color: "#8faecc", fontSize: 13 }}>Loading…</div>
          ) : null}
          {notifications !== null && notifications.length === 0 ? (
            <div style={{ color: "#8faecc", fontSize: 13 }}>Nothing yet — agent runs and reminders will show up here.</div>
          ) : null}
          {(notifications || []).map((notification) => (
            <button
              key={notification.id}
              type="button"
              onClick={() => void handleMarkRead(notification)}
              style={{
                textAlign: "left",
                borderRadius: 10,
                border: notification.readAt
                  ? "1px solid rgba(30,144,255,.12)"
                  : "1px solid rgba(0,216,255,.3)",
                background: notification.readAt ? "rgba(3,17,32,.5)" : "rgba(0,136,255,.10)",
                padding: "10px 12px",
                cursor: notification.readAt ? "default" : "pointer",
                display: "grid",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {!notification.readAt ? (
                  <span
                    aria-hidden="true"
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: "#00d8ff",
                      flexShrink: 0,
                    }}
                  />
                ) : null}
                <span style={{ color: notification.readAt ? "#9fb0c9" : "white", fontWeight: 800, fontSize: 13 }}>
                  {notification.title}
                </span>
              </div>
              <div style={{ color: "#9fb0c9", fontSize: 12, lineHeight: 1.5 }}>{notification.body}</div>
              <div style={{ color: "#5f7896", fontSize: 11 }}>
                {formatRelativeTime(notification.createdAt)}
                {!notification.readAt ? " • tap to mark read" : ""}
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
