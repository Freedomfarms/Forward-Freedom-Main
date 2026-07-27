import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { styles } from "../../styles.js";
import { ApiRequestError } from "../../utils/api.js";
import {
  createAgentConversation,
  createCeoConversation,
  deleteAgentConversation,
  deleteCeoConversation,
  fetchAgentChatHistory,
  fetchAgentConversationMessages,
  fetchAgentConversations,
  fetchCeoChatHistory,
  fetchCeoConversationMessages,
  fetchCeoConversations,
  sendAgentChatMessage,
  sendCeoChatMessage,
  updateAgentConversation,
  updateCeoConversation,
  uploadCeoDocuments,
} from "../../utils/agentsApi.js";
import {
  CEO_DOCUMENT_ACCEPT,
  MAX_UPLOAD_DOCS,
  readCeoDocumentFiles,
} from "../../utils/ceoDocumentFiles.js";
import { ConversationList } from "./ConversationList.jsx";
import CeoActivityStream from "./CeoActivityStream.jsx";
import {
  filterConversationsInScope,
  isConversationInScope,
  isRecoverableConversationError,
} from "./conversationScope.js";
import { parseChatEmphasis } from "../../utils/chatTextFormat.js";
import { describeAgentApiError, fosStyles, getAgentTypeMeta } from "./freedomOsShared.js";

// Reusable chat UI for the agent platform (CEO panel + AgentDetail).
// CEO mode is the single brain for ask / create / run — no separate builder.
//
// mode: "ceo"   → CEO conversations + chat
//       "agent" → sub-agent conversations + chat (requires agentId)
// layout: "embedded" (default) | "workspace" (ChatGPT-style full pane)

/** Merge a live activity event by key (status transitions keep one row per key). */
function mergeActivityEvent(current, activity) {
  if (!activity?.key) return current;
  const list = Array.isArray(current) ? [...current] : [];
  const index = list.findIndex((row) => row.key === activity.key);
  if (index >= 0) {
    list[index] = { ...list[index], ...activity };
    return list;
  }
  return [...list, activity];
}

/** Render **bold** and __underline__ — no raw markdown asterisks in the bubble. */
function renderChatText(text) {
  return parseChatEmphasis(text).map((segment, index) => {
    if (segment.type === "bold") {
      return <strong key={index}>{segment.value}</strong>;
    }
    if (segment.type === "underline") {
      return <u key={index}>{segment.value}</u>;
    }
    return <span key={index}>{segment.value}</span>;
  });
}

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
  mode: modeProp = "ceo",
  agentId = null,
  agentName = "CEO Agent",
  user = null,
  relatedRunId = null,
  onClearRelatedRun = null,
  onAgentCreated = null,
  onAgentUpdated = null,
  onDigestUpdated = null,
  onRunStarted = null,
  introMessage = null,
  placeholder = "Type a message...",
  maxHeight = 380,
  layout = "embedded",
  listLabel = "Chats",
  composeApiRef = null,
}) {
  // Legacy create_agent mode is retired — behave as CEO chat.
  const mode = modeProp === "create_agent" ? "ceo" : modeProp;
  const loadsHistory = mode === "ceo" || (mode === "agent" && Boolean(agentId));
  const isWorkspace = layout === "workspace";
  const userScopeKey = user?.uid || user?.id || "anon";
  const chatScope = useCallback(() => ({ mode, agentId }), [mode, agentId]);

  const [messages, setMessages] = useState(() =>
    introMessage && !loadsHistory
      ? [{ id: "intro", role: "agent", text: introMessage }]
      : []
  );
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [liveActivities, setLiveActivities] = useState([]);
  const [activityStartedAt, setActivityStartedAt] = useState(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(loadsHistory);
  const [historyError, setHistoryError] = useState("");
  const [sendError, setSendError] = useState("");
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [isLoadingConversations, setIsLoadingConversations] = useState(loadsHistory);
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);
  const [listError, setListError] = useState("");
  const [isUploadingDocs, setIsUploadingDocs] = useState(false);
  const [uploadNotice, setUploadNotice] = useState("");
  const [uploadError, setUploadError] = useState("");
  const scrollRef = useRef(null);
  const composerRef = useRef(null);
  const fileInputRef = useRef(null);
  const historyLoadedForRef = useRef(null);
  const conversationsLoadedForRef = useRef(null);
  const recoveringRef = useRef(false);

  useImperativeHandle(
    composeApiRef,
    () => ({
      seedCompose(text) {
        setDraft(String(text || ""));
        queueMicrotask(() => composerRef.current?.focus?.());
      },
    }),
    []
  );

  const listConversations = useCallback(async () => {
    if (mode === "agent") return fetchAgentConversations(agentId, {}, { user });
    if (mode === "ceo") return fetchCeoConversations({}, { user });
    throw new Error("Conversation list is only available for CEO or sub-agent chat.");
  }, [mode, agentId, user]);

  const createConversation = useCallback(async () => {
    if (mode === "agent") return createAgentConversation(agentId, {}, { user });
    if (mode === "ceo") return createCeoConversation({}, { user });
    throw new Error("Conversation create is only available for CEO or sub-agent chat.");
  }, [mode, agentId, user]);

  const loadMessagesFor = useCallback(
    async (conversationId) => {
      if (!conversationId) {
        if (mode === "agent") return fetchAgentChatHistory(agentId, {}, { user });
        if (mode === "ceo") return fetchCeoChatHistory({}, { user });
        throw new Error("Chat history is only available for CEO or sub-agent chat.");
      }
      if (mode === "agent") {
        return fetchAgentConversationMessages(agentId, conversationId, {}, { user });
      }
      if (mode === "ceo") {
        return fetchCeoConversationMessages(conversationId, {}, { user });
      }
      throw new Error("Chat history is only available for CEO or sub-agent chat.");
    },
    [mode, agentId, user]
  );

  const applyConversationRows = useCallback(
    (rows) => {
      const scoped = filterConversationsInScope(rows, chatScope());
      setConversations(scoped);
      setActiveConversationId((current) => {
        if (current && scoped.some((row) => row.id === current)) return current;
        return scoped[0]?.id || null;
      });
      return scoped;
    },
    [chatScope]
  );

  // Load conversation list once per user + agent/CEO scope; ensure ≥1 thread.
  useEffect(() => {
    if (!loadsHistory) return undefined;

    const scopeKey = `${userScopeKey}:${mode === "agent" ? `agent:${agentId}` : "ceo"}`;
    if (conversationsLoadedForRef.current === scopeKey) return undefined;
    let cancelled = false;

    (async () => {
      setIsLoadingConversations(true);
      setListError("");
      try {
        const scope = chatScope();
        const payload = await listConversations();
        let rows = filterConversationsInScope(
          Array.isArray(payload?.conversations) ? payload.conversations : [],
          scope
        );
        if (rows.length === 0) {
          const created = await createConversation();
          if (created?.conversation && isConversationInScope(created.conversation, scope)) {
            rows = [created.conversation];
          } else {
            const retry = await listConversations();
            rows = filterConversationsInScope(
              Array.isArray(retry?.conversations) ? retry.conversations : [],
              scope
            );
          }
        }
        if (cancelled) return;
        conversationsLoadedForRef.current = scopeKey;
        applyConversationRows(rows);
      } catch (error) {
        if (!cancelled) {
          setListError(describeAgentApiError(error, "Could not load chats."));
        }
      } finally {
        if (!cancelled) setIsLoadingConversations(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    loadsHistory,
    mode,
    agentId,
    userScopeKey,
    listConversations,
    createConversation,
    applyConversationRows,
    chatScope,
  ]);

  const recoverFromBadConversation = useCallback(
    async (badConversationId, error) => {
      if (recoveringRef.current) return;
      recoveringRef.current = true;
      const notice = describeAgentApiError(
        error,
        "That chat is not available here. Switching to a valid conversation."
      );
      try {
        const scope = chatScope();
        historyLoadedForRef.current = null;
        setConversations((current) => current.filter((row) => row.id !== badConversationId));
        setActiveConversationId(null);
        setMessages([]);
        setSendError("");
        setHistoryError(notice);
        setListError("");

        const payload = await listConversations();
        let rows = filterConversationsInScope(
          Array.isArray(payload?.conversations) ? payload.conversations : [],
          scope
        ).filter((row) => row.id !== badConversationId);

        if (rows.length === 0) {
          const created = await createConversation();
          if (created?.conversation && isConversationInScope(created.conversation, scope)) {
            rows = [created.conversation];
          }
        }

        applyConversationRows(rows);
        if (rows[0]?.id) {
          setActiveConversationId(rows[0].id);
        }
      } catch (recoveryError) {
        setListError(describeAgentApiError(recoveryError, "Could not recover chat list."));
      } finally {
        recoveringRef.current = false;
      }
    },
    [listConversations, createConversation, applyConversationRows, chatScope]
  );

  // Load messages whenever the active conversation changes.
  useEffect(() => {
    if (!loadsHistory) return undefined;
    if (!activeConversationId && isLoadingConversations) return undefined;

    const loadKey = `${userScopeKey}:${mode === "agent" ? `agent:${agentId}` : "ceo"}:${activeConversationId || "default"}`;
    if (historyLoadedForRef.current === loadKey) return undefined;
    let cancelled = false;

    (async () => {
      setIsLoadingHistory(true);
      setHistoryError("");
      const loadHistory = async () => loadMessagesFor(activeConversationId);

      try {
        let payload;
        try {
          payload = await loadHistory();
        } catch (firstError) {
          if (activeConversationId && isRecoverableConversationError(firstError)) {
            if (!cancelled) {
              await recoverFromBadConversation(activeConversationId, firstError);
            }
            return;
          }
          const isHttpError = firstError instanceof ApiRequestError;
          const transient =
            !isHttpError &&
            /failed to fetch|networkerror|load failed/i.test(String(firstError?.message || ""));
          if (!transient) throw firstError;
          await new Promise((resolve) => {
            globalThis.setTimeout(resolve, 400);
          });
          payload = await loadHistory();
        }
        if (cancelled) return;
        const history = mapHistoryMessages(payload);
        historyLoadedForRef.current = loadKey;
        setMessages((current) => {
          const historyIds = new Set(history.map((row) => row.id));
          const pending = current.filter(
            (row) => !historyIds.has(row.id) && row.id !== "intro" && row._pendingFor === loadKey
          );
          if (history.length === 0 && introMessage) {
            return [{ id: "intro", role: "agent", text: introMessage }, ...pending];
          }
          return [...history, ...pending];
        });
      } catch (error) {
        if (!cancelled) {
          if (activeConversationId && isRecoverableConversationError(error)) {
            await recoverFromBadConversation(activeConversationId, error);
          } else {
            setHistoryError(describeAgentApiError(error, "Could not load earlier messages."));
            if (introMessage) {
              setMessages((current) =>
                current.length ? current : [{ id: "intro", role: "agent", text: introMessage }]
              );
            }
          }
        }
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    loadsHistory,
    mode,
    agentId,
    userScopeKey,
    activeConversationId,
    isLoadingConversations,
    introMessage,
    loadMessagesFor,
    recoverFromBadConversation,
  ]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, isSending, isLoadingHistory]);

  const refreshConversationList = async () => {
    try {
      const payload = await listConversations();
      const rows = filterConversationsInScope(
        Array.isArray(payload?.conversations) ? payload.conversations : [],
        chatScope()
      );
      setConversations(rows);
      return rows;
    } catch (error) {
      setListError(describeAgentApiError(error, "Could not refresh chats."));
      return conversations;
    }
  };

  const handleNewChat = async () => {
    if (isCreatingConversation) return;
    setIsCreatingConversation(true);
    setListError("");
    try {
      const payload = await createConversation();
      const created = payload?.conversation;
      if (!created?.id || !isConversationInScope(created, chatScope())) {
        throw new Error("Conversation was not created for this agent.");
      }
      historyLoadedForRef.current = null;
      setConversations((current) => [created, ...current.filter((row) => row.id !== created.id)]);
      setActiveConversationId(created.id);
      setMessages([]);
      setHistoryError("");
      setSendError("");
    } catch (error) {
      setListError(describeAgentApiError(error, "Could not start a new chat."));
    } finally {
      setIsCreatingConversation(false);
    }
  };

  const handleSelectConversation = (conversationId) => {
    if (!conversationId || conversationId === activeConversationId) return;
    if (!conversations.some((row) => row.id === conversationId)) return;
    historyLoadedForRef.current = null;
    setActiveConversationId(conversationId);
    setMessages([]);
    setSendError("");
    setHistoryError("");
  };

  const handleRenameConversation = async (conversationId, title) => {
    const nextTitle = String(title || "").trim();
    if (!conversationId || !nextTitle) return;
    try {
      let updated;
      if (mode === "agent") {
        updated = await updateAgentConversation(
          agentId,
          conversationId,
          { title: nextTitle },
          { user }
        );
      } else if (mode === "ceo") {
        updated = await updateCeoConversation(conversationId, { title: nextTitle }, { user });
      } else {
        return;
      }
      const nextTitleValue = updated?.title || nextTitle;
      setConversations((current) =>
        current.map((row) =>
          row.id === conversationId
            ? {
                ...row,
                title: nextTitleValue,
                updatedAt: updated?.updatedAt || new Date().toISOString(),
              }
            : row
        )
      );
    } catch (error) {
      if (isRecoverableConversationError(error)) {
        await recoverFromBadConversation(conversationId, error);
      } else {
        setListError(describeAgentApiError(error, "Could not rename that chat."));
      }
      throw error;
    }
  };

  const handleDeleteConversation = async (conversationId) => {
    const label =
      conversations.find((row) => row.id === conversationId)?.title?.trim() || "this chat";
    const confirmed = window.confirm(
      `Delete "${label}" permanently? This cannot be undone.`
    );
    if (!confirmed) return;
    try {
      if (mode === "agent") {
        await deleteAgentConversation(agentId, conversationId, { user });
      } else if (mode === "ceo") {
        await deleteCeoConversation(conversationId, { user });
      } else {
        return;
      }
      const rows = (await refreshConversationList()).filter((row) => row.id !== conversationId);
      setConversations(rows);
      if (conversationId === activeConversationId) {
        historyLoadedForRef.current = null;
        const nextId = rows[0]?.id || null;
        if (!nextId) {
          await handleNewChat();
        } else {
          setActiveConversationId(nextId);
          setMessages([]);
        }
      }
    } catch (error) {
      if (isRecoverableConversationError(error)) {
        await recoverFromBadConversation(conversationId, error);
      } else {
        setListError(describeAgentApiError(error, "Could not delete that chat."));
      }
    }
  };

  const handleUploadDocuments = async (fileList) => {
    setUploadError("");
    setUploadNotice("");
    setIsUploadingDocs(true);
    try {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      if (files.length > MAX_UPLOAD_DOCS) {
        throw new Error(`You can upload up to ${MAX_UPLOAD_DOCS} documents at once.`);
      }
      const parsed = await readCeoDocumentFiles(files);
      const valid = parsed.filter((doc) => doc.content?.trim());
      if (!valid.length) {
        throw new Error(
          "Choose at least one supported file (.txt, .md, .csv, .json, .pdf, .docx, .xlsx, or .pptx)."
        );
      }
      await uploadCeoDocuments(valid, { user });
      const names = valid.map((doc) => doc.filename).join(", ");
      setUploadNotice(
        valid.length === 1
          ? `Uploaded ${names}. Agents can use it in the next message.`
          : `Uploaded ${valid.length} documents (${names}). Agents can use them in the next message.`
      );
    } catch (error) {
      setUploadError(describeAgentApiError(error, "Document upload failed."));
    } finally {
      setIsUploadingDocs(false);
    }
  };

  const sendMessage = async (rawValue) => {
    const message = String(rawValue || "").trim();
    if (!message || isSending) return;
    if (loadsHistory && (isLoadingConversations || !activeConversationId)) return;

    const pendingRelatedRunId = relatedRunId || null;
    const conversationIdForSend = activeConversationId;
    setDraft("");
    setSendError("");
    setIsSending(true);
    setLiveActivities(
      mode === "ceo"
        ? [
            {
              id: "local-understanding",
              key: "UNDERSTANDING_REQUEST",
              phase: "ASSESSING",
              label: "Understanding request",
              status: "active",
              elapsedMs: 0,
            },
          ]
        : []
    );
    setActivityStartedAt(mode === "ceo" ? Date.now() : null);
    setMessages((current) => [
      ...current,
      {
        id: nextLocalId("user"),
        role: "user",
        text: message,
        _pendingFor: `${userScopeKey}:${mode === "agent" ? `agent:${agentId}` : "ceo"}:${activeConversationId || "default"}`,
      },
    ]);

    // Optimistic snippet title in the list while the server confirms.
    if (conversationIdForSend) {
      setConversations((current) =>
        current.map((row) => {
          if (row.id !== conversationIdForSend) return row;
          if (row.title && String(row.title).trim()) return row;
          const snippet = message.length > 40 ? `${message.slice(0, 39).trimEnd()}…` : message;
          return { ...row, title: snippet, updatedAt: new Date().toISOString() };
        })
      );
    }

    try {
      let payload;
      if (mode === "agent") {
        payload = await sendAgentChatMessage(
          agentId,
          {
            message,
            relatedRunId: pendingRelatedRunId,
            conversationId: conversationIdForSend,
          },
          { user }
        );
      } else if (mode === "ceo") {
        payload = await sendCeoChatMessage(
          {
            message,
            relatedRunId: pendingRelatedRunId,
            conversationId: conversationIdForSend,
          },
          {
            user,
            onActivity: (activity) => {
              setLiveActivities((current) => mergeActivityEvent(current, activity));
            },
          }
        );
      } else {
        throw new Error("Unsupported chat mode.");
      }

      if (payload?.conversationId) {
        setActiveConversationId(payload.conversationId);
        setConversations((current) => {
          const title = payload.conversationTitle || null;
          const updatedAt = new Date().toISOString();
          const existing = current.find((row) => row.id === payload.conversationId);
          if (existing) {
            return current
              .map((row) =>
                row.id === payload.conversationId
                  ? {
                      ...row,
                      title: title || row.title,
                      updatedAt,
                    }
                  : row
              )
              .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
          }
          // Synthesize a scoped stub from the current mode (server just wrote
          // it there). Placeholder ceoAgentConfigId is truthy for client
          // scope checks until the list refresh returns the real uuid.
          const stub =
            mode === "agent"
              ? {
                  id: payload.conversationId,
                  title,
                  updatedAt,
                  isSystem: false,
                  archivedAt: null,
                  agentConfigId: agentId,
                  ceoAgentConfigId: null,
                }
              : {
                  id: payload.conversationId,
                  title,
                  updatedAt,
                  isSystem: false,
                  archivedAt: null,
                  agentConfigId: null,
                  ceoAgentConfigId: "ceo",
                };
          if (!isConversationInScope(stub, { mode, agentId })) {
            return current;
          }
          return [stub, ...current];
        });
      }

      setMessages((current) => [
        ...current,
        {
          id: payload?.messageId || nextLocalId("agent"),
          role: "agent",
          text: payload?.reply || "(no reply)",
          agentCreated: payload?.agentCreated || null,
          activities:
            mode === "ceo" && Array.isArray(payload?.activities) ? payload.activities : null,
        },
      ]);
      if (pendingRelatedRunId && typeof onClearRelatedRun === "function") {
        onClearRelatedRun();
      }
      if (payload?.agentCreated && typeof onAgentCreated === "function") {
        onAgentCreated(payload.agentCreated);
      }
      if (payload?.agent) {
        if (typeof onAgentCreated === "function") onAgentCreated(payload.agent);
        if (typeof onAgentUpdated === "function") onAgentUpdated(payload.agent);
      }
      if (payload?.digest && typeof onDigestUpdated === "function") {
        onDigestUpdated(payload.digest);
      }
      if (payload?.run && typeof onRunStarted === "function") {
        onRunStarted(payload.run);
      }
      // Refresh list later so async LLM titles can appear.
      window.setTimeout(() => {
        void refreshConversationList();
      }, 2500);
    } catch (error) {
      if (conversationIdForSend && isRecoverableConversationError(error)) {
        await recoverFromBadConversation(conversationIdForSend, error);
      } else {
        setSendError(describeAgentApiError(error, "The message could not be sent. Try again."));
      }
    } finally {
      setIsSending(false);
      setLiveActivities([]);
      setActivityStartedAt(null);
    }
  };

  const showEmpty = messages.length === 0 && !isSending && !isLoadingHistory;
  const composerDisabled =
    isSending || (loadsHistory && (isLoadingConversations || !activeConversationId));
  const uploadDisabled = composerDisabled || isUploadingDocs;
  const chatMaxHeight = isWorkspace ? "min(62vh, 640px)" : maxHeight;

  const chatBody = (
    <div style={{ display: "grid", gap: 10, minWidth: 0, ...(isWorkspace ? { minHeight: 0 } : {}) }}>
      <div
        ref={scrollRef}
        style={{
          overflowY: "auto",
          maxHeight: chatMaxHeight,
          minHeight: isWorkspace ? 280 : 120,
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
            {`Talk to ${agentName} — ask questions, create agents, or run work from this chat.`}
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
            {message.role === "agent" &&
            Array.isArray(message.activities) &&
            message.activities.length ? (
              <div style={{ marginBottom: 10 }}>
                <CeoActivityStream agentName={agentName} activities={message.activities} />
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
              {renderChatText(message.text)}
            </div>
            {message.agentCreated ? <AgentCreatedCard agentCreated={message.agentCreated} /> : null}
          </div>
        ))}
        {isSending ? (
          mode === "ceo" ? (
            <CeoActivityStream
              agentName={agentName}
              activities={liveActivities}
              live
              startedAt={activityStartedAt}
            />
          ) : (
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
              {agentName} is working…
            </div>
          )
        ) : null}
      </div>

      {historyError ? <div style={fosStyles.errorBox}>{historyError}</div> : null}
      {sendError ? <div style={fosStyles.errorBox}>{sendError}</div> : null}
      {uploadError ? <div style={fosStyles.errorBox}>{uploadError}</div> : null}
      {uploadNotice ? (
        <div
          style={{
            borderRadius: 10,
            border: "1px solid rgba(34,197,94,.28)",
            background: "rgba(34,197,94,.08)",
            color: "#b7f7d0",
            fontSize: 12,
            padding: "8px 12px",
          }}
        >
          {uploadNotice}
        </div>
      ) : null}

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
          ref={composerRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendMessage(draft);
            }
          }}
          placeholder={placeholder}
          rows={isWorkspace ? 3 : 2}
          disabled={composerDisabled}
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
            opacity: composerDisabled ? 0.7 : 1,
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept={CEO_DOCUMENT_ACCEPT}
              multiple
              disabled={uploadDisabled}
              style={{ display: "none" }}
              onChange={(event) => {
                const input = event.target;
                void handleUploadDocuments(input.files).finally(() => {
                  input.value = "";
                });
              }}
            />
            <button
              type="button"
              title="Upload documents"
              aria-label="Upload documents"
              disabled={uploadDisabled}
              onClick={() => fileInputRef.current?.click()}
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                border: "1px solid rgba(0,216,255,.28)",
                background: "rgba(0,136,255,.10)",
                color: "#eef6ff",
                cursor: uploadDisabled ? "default" : "pointer",
                opacity: uploadDisabled ? 0.55 : 1,
                fontWeight: 900,
                fontSize: 22,
                lineHeight: 1,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
              }}
            >
              {isUploadingDocs ? "…" : "+"}
            </button>
            <span style={{ color: "#6f8aa8", fontSize: 11 }}>
              {isUploadingDocs ? "Uploading…" : "Add document"}
            </span>
          </div>
          <button
            type="submit"
            disabled={composerDisabled || !draft.trim()}
            style={{
              ...fosStyles.primaryButton,
              opacity: composerDisabled || !draft.trim() ? 0.55 : 1,
              cursor: composerDisabled || !draft.trim() ? "default" : "pointer",
            }}
          >
            {isSending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );

  if (!loadsHistory) {
    return chatBody;
  }

  return (
    <div
      style={{
        display: "grid",
        gap: isWorkspace ? 14 : 12,
        gridTemplateColumns: isWorkspace
          ? "minmax(200px, 260px) minmax(0, 1fr)"
          : "minmax(160px, 220px) minmax(0, 1fr)",
        alignItems: "stretch",
        ...(isWorkspace
          ? {
              borderRadius: 16,
              border: "1px solid rgba(0,216,255,.14)",
              background: "rgba(2,14,28,.55)",
              padding: 12,
              minHeight: 420,
            }
          : {}),
      }}
      className="fos-chat-with-conversations"
    >
      <ConversationList
        conversations={conversations}
        activeConversationId={activeConversationId}
        isLoading={isLoadingConversations}
        isCreating={isCreatingConversation}
        error={listError}
        sectionLabel={listLabel}
        listMaxHeight={isWorkspace ? 520 : 168}
        onSelect={handleSelectConversation}
        onNewChat={() => void handleNewChat()}
        onRename={(id, title) => handleRenameConversation(id, title)}
        onDelete={(id) => void handleDeleteConversation(id)}
      />
      {chatBody}
      <style>{`
        @media (max-width: 720px) {
          .fos-chat-with-conversations {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}
