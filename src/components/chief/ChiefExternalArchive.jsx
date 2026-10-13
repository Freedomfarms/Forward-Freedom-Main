import { useCallback, useEffect, useState } from "react";
import {
  deleteImportedConversation,
  fetchImportedConversation,
  fetchImportedConversations,
  forgetImportedMemory,
  importConversationExport,
  previewConversationExport,
  retainImportedMemories,
} from "../../utils/chiefApi.js";

const PROVIDERS = Object.freeze([
  Object.freeze(["claude", "Claude"]),
  Object.freeze(["chatgpt", "ChatGPT"]),
]);

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The export file could not be read."));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const marker = value.indexOf(",");
      resolve(marker >= 0 ? value.slice(marker + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}

function formatWhen(value) {
  if (!value) return "No timestamp";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No timestamp";
  return date.toLocaleString();
}

export function ChiefExternalArchive({ user, focusId = "" }) {
  const [provider, setProvider] = useState("claude");
  const [file, setFile] = useState(null);
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [detail, setDetail] = useState(null);
  const [memories, setMemories] = useState([]);
  const [notePhase, setNotePhase] = useState("idle");
  const [pendingDelete, setPendingDelete] = useState(null);
  const [focusMiss, setFocusMiss] = useState({ id: "", kind: "" });

  const refresh = useCallback(async () => {
    if (!user) return;
    const payload = await fetchImportedConversations(user);
    setConversations(Array.isArray(payload.conversations) ? payload.conversations : []);
  }, [user]);

  useEffect(() => {
    if (!user || !focusId) return undefined;
    let cancelled = false;
    fetchImportedConversation(user, focusId)
      .then((payload) => {
        if (cancelled) return;
        const conversation = payload?.conversation ?? null;
        setError("");
        setDetail(conversation);
        setMemories(Array.isArray(payload?.memories) ? payload.memories : []);
        setFocusMiss(conversation ? { id: "", kind: "" } : { id: focusId, kind: "deleted" });
      })
      .catch((cause) => {
        if (cancelled) return;
        setDetail(null);
        setMemories([]);
        if (cause?.status === 404) {
          setError("");
          setFocusMiss({ id: focusId, kind: "deleted" });
          return;
        }
        setFocusMiss({ id: focusId, kind: "error" });
        setError(cause.message || "That conversation could not be opened.");
      });
    return () => {
      cancelled = true;
    };
  }, [user, focusId]);

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    fetchImportedConversations(user)
      .then((payload) => {
        if (cancelled) return;
        setConversations(Array.isArray(payload.conversations) ? payload.conversations : []);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause.message || "Imported conversations could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  async function uploadBody() {
    if (!file) throw new Error("Choose an export file.");
    const dataBase64 = await fileToBase64(file);
    return { provider, filename: file.name, dataBase64 };
  }

  async function review(event) {
    event.preventDefault();
    setError("");
    setResult(null);
    setPhase("previewing");
    try {
      const body = await uploadBody();
      const next = await previewConversationExport(user, body);
      setPreview(next);
      setPhase("ready");
    } catch (cause) {
      setPreview(null);
      setPhase("idle");
      setError(cause.message || "The export could not be reviewed.");
    }
  }

  async function confirmImport() {
    setError("");
    setPhase("importing");
    try {
      const body = await uploadBody();
      const next = await importConversationExport(user, body);
      setResult(next);
      setPreview(null);
      setPhase("done");
      await refresh();
    } catch (cause) {
      setPhase("ready");
      setError(cause.message || "The import did not finish.");
    }
  }

  async function openDetail(id) {
    setError("");
    setPendingDelete(null);
    try {
      const payload = await fetchImportedConversation(user, id);
      setDetail(payload.conversation ?? null);
      setMemories(Array.isArray(payload.memories) ? payload.memories : []);
    } catch (cause) {
      setError(cause.message || "That conversation could not be opened.");
    }
  }

  async function keepNotes() {
    if (!detail?.id) return;
    setError("");
    setNotePhase("saving");
    try {
      const payload = await retainImportedMemories(user, detail.id);
      setMemories(Array.isArray(payload.memories) ? payload.memories : []);
      setNotePhase("idle");
    } catch (cause) {
      setNotePhase("idle");
      setError(cause.message || "Durable notes could not be saved.");
    }
  }

  async function removeNote(memoryId) {
    setError("");
    try {
      await forgetImportedMemory(user, memoryId);
      setMemories((current) => current.filter((memory) => memory.id !== memoryId));
    } catch (cause) {
      setError(cause.message || "That note could not be removed.");
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setError("");
    try {
      await deleteImportedConversation(user, pendingDelete.id);
      if (detail?.id === pendingDelete.id) {
        setDetail(null);
        setMemories([]);
      }
      setPendingDelete(null);
      await refresh();
    } catch (cause) {
      setError(cause.message || "That conversation could not be deleted.");
    }
  }

  const previewCount = preview?.conversations?.length ?? 0;

  return (
    <section className="chief-external-archive" aria-label="Imported chats">
      <div className="chief-sheet-title">Imported chats</div>
      <p className="chief-sheet-copy">
        Upload a Claude or ChatGPT export. Freedom OS keeps the original transcript in your archive.
        Durable notes are a separate memory you can keep or remove. This does not change CHIEF
        conversations, and a later export does not delete anything already imported.
      </p>
      <form onSubmit={review}>
        <div className="chief-approval" role="group" aria-label="Export source">
          {PROVIDERS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`chief-action${provider === id ? "" : " chief-action--quiet"}`}
              aria-pressed={provider === id}
              onClick={() => {
                setProvider(id);
                setPreview(null);
                setResult(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="chief-sheet-copy">
          Export file
          <input
            type="file"
            accept=".json,.zip,application/json,application/zip"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setPreview(null);
              setResult(null);
              setPhase("idle");
            }}
          />
        </label>
        <div className="chief-approval">
          <button type="submit" className="chief-action" disabled={!file || phase === "previewing"}>
            {phase === "previewing" ? "Reviewing export" : "Review export"}
          </button>
        </div>
      </form>
      {error ? <p className="chief-sheet-copy">{error}</p> : null}
      {preview ? (
        <div className="chief-settings-confirm">
          <p className="chief-sheet-copy">
            {previewCount} conversation{previewCount === 1 ? "" : "s"} ready.{" "}
            {preview.counts?.failed ?? 0} record{preview.counts?.failed === 1 ? "" : "s"} will be
            skipped.
          </p>
          <ul>
            {(preview.conversations ?? []).slice(0, 20).map((conversation) => (
              <li key={conversation.externalId}>
                {conversation.title} · {conversation.messageCount} messages ·{" "}
                {formatWhen(conversation.sourceUpdatedAt || conversation.sourceCreatedAt)}
                {conversation.unsupportedCount
                  ? ` · ${conversation.unsupportedCount} with unsupported content`
                  : ""}
              </li>
            ))}
          </ul>
          {(preview.failures ?? []).length ? (
            <ul>
              {preview.failures.map((failure, index) => (
                <li key={`${failure.externalId ?? "row"}-${index}`}>
                  Failed record {failure.index ?? "unknown"}: {failure.error}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="chief-approval">
            <button
              type="button"
              className="chief-action"
              disabled={!previewCount || phase === "importing"}
              onClick={confirmImport}
            >
              {phase === "importing" ? "Importing" : "Import conversations"}
            </button>
          </div>
        </div>
      ) : null}
      {result ? (
        <div className="chief-settings-confirm">
          <p className="chief-sheet-copy">
            Imported {result.counts?.imported ?? 0}. Updated {result.counts?.updated ?? 0}.
            Duplicates {result.counts?.duplicate ?? 0}. Failed {result.counts?.failed ?? 0}.
          </p>
          {(result.failures ?? []).length ? (
            <>
              <ul>
                {result.failures.map((failure, index) => (
                  <li key={`${failure.externalId ?? "fail"}-${index}`}>
                    {failure.externalId || "Record"}: {failure.error}
                  </li>
                ))}
              </ul>
              <button type="button" className="chief-action" onClick={confirmImport}>
                Retry import
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="chief-sheet-title">Archive</div>
      {focusId && detail?.id !== focusId && focusMiss.id !== focusId ? (
        <p className="chief-sheet-copy">Opening imported conversation...</p>
      ) : null}
      {focusMiss.id === focusId && focusMiss.kind === "deleted" ? (
        <p className="chief-sheet-copy">This imported conversation was deleted.</p>
      ) : null}
      {conversations.length ? (
        <ul>
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                className="chief-action chief-action--quiet"
                onClick={() => openDetail(conversation.id)}
              >
                {conversation.provider} · {conversation.title} · {conversation.messageCount}{" "}
                messages
              </button>
              <button
                type="button"
                className="chief-action chief-action--danger"
                onClick={() => setPendingDelete(conversation)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="chief-sheet-copy">No imported conversations yet.</p>
      )}
      {pendingDelete ? (
        <div className="chief-settings-confirm">
          <p className="chief-sheet-copy">
            Delete “{pendingDelete.title}” from the archive. CHIEF conversations stay.
          </p>
          <div className="chief-approval">
            <button
              type="button"
              className="chief-action chief-action--danger"
              onClick={confirmDelete}
            >
              Delete imported conversation
            </button>
            <button
              type="button"
              className="chief-action chief-action--quiet"
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {detail ? (
        <div>
          <p className="chief-sheet-copy">
            {detail.provider} · {detail.title} · {detail.sourceUrl || "No source link"}
          </p>
          <ol>
            {(detail.messages ?? []).map((message) => (
              <li key={`${message.ordinal}-${message.externalId}`}>
                <strong>{message.role}</strong>
                {message.sourceCreatedAt ? ` · ${formatWhen(message.sourceCreatedAt)}` : ""}
                <div>{messageText(message)}</div>
              </li>
            ))}
          </ol>
          <div className="chief-approval">
            <button
              type="button"
              className="chief-action"
              disabled={notePhase === "saving"}
              onClick={keepNotes}
            >
              {notePhase === "saving" ? "Saving durable notes" : "Keep durable notes"}
            </button>
          </div>
          {memories.length ? (
            <ul>
              {memories.map((memory) => (
                <li key={memory.id}>
                  <p className="chief-sheet-copy">
                    {memory.kind} · {memory.provider} · {memory.content}
                  </p>
                  <button
                    type="button"
                    className="chief-action chief-action--quiet"
                    onClick={() => removeNote(memory.id)}
                  >
                    Remove note
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="chief-sheet-copy">No durable notes from this conversation.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function messageText(message) {
  const blocks = Array.isArray(message.blocks) ? message.blocks : [];
  const text = blocks
    .map((block) => {
      if (block.type === "text" || block.type === "thinking") return block.text;
      if (block.type === "code") return block.code;
      if (block.type === "unsupported") return block.note;
      if (block.type === "tool_use") return `Tool ${block.name || "call"}`;
      if (block.type === "tool_result") return block.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return text || "No text";
}
