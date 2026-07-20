import { useEffect, useRef, useState } from "react";
import { styles } from "../../styles.js";
import {
  fetchAgentChatHistory,
  fetchCeoChatHistory,
  sendAgentChatMessage,
  sendCeoChatMessage,
} from "../../utils/agentsApi.js";
import { describeAgentApiError, fosStyles, getAgentTypeMeta } from "./freedomOsShared.js";

// Reusable chat UI for the agent platform (CEO panel, AgentDetail, and the
// "+ New Agent" flow). CEO and sub-agent modes load durable history from the
// server on mount so collapsing/remounting the panel does not wipe the thread.
// create_agent mode stays ephemeral (a dedicated intake UI).
//
// mode: "ceo"           → GET/POST /api/agents/ceo/chat
//       "create_agent"  → POST /api/agents/ceo/chat (starts creation session)
//       "agent"         → GET/POST /api/agents/:id/chat (requires agentId)

let localMessageId = 0;
function nextLocalId(prefix) {
  localMessageId += 1;
  return `${prefix}-${Date.now()}-${localMessageId}`;
}

function AgentCreatedCard({ agentCreated }) {
  const meta = getAgentTypeMeta(agentCreated.agentType);
  return (
    <div
      style={{
        marginTop: 10,
        borderRadius: 12,
        border: "1px solid rgba(34,197,94,.35)",
        background: "rgba(34,197,94,.08)",
        padding: "12px 14px",
      }}
    >
      <div style={{ color: "#7cf1af", fontSize: 11, fontWeight: 900, letterSpacing: 1, textTransform: "uppercase" }}>
        Agent created
      </div>
      <div style={{ color: "white", fontWeight: 800, fontSize: 14, marginTop: 6 }}>
        {meta.icon} {agentCreated.name}
      </div>
      <div style={{ color: "#c8d7ea", fontSize: 12, marginTop: 4 }}>
        Type: {meta.label} • Starts read-only and active
      </div>
    </div>
  );
}

function mapHistoryMessages(payload) {
  const rows = Array.isArray(payload?.messages) ? payload.messages : [];
  return rows
    .filter((row) => row && (row.role === "user" || row.role === "agent") && typeof row.text === "string")
    .map((row) => ({
      id: row.id || nextLocalId("history"),
      role: row.role,
      text: row.text,
    }));
}

export function AgentChat({
  mode = "ceo",
  agentId = null,
  agentName = "CEO Agent",
  user = null,
  relatedRunId = null,
  onClearRelatedRun = null,
  onAgentCreated = null,
  introMessage = null,
  placeholder = "Type a message...",
  maxHeight = 380,
}) {
  const loadsHistory = mode === "ceo" || (mode === "agent" && Boolean(agentId));
  const [messages, setMessages] = useState(() =>
    introMessage && !loadsHistory
      ? [{ id: "intro", role: "agent", text: introMessage }]
      : []
  );
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(loadsHistory);
  const [historyError, setHistoryError] = useState("");
  const [sendError, setSendError] = useState("");
  // In create mode only the FIRST message carries mode: "create_agent"; the
  // server keeps routing follow-ups to the active creation session on its own,
  // and re-sending the flag after completion would start a new session.
  const hasStartedCreateSessionRef = useRef(false);
  const scrollRef = useRef(null);
  const historyLoadedForRef = useRef(null);

  useEffect(() => {
    if (!loadsHistory) return undefined;

    const loadKey = mode === "agent" ? `agent:${agentId}` : "ceo";
    if (historyLoadedForRef.current === loadKey) return undefined;
    let cancelled = false;

    (async () => {
      try {
        const payload =
          mode === "agent"
            ? await fetchAgentChatHistory(agentId, { user })
            : await fetchCeoChatHistory({ user });
        if (cancelled) return;
        const history = mapHistoryMessages(payload);
        historyLoadedForRef.current = loadKey;
        setHistoryError("");
        setMessages((current) => {
          // Keep any optimistic turns that arrived while history was loading.
          const historyIds = new Set(history.map((row) => row.id));
          const pending = current.filter((row) => !historyIds.has(row.id) && row.id !== "intro");
          if (history.length === 0 && introMessage) {
            return [{ id: "intro", role: "agent", text: introMessage }, ...pending];
          }
          return [...history, ...pending];
        });
      } catch (error) {
        if (!cancelled) {
          setHistoryError(describeAgentApiError(error, "Could not load earlier messages."));
          if (introMessage) {
            setMessages((current) =>
              current.length ? current : [{ id: "intro", role: "agent", text: introMessage }]
            );
          }
        }
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadsHistory, mode, agentId, user, introMessage]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, isSending, isLoadingHistory]);

  const sendMessage = async (rawValue) => {
    const message = String(rawValue || "").trim();
    if (!message || isSending) return;

    const pendingRelatedRunId = relatedRunId || null;
    setDraft("");
    setSendError("");
    setIsSending(true);
    setMessages((current) => [...current, { id: nextLocalId("user"), role: "user", text: message }]);

    try {
      let payload;
      if (mode === "agent") {
        payload = await sendAgentChatMessage(
          agentId,
          { message, relatedRunId: pendingRelatedRunId },
          { user }
        );
      } else {
        const createFlag =
          mode === "create_agent" && !hasStartedCreateSessionRef.current
            ? "create_agent"
            : undefined;
        payload = await sendCeoChatMessage(
          { message, relatedRunId: pendingRelatedRunId, mode: createFlag },
          { user }
        );
        if (mode === "create_agent") hasStartedCreateSessionRef.current = true;
      }

      setMessages((current) => [
        ...current,
        {
          id: payload?.messageId || nextLocalId("agent"),
          role: "agent",
          text: payload?.reply || "(no reply)",
          agentCreated: payload?.agentCreated || null,
        },
      ]);
      if (pendingRelatedRunId && typeof onClearRelatedRun === "function") {
        onClearRelatedRun();
      }
      if (payload?.agentCreated && typeof onAgentCreated === "function") {
        onAgentCreated(payload.agentCreated);
      }
    } catch (error) {
      setSendError(describeAgentApiError(error, "The message could not be sent. Try again."));
    } finally {
      setIsSending(false);
    }
  };

  const showEmpty =
    messages.length === 0 && !isSending && !isLoadingHistory;

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div
        ref={scrollRef}
        style={{
          overflowY: "auto",
          maxHeight,
          minHeight: 120,
          display: "grid",
          gap: 10,
          alignContent: "start",
          padding: 2,
        }}
      >
        {isLoadingHistory ? (
          <div style={{ color: "#8faecc", fontSize: 13, lineHeight: 1.6, padding: "10px 4px" }}>
            Loading conversation…
          </div>
        ) : null}
        {showEmpty ? (
          <div style={{ color: "#8faecc", fontSize: 13, lineHeight: 1.6, padding: "10px 4px" }}>
            {mode === "create_agent"
              ? `Tell ${agentName} what the new agent should handle — it will ask a few questions and confirm before creating anything.`
              : `Start a conversation with ${agentName}.`}
          </div>
        ) : null}
        {messages.map((message) => (
          <div
            key={message.id}
            style={{
              justifySelf: message.role === "user" ? "end" : "stretch",
              maxWidth: message.role === "user" ? "88%" : "100%",
              borderRadius: 16,
              padding: "12px 14px",
              border:
                message.role === "user"
                  ? "1px solid rgba(0,216,255,.18)"
                  : "1px solid rgba(0,136,255,.22)",
              background:
                message.role === "user"
                  ? "linear-gradient(90deg, rgba(0,119,255,.18), rgba(0,216,255,.12))"
                  : "rgba(3,17,32,.86)",
            }}
          >
            {message.role === "agent" ? (
              <div
                style={{
                  color: "#8feaff",
                  fontSize: 10,
                  fontWeight: 900,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}
              >
                {agentName}
              </div>
            ) : null}
            <div
              style={{
                color: message.role === "user" ? "#eef6ff" : "#d7ebff",
                lineHeight: 1.65,
                fontSize: 13,
                whiteSpace: "pre-wrap",
              }}
            >
              {message.text}
            </div>
            {message.agentCreated ? <AgentCreatedCard agentCreated={message.agentCreated} /> : null}
          </div>
        ))}
        {isSending ? (
          <div
            style={{
              borderRadius: 16,
              padding: "12px 14px",
              border: "1px solid rgba(0,136,255,.22)",
              background: "rgba(3,17,32,.86)",
              color: "#8faecc",
              fontSize: 13,
            }}
          >
            {agentName} is thinking…
          </div>
        ) : null}
      </div>

      {historyError ? <div style={fosStyles.errorBox}>{historyError}</div> : null}
      {sendError ? <div style={fosStyles.errorBox}>{sendError}</div> : null}

      {relatedRunId ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            borderRadius: 10,
            border: "1px solid rgba(0,216,255,.22)",
            background: "rgba(0,136,255,.08)",
            padding: "8px 12px",
          }}
        >
          <div style={{ color: "#dff7ff", fontSize: 12 }}>
            Your next message will reference the selected run.
          </div>
          {typeof onClearRelatedRun === "function" ? (
            <button
              type="button"
              onClick={onClearRelatedRun}
              style={{
                border: "none",
                background: "transparent",
                color: "#8feaff",
                cursor: "pointer",
                fontWeight: 800,
                fontSize: 12,
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void sendMessage(draft);
        }}
        style={{ display: "grid", gap: 8 }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendMessage(draft);
            }
          }}
          placeholder={placeholder}
          rows={2}
          disabled={isSending}
          style={{
            width: "100%",
            resize: "vertical",
            borderRadius: 14,
            border: "1px solid rgba(0,216,255,.20)",
            background: "rgba(0,136,255,.07)",
            color: "#eef6ff",
            padding: "12px 13px",
            outline: "none",
            fontFamily: styles.page.fontFamily,
            fontSize: 13,
            boxSizing: "border-box",
            opacity: isSending ? 0.7 : 1,
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="submit"
            disabled={isSending || !draft.trim()}
            style={{
              ...fosStyles.primaryButton,
              opacity: isSending || !draft.trim() ? 0.55 : 1,
              cursor: isSending || !draft.trim() ? "default" : "pointer",
            }}
          >
            {isSending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
