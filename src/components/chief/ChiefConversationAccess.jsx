import { useEffect, useState } from "react";

import { ApiRequestError, buildAuthenticatedHeaders } from "../../utils/api.js";

const CONVERSATION_ACCESS_COPY = {
  read: "Read lets CHIEF list, open, and search your CHIEF conversations.",
  organize: "Organize lets CHIEF rename, archive, and restore. It does not allow delete.",
  delete: "Delete lets CHIEF permanently delete a conversation after you confirm.",
};

const SWITCHES = [
  ["conversationRead", "Read", CONVERSATION_ACCESS_COPY.read],
  ["conversationOrganize", "Organize", CONVERSATION_ACCESS_COPY.organize],
  ["conversationDelete", "Delete", CONVERSATION_ACCESS_COPY.delete],
];

async function readAccess(user) {
  const response = await fetch("/api/chief/conversation-access", {
    headers: await buildAuthenticatedHeaders({}, { user }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiRequestError(
      typeof payload?.error === "string" ? payload.error : "Conversation access could not be loaded.",
      { status: response.status }
    );
  }
  return {
    conversationRead: payload?.conversationRead === true,
    conversationOrganize: payload?.conversationOrganize === true,
    conversationDelete: payload?.conversationDelete === true,
  };
}

async function writeAccess(user, patch) {
  const response = await fetch("/api/chief/conversation-access", {
    method: "POST",
    headers: await buildAuthenticatedHeaders(
      { "Content-Type": "application/json" },
      { user }
    ),
    body: JSON.stringify(patch),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiRequestError(
      typeof payload?.error === "string" ? payload.error : "Conversation access could not be saved.",
      { status: response.status }
    );
  }
  return {
    conversationRead: payload?.conversationRead === true,
    conversationOrganize: payload?.conversationOrganize === true,
    conversationDelete: payload?.conversationDelete === true,
  };
}

export function ChiefConversationAccess({ user }) {
  const [access, setAccess] = useState(null);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");

  useEffect(() => {
    let cancelled = false;
    readAccess(user)
      .then((row) => {
        if (!cancelled) setAccess(row);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause?.message || "Conversation access could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  async function toggle(key) {
    if (!access || busyKey) return;
    const next = access[key] !== true;
    setBusyKey(key);
    setError("");
    try {
      setAccess(await writeAccess(user, { [key]: next }));
    } catch (cause) {
      setError(cause?.message || "Conversation access could not be saved.");
    } finally {
      setBusyKey("");
    }
  }

  return (
    <section aria-label="CHIEF conversation access" style={{ display: "grid", gap: 8 }}>
      <div
        style={{
          color: "#9fb0c9",
          fontSize: 12,
          fontWeight: 800,
          letterSpacing: 1.2,
          textTransform: "uppercase",
        }}
      >
        CHIEF access
      </div>
      {SWITCHES.map(([key, label, copy]) => {
        const on = access?.[key] === true;
        return (
          <div key={key} style={{ display: "grid", gap: 6 }}>
            <button
              type="button"
              aria-pressed={on}
              disabled={!access || Boolean(busyKey)}
              onClick={() => toggle(key)}
              style={{
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid rgba(0,216,255,.35)",
                background: on ? "rgba(0,136,255,.22)" : "rgba(3,17,32,.55)",
                color: "#eaf3ff",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              {label} {on ? "ON" : "OFF"}
            </button>
            <p style={{ margin: 0, color: "#8faecc", fontSize: 12, lineHeight: 1.45 }}>{copy}</p>
          </div>
        );
      })}
      {error ? <div style={{ color: "#ffb4b4", fontSize: 13 }}>{error}</div> : null}
    </section>
  );
}
