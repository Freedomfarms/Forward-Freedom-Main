import { useEffect, useState } from "react";
import { styles } from "../../styles.js";
import { fetchCeoProfile, updateCeoProfile } from "../../utils/agentsApi.js";
import { describeAgentApiError, formatRelativeTime, fosStyles } from "./freedomOsShared.js";

// "What your CEO Agent knows about you" — the living profile. Entries are
// grouped by category; edits PATCH an update op, deletes PATCH a delete op
// (tombstoned server-side so agents can never re-add what you removed).

const CATEGORY_LABELS = {
  financialGoals: "Financial goals",
  knownAccountsRelationships: "Known accounts & relationships",
  statedPreferences: "Stated preferences",
  recurringConcerns: "Recurring concerns",
  lifeContext: "Life context",
};

function sourceBadge(source) {
  const label =
    source === "onboarding" ? "Onboarding" : source === "user_edit" ? "Your edit" : source || "Agent";
  const isUser = source === "onboarding" || source === "user_edit";
  return (
    <span
      style={{
        ...fosStyles.badge,
        border: isUser ? "1px solid rgba(0,216,255,.3)" : "1px solid rgba(168,85,247,.35)",
        background: isUser ? "rgba(0,136,255,.10)" : "rgba(168,85,247,.10)",
        color: isUser ? "#8feaff" : "#d8b4fe",
      }}
    >
      {label}
    </span>
  );
}

function ProfileEntry({ entry, category, user, onChanged, onError }) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [isBusy, setIsBusy] = useState(false);

  const submitOps = async (ops) => {
    setIsBusy(true);
    try {
      const payload = await updateCeoProfile(ops, { user });
      onChanged(payload?.profile || null);
      setIsEditing(false);
    } catch (error) {
      onError(describeAgentApiError(error, "The profile change could not be saved."));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div
      style={{
        borderRadius: 12,
        border: "1px solid rgba(30,144,255,.18)",
        background: "rgba(3,17,32,.6)",
        padding: "12px 14px",
        display: "grid",
        gap: 8,
      }}
    >
      {isEditing ? (
        <>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
            maxLength={500}
            style={{ ...fosStyles.input, resize: "vertical", fontFamily: styles.page.fontFamily }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              style={{ ...fosStyles.secondaryButton, opacity: isBusy || !draft.trim() ? 0.55 : 1 }}
              disabled={isBusy || !draft.trim()}
              onClick={() =>
                void submitOps([{ action: "update", id: entry.id, category, text: draft.trim() }])
              }
            >
              {isBusy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              style={fosStyles.subtleButton}
              disabled={isBusy}
              onClick={() => {
                setDraft(entry.text);
                setIsEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ color: "#d7ebff", fontSize: 13, lineHeight: 1.6 }}>{entry.text}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {sourceBadge(entry.source)}
            <span style={{ color: "#5f7896", fontSize: 11 }}>
              {formatRelativeTime(entry.updatedAt || entry.addedAt)}
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={fosStyles.subtleButton}
              disabled={isBusy}
              onClick={() => setIsEditing(true)}
            >
              Edit
            </button>
            <button
              type="button"
              style={{ ...fosStyles.subtleButton, color: "#ff9db0", borderColor: "rgba(255,93,122,.3)" }}
              disabled={isBusy}
              onClick={() => void submitOps([{ action: "delete", id: entry.id }])}
            >
              {isBusy ? "…" : "Delete"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ProfileView({ user, onBack }) {
  const [profile, setProfile] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      try {
        const payload = await fetchCeoProfile({ user });
        if (!cancelled) {
          setProfile(payload?.profile || null);
          setLoadError("");
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(describeAgentApiError(error, "Unable to load the profile."));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const categories = profile?.categories || {};
  const hasEntries = Object.values(categories).some((entries) => entries?.length);

  return (
    <div style={{ ...styles.panel, padding: 24, display: "grid", gap: 20 }}>
      <div>
        <button
          type="button"
          onClick={onBack}
          style={{
            border: "none",
            background: "transparent",
            color: "#8feaff",
            cursor: "pointer",
            fontWeight: 800,
            fontSize: 13,
            padding: 0,
          }}
        >
          ← Back
        </button>
        <h2 style={{ margin: "12px 0 0", color: "white", fontSize: 24, fontWeight: 800 }}>
          What your CEO Agent knows about you
        </h2>
        <p style={{ margin: "8px 0 0", color: "#9fb0c9", fontSize: 13, lineHeight: 1.6 }}>
          Edit anything that's off, or delete it for good — deleted entries can never be re-added by
          an agent.
        </p>
      </div>

      {actionError ? <div style={fosStyles.errorBox}>{actionError}</div> : null}
      {loadError ? <div style={fosStyles.errorBox}>{loadError}</div> : null}
      {isLoading ? <div style={{ color: "#8faecc", fontSize: 13 }}>Loading profile…</div> : null}

      {!isLoading && !loadError && !hasEntries ? (
        <div style={{ color: "#8faecc", fontSize: 13, lineHeight: 1.6 }}>
          Nothing here yet — complete onboarding or chat with your agents and this profile fills in
          automatically.
        </div>
      ) : null}

      {Object.entries(CATEGORY_LABELS).map(([category, label]) => {
        const entries = categories[category] || [];
        if (!entries.length) return null;
        return (
          <div key={category} style={{ display: "grid", gap: 10 }}>
            <div style={fosStyles.sectionLabel}>{label}</div>
            {entries.map((entry) => (
              <ProfileEntry
                key={entry.id}
                entry={entry}
                category={category}
                user={user}
                onChanged={(nextProfile) => {
                  setActionError("");
                  if (nextProfile) setProfile(nextProfile);
                }}
                onError={setActionError}
              />
            ))}
          </div>
        );
      })}

      <div
        style={{
          borderTop: "1px solid rgba(0,216,255,.12)",
          paddingTop: 14,
          color: "#8faecc",
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        Your agents update this automatically when they learn something new about you.
      </div>
    </div>
  );
}
