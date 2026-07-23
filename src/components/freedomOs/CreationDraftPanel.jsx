import { fosStyles } from "./freedomOsShared.js";

function DraftField({ label, value, guessed }) {
  const text = String(value || "").trim();
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div
        style={{
          color: "#7f96b3",
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: 0.8,
          textTransform: "uppercase",
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <span>{label}</span>
        {guessed ? (
          <span style={{ color: "#f0c674", fontWeight: 700, letterSpacing: 0.4 }}>guessed</span>
        ) : null}
      </div>
      <div
        style={{
          color: text ? "#e8f1ff" : "#5f7390",
          fontSize: 13,
          lineHeight: 1.45,
          whiteSpace: "pre-wrap",
        }}
      >
        {text || "—"}
      </div>
    </div>
  );
}

export function CreationDraftPanel({ draft }) {
  // Draft sections stay closed until the interview is finished (or skipped).
  if (!draft || draft.phase !== "review") return null;

  const guessed = new Set(Array.isArray(draft.guessedFields) ? draft.guessedFields : []);

  return (
    <div
      style={{
        borderRadius: 14,
        border: "1px solid rgba(0,216,255,.16)",
        background: "rgba(0,136,255,.05)",
        padding: "12px 14px",
        display: "grid",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
        <div>
          <div style={fosStyles.sectionLabel}>Agent draft</div>
          <div style={{ color: "white", fontWeight: 800, fontSize: 14, marginTop: 2 }}>
            Review before creating
            {draft.readyForReview ? " · ready to confirm" : ""}
          </div>
        </div>
        {draft.agentType ? (
          <div style={{ color: "#9fb0c9", fontSize: 12, fontWeight: 700 }}>{draft.agentType}</div>
        ) : null}
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <DraftField
          label="Name & role"
          value={[draft.name, draft.roleLine].filter(Boolean).join(" — ")}
          guessed={guessed.has("name") || guessed.has("roleLine")}
        />
        <DraftField
          label="Outcome"
          value={draft.definitionOfDone}
          guessed={guessed.has("definitionOfDone") || guessed.has("outcome")}
        />
        <DraftField
          label="Acts with / for"
          value={draft.actorsNotes}
          guessed={guessed.has("actorsNotes") || guessed.has("actors")}
        />
        <DraftField
          label="Personality"
          value={draft.personalityNotes}
          guessed={guessed.has("personalityNotes") || guessed.has("tone")}
        />
        <DraftField
          label="Will never"
          value={draft.boundaries}
          guessed={guessed.has("boundaries")}
        />
        <DraftField
          label="Working from"
          value={draft.workingFromNotes}
          guessed={guessed.has("workingFromNotes") || guessed.has("history")}
        />
        <DraftField
          label="Escalation"
          value={draft.escalationNotes}
          guessed={guessed.has("escalationNotes") || guessed.has("escalation")}
        />
      </div>
    </div>
  );
}
