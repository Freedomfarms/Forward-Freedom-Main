import { useState } from "react";
import { conversationLabel, formatChiefTime } from "../../utils/chiefApi.js";

function ConversationRow({
  session,
  active,
  disabled,
  archived = false,
  onSelect,
  onRename,
  onArchive,
  onRestore,
  onDelete,
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(action) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(actionError?.message || "CHIEF could not complete that request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={active ? "chief-convo is-active" : "chief-convo"}>
      <button
        type="button"
        className="chief-convo-open"
        onClick={() => onSelect(session.sessionId)}
        disabled={disabled || busy}
        aria-current={active ? "true" : undefined}
      >
        <span className="chief-convo-title">{conversationLabel(session)}</span>
        <span className="chief-convo-time">{formatChiefTime(session.updatedAt)}</span>
      </button>
      {renaming ? (
        <form
          className="chief-convo-rename"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await onRename(session.sessionId, draft);
              setRenaming(false);
            });
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={80}
            aria-label="Conversation title"
            disabled={busy}
          />
          <button type="submit" disabled={busy || !draft.trim()}>
            Save
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setRenaming(false);
              setError("");
            }}
          >
            Cancel
          </button>
        </form>
      ) : null}
      {confirming ? (
        <div className="chief-convo-confirm">
          <p>Delete this conversation? This removes it. Archive only hides it.</p>
          <button
            type="button"
            className="chief-action chief-action--danger"
            disabled={busy}
            onClick={() => void run(() => onDelete(session.sessionId))}
          >
            Delete
          </button>
          <button
            type="button"
            className="chief-action chief-action--quiet"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="chief-convo-actions">
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => {
              setDraft(typeof session.title === "string" ? session.title : "");
              setRenaming(true);
              setConfirming(false);
            }}
          >
            Rename
          </button>
          {archived ? (
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => void run(() => onRestore(session.sessionId))}
            >
              Restore
            </button>
          ) : (
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => void run(() => onArchive(session.sessionId))}
            >
              Archive
            </button>
          )}
          <button
            type="button"
            className="chief-convo-delete"
            disabled={disabled || busy}
            onClick={() => {
              setConfirming(true);
              setRenaming(false);
            }}
          >
            Delete
          </button>
        </div>
      )}
      {error ? <p className="chief-convo-error">{error}</p> : null}
    </div>
  );
}

export function ChiefConversationList({
  sessions = [],
  archivedSessions = [],
  activeSessionId = null,
  isLoading = false,
  error = "",
  disabled = false,
  onNewConversation,
  onSelect,
  onRetry,
  onRename,
  onArchive,
  onRestore,
  onDelete,
}) {
  return (
    <div className="chief-convo-list">
      <div className="chief-sheet-title">Your conversations</div>
      <p className="chief-sheet-copy">CHIEF conversations for this signed-in account.</p>
      <button
        type="button"
        className="chief-action"
        onClick={onNewConversation}
        disabled={disabled}
      >
        New conversation
      </button>
      {isLoading ? <div className="chief-sheet-copy">Loading conversations...</div> : null}
      {error ? (
        <div className="chief-convo-error-block">
          <div className="chief-convo-error">{error}</div>
          <button type="button" className="chief-action chief-action--quiet" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}
      {!isLoading && !error && sessions.length === 0 ? (
        <div className="chief-sheet-copy">No conversations yet.</div>
      ) : null}
      <div className="chief-convo-group">
        {sessions.map((session) => (
          <ConversationRow
            key={session.sessionId}
            session={session}
            active={session.sessionId === activeSessionId}
            disabled={disabled}
            onSelect={onSelect}
            onRename={onRename}
            onArchive={onArchive}
            onRestore={onRestore}
            onDelete={onDelete}
          />
        ))}
      </div>
      {archivedSessions.length > 0 ? (
        <div className="chief-convo-group">
          <div className="chief-sheet-title">Archived</div>
          {archivedSessions.map((session) => (
            <ConversationRow
              key={session.sessionId}
              session={session}
              archived
              active={session.sessionId === activeSessionId}
              disabled={disabled}
              onSelect={onSelect}
              onRename={onRename}
              onArchive={onArchive}
              onRestore={onRestore}
              onDelete={onDelete}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
