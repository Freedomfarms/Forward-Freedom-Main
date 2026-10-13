import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { conversationLabel } from "../../utils/chiefProtocol.js";
import {
  CONVERSATION_FILTERS,
  buildConversationView,
  conversationProviderLabel,
  conversationWhen,
} from "../../utils/chiefConversationWorkspace.js";

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}

function ConversationMenu({
  session,
  archived,
  disabled,
  busy,
  onRename,
  onArchive,
  onRestore,
  onDelete,
  onClose,
}) {
  const [confirming, setConfirming] = useState(false);
  const title = conversationLabel(session);

  if (confirming) {
    return (
      <div className="chief-workspace-confirm" role="alertdialog" aria-label={`Delete ${title}`}>
        <p>Delete “{title}”? This removes the conversation.</p>
        <div className="chief-workspace-confirm-actions">
          <button
            type="button"
            className="chief-workspace-menu-danger"
            disabled={disabled || busy}
            onClick={() => onDelete(session.sessionId)}
          >
            Delete
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div role="menu" aria-label={`Actions for ${title}`}>
      <button
        type="button"
        role="menuitem"
        disabled={disabled || busy}
        onClick={() => {
          onRename();
          onClose();
        }}
      >
        Rename
      </button>
      {archived ? (
        <button
          type="button"
          role="menuitem"
          disabled={disabled || busy}
          onClick={() => {
            onRestore(session.sessionId);
            onClose();
          }}
        >
          Restore
        </button>
      ) : (
        <button
          type="button"
          role="menuitem"
          disabled={disabled || busy}
          onClick={() => {
            onArchive(session.sessionId);
            onClose();
          }}
        >
          Archive
        </button>
      )}
      <div className="chief-workspace-menu-rule" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="chief-workspace-menu-danger"
        disabled={disabled || busy}
        onClick={() => setConfirming(true)}
      >
        Delete
      </button>
    </div>
  );
}

function ConversationRow({
  session,
  active,
  archived = false,
  disabled,
  now,
  onSelect,
  onRename,
  onArchive,
  onRestore,
  onDelete,
}) {
  const menuId = useId();
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title = conversationLabel(session);
  const when = conversationWhen(session, now);
  const imported = session.provider === "claude" || session.provider === "chatgpt";
  const providerLabel = conversationProviderLabel(session.provider);

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

  function placeMenu() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 220;
    const estimated = 168;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const below = rect.bottom + 6;
    const top =
      below + estimated > window.innerHeight - 8 ? Math.max(8, rect.top - estimated - 6) : below;
    setMenuStyle({ top, left, width });
  }

  useEffect(() => {
    if (!menuOpen) return undefined;
    function onPointer(event) {
      if (menuRef.current?.contains(event.target) || buttonRef.current?.contains(event.target))
        return;
      setMenuOpen(false);
    }
    function onKey(event) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      buttonRef.current?.focus();
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const first = menuRef.current?.querySelector("button");
    first?.focus();
    return undefined;
  }, [menuOpen]);

  const menu =
    menuOpen && menuStyle && typeof document !== "undefined"
      ? createPortal(
          <div ref={menuRef} id={menuId} className="chief-workspace-menu" style={menuStyle}>
            <ConversationMenu
              session={session}
              archived={archived}
              disabled={disabled}
              busy={busy}
              onClose={() => setMenuOpen(false)}
              onRename={() => {
                setDraft(typeof session.title === "string" ? session.title : "");
                setRenaming(true);
                setError("");
              }}
              onArchive={(sessionId) => void run(() => onArchive(sessionId))}
              onRestore={(sessionId) => void run(() => onRestore(sessionId))}
              onDelete={(sessionId) => void run(() => onDelete(sessionId))}
            />
          </div>,
          document.body
        )
      : null;

  return (
    <div
      className={active ? "chief-workspace-row is-active" : "chief-workspace-row"}
      role="listitem"
      data-session-id={session.sessionId}
    >
      {renaming ? (
        <form
          className="chief-workspace-rename"
          onSubmit={(event) => {
            event.preventDefault();
            const next = draft.trim();
            if (!next || busy) return;
            void run(async () => {
              await onRename(session.sessionId, next);
              setRenaming(false);
            });
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              setRenaming(false);
              setError("");
            }}
            maxLength={80}
            aria-label="Conversation title"
            disabled={busy}
            autoFocus
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
      ) : (
        <button
          type="button"
          className="chief-workspace-open"
          onClick={() => onSelect(session.sessionId)}
          disabled={disabled || busy}
          aria-current={active ? "true" : undefined}
        >
          <span className="chief-workspace-title">{title}</span>
          <span className="chief-workspace-meta">
            {providerLabel ? <span className="chief-workspace-flag">{providerLabel}</span> : null}
            {when ? (
              <time dateTime={session.updatedAt || session.createdAt || undefined}>{when}</time>
            ) : null}
            {archived ? <span className="chief-workspace-flag">Archived</span> : null}
          </span>
          {typeof session.snippet === "string" && session.snippet ? (
            <span className="chief-workspace-snippet">
              {session.snippetKind === "projection" ? "Search match. " : ""}
              {session.snippet}
            </span>
          ) : null}
        </button>
      )}
      {renaming || imported ? null : (
        <button
          ref={buttonRef}
          type="button"
          className="chief-workspace-more"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          aria-label={`Actions for ${title}`}
          disabled={disabled || busy}
          onClick={() => {
            placeMenu();
            setMenuOpen((open) => !open);
          }}
        >
          <MoreIcon />
        </button>
      )}
      {menu}
      {error ? (
        <p className="chief-workspace-error" role="alert">
          {error}
        </p>
      ) : null}
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
  searchAutoFocus = false,
  now,
  detail = null,
  accessLabel = "",
  onOpenAccess,
  onSignOut,
  signedIn = true,
}) {
  const [filter, setFilter] = useState("all");
  const view = buildConversationView({
    sessions,
    archivedSessions,
    query,
    searchResults,
    filter,
    now,
  });
  const listLoading = view.searching ? searchLoading : isLoading;
  const listError = view.searching ? searchError : error;
  const retry = view.searching ? onSearchRetry : onRetry;
  const known = [...sessions, ...archivedSessions, ...searchResults];
  const activeSession = known.find((session) => session?.sessionId === activeSessionId) || null;

  function onListKeyDown(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...event.currentTarget.querySelectorAll(".chief-workspace-open")];
    const index = rows.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = rows[event.key === "ArrowDown" ? index + 1 : index - 1];
    next?.focus();
  }

  function onFilterKeyDown(event) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = CONVERSATION_FILTERS.findIndex((item) => item.id === filter);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + step + CONVERSATION_FILTERS.length) % CONVERSATION_FILTERS.length;
    const next = CONVERSATION_FILTERS[nextIndex];
    setFilter(next.id);
    const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
    tabs[nextIndex]?.focus();
  }

  return (
    <section className="chief-workspace" aria-label="Conversations">
      <header className="chief-workspace-head">
        <div className="chief-workspace-heading">
          <p className="chief-workspace-kicker">Sessions</p>
          <h2>Conversations</h2>
          <p className="chief-workspace-count">
            {listLoading
              ? view.searching
                ? "Searching"
                : "Loading"
              : `${view.count} ${view.count === 1 ? "conversation" : "conversations"}`}
          </p>
        </div>
        <div className="chief-workspace-head-actions">
          {onOpenAccess ? (
            <button type="button" className="chief-workspace-access" onClick={onOpenAccess}>
              {accessLabel || "Access"}
            </button>
          ) : null}
          {onSignOut ? (
            <button type="button" className="chief-workspace-access" onClick={onSignOut}>
              Sign out
            </button>
          ) : null}
          <button
            type="button"
            className="chief-workspace-new"
            onClick={onNewConversation}
            disabled={disabled || !signedIn}
          >
            New conversation
          </button>
        </div>
      </header>

      <div className="chief-workspace-tools">
        <label className="chief-workspace-search">
          <span className="chief-sr">Search conversations</span>
          <input
            type="search"
            value={query}
            maxLength={200}
            placeholder="Search titles and messages"
            aria-label="Search conversations"
            autoFocus={searchAutoFocus}
            onChange={(event) => onQueryChange?.(event.target.value)}
          />
        </label>
        <div
          className="chief-workspace-filters"
          role="tablist"
          aria-label="Conversation views"
          onKeyDown={onFilterKeyDown}
        >
          {CONVERSATION_FILTERS.map((item) => {
            const selected = filter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={selected ? "is-selected" : undefined}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="chief-workspace-body">
        <div
          className="chief-workspace-scroll"
          role="region"
          aria-label="Conversation list"
          onKeyDown={onListKeyDown}
        >
          {listLoading ? (
            <p className="chief-workspace-status">
              {view.searching ? "Searching conversations..." : "Loading conversations..."}
            </p>
          ) : null}
          {listError ? (
            <div className="chief-workspace-error-block">
              <p className="chief-workspace-error" role="alert">
                {listError}
              </p>
              <button type="button" className="chief-workspace-quiet" onClick={retry}>
                Retry
              </button>
            </div>
          ) : null}
          {!listLoading && !listError && view.emptyLabel ? (
            <p className="chief-workspace-status">{view.emptyLabel}</p>
          ) : null}
          {view.groups.map((group) => (
            <section key={group.id} className="chief-workspace-group" aria-label={group.label}>
              <h3>{group.label}</h3>
              <div role="list">
                {group.sessions.map((session) => (
                  <ConversationRow
                    key={session.sessionId}
                    session={session}
                    archived={view.filter === "archived" || Boolean(session.archived)}
                    active={session.sessionId === activeSessionId}
                    disabled={disabled}
                    now={now}
                    onSelect={onSelect}
                    onRename={onRename}
                    onArchive={onArchive}
                    onRestore={onRestore}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>

        <aside className="chief-workspace-detail" aria-label="Selected conversation">
          <div className="chief-workspace-detail-head">
            <p>{activeSession ? conversationLabel(activeSession) : "No conversation selected"}</p>
            {activeSession?.updatedAt ? (
              <time dateTime={activeSession.updatedAt}>{conversationWhen(activeSession, now)}</time>
            ) : null}
          </div>
          <div className="chief-workspace-detail-body">
            {detail || (
              <p className="chief-workspace-status">
                {signedIn
                  ? "Select a conversation, or start a new one. The thread stays on this session."
                  : "Sign in to talk with CHIEF."}
              </p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
