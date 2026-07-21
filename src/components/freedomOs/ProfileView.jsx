import { useEffect, useState } from "react";
import { styles } from "../../styles.js";
import {
  deleteCeoDocument,
  fetchCeoProfile,
  generateCeoNarrativeProfile,
  updateCeoProfile,
  uploadCeoDocuments,
} from "../../utils/agentsApi.js";
import {
  MAX_DOC_SIZE_BYTES,
  MAX_UPLOAD_DOCS,
  CEO_DOCUMENT_ACCEPT,
  readCeoDocumentFiles,
} from "../../utils/ceoDocumentFiles.js";
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
      onChanged(payload);
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
  const [onboardingSummary, setOnboardingSummary] = useState(null);
  const [narrativeProfile, setNarrativeProfile] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [isGeneratingNarrative, setIsGeneratingNarrative] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const payload = await fetchCeoProfile({ user });
        if (cancelled) return;
        setProfile(payload?.profile || null);
        setOnboardingSummary(payload?.onboardingSummary || null);
        setNarrativeProfile(payload?.narrativeProfile || null);
        setDocuments(Array.isArray(payload?.documents) ? payload.documents : []);
        setLoadError("");
      } catch (error) {
        if (!cancelled) {
          setLoadError(describeAgentApiError(error, "Unable to load the profile."));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, reloadToken]);

  const applyPayload = (payload) => {
    if (!payload) return;
    if (payload.profile) setProfile(payload.profile);
    if (payload.onboardingSummary) setOnboardingSummary(payload.onboardingSummary);
    if (payload.narrativeProfile) setNarrativeProfile(payload.narrativeProfile);
    if (Array.isArray(payload.documents)) setDocuments(payload.documents);
  };

  const handleGenerateNarrative = async () => {
    setActionError("");
    setIsGeneratingNarrative(true);
    try {
      const payload = await generateCeoNarrativeProfile({ user });
      if (payload?.narrativeProfile) {
        setNarrativeProfile(payload.narrativeProfile);
      }
    } catch (error) {
      setActionError(
        describeAgentApiError(error, "Your CEO Agent could not write the profile right now.")
      );
    } finally {
      setIsGeneratingNarrative(false);
    }
  };

  const handleUpload = async (fileList) => {
    setActionError("");
    setIsUploading(true);
    try {
      const files = Array.from(fileList || []);
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
      const payload = await uploadCeoDocuments(valid, { user });
      setDocuments((current) => [...(payload?.documents || []), ...current]);
    } catch (error) {
      setActionError(describeAgentApiError(error, "Document upload failed."));
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteDocument = async (documentId) => {
    setActionError("");
    try {
      await deleteCeoDocument(documentId, { user });
      setDocuments((current) => current.filter((doc) => doc.id !== documentId));
    } catch (error) {
      setActionError(describeAgentApiError(error, "Could not delete that document."));
    }
  };

  const categories = profile?.categories || {};
  const hasEntries = Object.values(categories).some((entries) => entries?.length);
  const summaryText = onboardingSummary?.summary;
  const narrativeText = narrativeProfile?.profile;
  const narrativeGeneratedAt = narrativeProfile?.generatedAt;

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
          Edit anything that&apos;s off, or delete it for good — deleted entries can never be re-added by
          an agent.
        </p>
      </div>

      {actionError ? <div style={fosStyles.errorBox}>{actionError}</div> : null}
      {loadError ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={fosStyles.errorBox}>{loadError}</div>
          <button
            type="button"
            style={fosStyles.secondaryButton}
            onClick={() => {
              setIsLoading(true);
              setLoadError("");
              setReloadToken((current) => current + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      {isLoading ? <div style={{ color: "#8faecc", fontSize: 13 }}>Loading profile…</div> : null}

      {!isLoading && !loadError && summaryText ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={fosStyles.sectionLabel}>Profile summary</div>
          <div
            style={{
              borderRadius: 12,
              border: "1px solid rgba(0,216,255,.22)",
              background: "rgba(3,17,32,.72)",
              padding: "14px 16px",
              color: "#d7ebff",
              fontSize: 13,
              lineHeight: 1.7,
              whiteSpace: "pre-wrap",
            }}
          >
            {summaryText}
          </div>
        </div>
      ) : null}

      {!isLoading && !loadError ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={fosStyles.sectionLabel}>Your profile</div>
          <p style={{ margin: 0, color: "#9fb0c9", fontSize: 12, lineHeight: 1.55 }}>
            A longer newsletter-style write-up from your CEO Agent, built from what it knows about
            you, your chats, and the agents you&apos;ve created.
          </p>
          {narrativeText ? (
            <>
              <div
                style={{
                  borderRadius: 12,
                  border: "1px solid rgba(0,216,255,.22)",
                  background: "rgba(3,17,32,.72)",
                  padding: "14px 16px",
                  color: "#d7ebff",
                  fontSize: 13,
                  lineHeight: 1.75,
                  whiteSpace: "pre-wrap",
                }}
              >
                {narrativeText}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={{
                    ...fosStyles.secondaryButton,
                    opacity: isGeneratingNarrative ? 0.6 : 1,
                  }}
                  disabled={isGeneratingNarrative}
                  onClick={() => void handleGenerateNarrative()}
                >
                  {isGeneratingNarrative ? "Refreshing…" : "Refresh Profile"}
                </button>
                {narrativeGeneratedAt ? (
                  <span style={{ color: "#5f7896", fontSize: 11 }}>
                    Updated {formatRelativeTime(narrativeGeneratedAt)}
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <button
              type="button"
              style={{
                ...fosStyles.primaryButton,
                width: "fit-content",
                opacity: isGeneratingNarrative ? 0.6 : 1,
              }}
              disabled={isGeneratingNarrative}
              onClick={() => void handleGenerateNarrative()}
            >
              {isGeneratingNarrative ? "Writing your profile…" : "Read your Profile"}
            </button>
          )}
        </div>
      ) : null}

      {!isLoading && !loadError ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={fosStyles.sectionLabel}>Reference documents</div>
          <p style={{ margin: 0, color: "#9fb0c9", fontSize: 12, lineHeight: 1.55 }}>
            Files your CEO Agent can read in chat (.txt, .md, .csv, .json, .pdf,
            .docx, .xlsx, .pptx) — up to {MAX_UPLOAD_DOCS} files,{" "}
            {MAX_DOC_SIZE_BYTES / 1024} KB each. No character limit.
          </p>
          <label
            style={{
              ...fosStyles.secondaryButton,
              display: "inline-flex",
              width: "fit-content",
              cursor: isUploading ? "default" : "pointer",
              opacity: isUploading ? 0.6 : 1,
            }}
          >
            {isUploading ? "Uploading…" : "Upload documents"}
            <input
              type="file"
              accept={CEO_DOCUMENT_ACCEPT}
              multiple
              disabled={isUploading}
              style={{ display: "none" }}
              onChange={(event) => {
                const input = event.target;
                void handleUpload(input.files).finally(() => {
                  input.value = "";
                });
              }}
            />
          </label>
          {documents.length ? (
            <div style={{ display: "grid", gap: 8 }}>
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    alignItems: "center",
                    borderRadius: 10,
                    border: "1px solid rgba(0,216,255,.16)",
                    background: "rgba(0,136,255,.05)",
                    padding: "10px 12px",
                    color: "#dff7ff",
                    fontSize: 13,
                  }}
                >
                  <span>
                    {doc.filename}{" "}
                    <span style={{ color: "#5f7896" }}>
                      ({Math.round((doc.sizeBytes || 0) / 1024)} KB)
                    </span>
                  </span>
                  <button
                    type="button"
                    style={{ ...fosStyles.subtleButton, color: "#ff9db0", borderColor: "rgba(255,93,122,.3)" }}
                    onClick={() => void handleDeleteDocument(doc.id)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: "#8faecc", fontSize: 13 }}>No documents uploaded yet.</div>
          )}
        </div>
      ) : null}

      {!isLoading && !loadError && !hasEntries ? (
        <div style={{ color: "#8faecc", fontSize: 13, lineHeight: 1.6 }}>
          Nothing in the detailed profile yet — complete onboarding or chat with your agents and this
          fills in automatically.
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
                onChanged={(payload) => {
                  setActionError("");
                  applyPayload(payload);
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
