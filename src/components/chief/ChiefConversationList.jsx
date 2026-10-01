import { useState } from "react";
import { conversationLabel, formatChiefTime } from "../../utils/chiefApi.js";
import { partitionSidebarConversations } from "../../utils/chiefSidebar.js";

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
        <span className="chief-convo-heading">
          <span className="chief-convo-title">{conversationLabel(session)}</span>
          <span className="chief-convo-meta">
            <span className="chief-convo-time">{formatChiefTime(session.updatedAt)}</span>
            {archived ? <span className="chief-convo-flag">Archived</span> : null}
          </span>
        </span>
        {typeof session.snippet === "string" && session.snippet ? (
          <span className="chief-convo-snippet">{session.snippet}</span>
        ) : null}
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
  query = "",
  onQueryChange,
  searchResults = [],
  searchLoading = false,
  searchError = "",
  onNewConversation,
  onSelect,
  onRetry,
  onSearchRetry,
  onRename,
  onArchive,
  onRestore,
  onDelete,
}) {
  const view = partitionSidebarConversations({
    sessions,
    archivedSessions,
    query,
    searchResults,
  });
  const listLoading = view.searching ? searchLoading : isLoading;
  const listError = view.searching ? searchError : error;
  const retry = view.searching ? onSearchRetry : onRetry;

  return (
    <div className="chief-convo-list">
      <h2 className="chief-sr">Conversations</h2>
      <label className="chief-nav-search">
        <span className="chief-sr">Search conversations</span>
        <input
          type="search"
          value={query}
          maxLength={200}
          placeholder="Search conversations..."
          aria-label="Search conversations"
          onChange={(event) => onQueryChange?.(event.target.value)}
        />
      </label>
      <div className="chief-convo-scroll">
        {listLoading ? (
          <div className="chief-sheet-copy">
            {view.searching ? "Searching..." : "Loading conversations..."}
          </div>
        ) : null}
        {listError ? (
          <div className="chief-convo-error-block">
            <div className="chief-convo-error">{listError}</div>
            <button type="button" className="chief-action chief-action--quiet" onClick={retry}>
              Retry
            </button>
          </div>
        ) : null}
        {!listLoading && !listError && view.emptyLabel ? (
          <div className="chief-sheet-copy">{view.emptyLabel}</div>
        ) : null}
        {view.recent.length > 0 ? (
          <div className="chief-convo-group">
            <div className="chief-sheet-title">Recent</div>
            {view.recent.map((session) => (
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
        ) : null}
        {view.archived.length > 0 ? (
          <div className="chief-convo-group">
            <div className="chief-sheet-title">Archived</div>
            {view.archived.map((session) => (
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
      <button
        type="button"
        className="chief-action chief-nav-new"
        onClick={onNewConversation}
        disabled={disabled}
      >
        + New Conversation
      </button>
    </div>
  );
}
