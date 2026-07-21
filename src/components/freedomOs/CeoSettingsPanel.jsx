import { useState } from "react";
import { styles } from "../../styles.js";
import { updateCeoAgent } from "../../utils/agentsApi.js";
import { CEO_AVATAR_PRESETS } from "../../data/ceoAvatars.js";
import { describeAgentApiError, fosStyles, PERSONALITY_PRESETS } from "./freedomOsShared.js";

// CEO Agent settings: name, personality preset, avatar preset. Personality is
// preset-only by contract — there is deliberately no free-text field here.

export function CeoSettingsPanel({ ceoAgent, user, onBack, onSaved, onOpenProfile }) {
  const [name, setName] = useState(ceoAgent?.name || "CEO Agent");
  const [personalityPreset, setPersonalityPreset] = useState(
    ceoAgent?.personalityPreset || "DIRECT_EFFICIENT"
  );
  const [avatarKey, setAvatarKey] = useState(ceoAgent?.avatarKey || CEO_AVATAR_PRESETS[0].key);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedAt, setSavedAt] = useState(null);

  const isDirty =
    name.trim() !== (ceoAgent?.name || "CEO Agent") ||
    personalityPreset !== (ceoAgent?.personalityPreset || "DIRECT_EFFICIENT") ||
    avatarKey !== (ceoAgent?.avatarKey || CEO_AVATAR_PRESETS[0].key);

  const handleSave = async () => {
    if (isSaving) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setSaveError("The CEO Agent needs a name.");
      return;
    }
    setIsSaving(true);
    setSaveError("");
    try {
      const payload = await updateCeoAgent(
        { name: trimmedName, personalityPreset, avatarKey },
        { user }
      );
      if (payload?.ceoAgent) onSaved?.(payload.ceoAgent);
      setSavedAt(Date.now());
    } catch (error) {
      setSaveError(describeAgentApiError(error, "Settings could not be saved."));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div style={{ ...styles.panel, padding: 24, display: "grid", gap: 22, maxWidth: 720 }}>
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
          ← Back to Freedom OS
        </button>
        <h2 style={{ margin: "12px 0 0", color: "white", fontSize: 24, fontWeight: 800 }}>
          CEO Agent settings
        </h2>
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <div style={fosStyles.sectionLabel}>Name</div>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          style={{ ...fosStyles.input, maxWidth: 380 }}
        />
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <div style={fosStyles.sectionLabel}>Personality</div>
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
          {PERSONALITY_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => setPersonalityPreset(preset.value)}
              style={{
                textAlign: "left",
                borderRadius: 12,
                padding: "14px 16px",
                cursor: "pointer",
                border:
                  personalityPreset === preset.value
                    ? "1px solid rgba(120,220,255,.6)"
                    : "1px solid rgba(0,216,255,.16)",
                background:
                  personalityPreset === preset.value
                    ? "linear-gradient(180deg, rgba(0,119,255,.24), rgba(0,216,255,.10))"
                    : "rgba(0,136,255,.05)",
                color: "#eef6ff",
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 13 }}>{preset.label}</div>
              <div style={{ color: "#9fb0c9", fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                {preset.description}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <div style={fosStyles.sectionLabel}>Avatar</div>
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))" }}>
          {CEO_AVATAR_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => setAvatarKey(preset.key)}
              aria-label={`Avatar: ${preset.label}`}
              style={{
                borderRadius: 12,
                padding: "10px 6px",
                cursor: "pointer",
                display: "grid",
                gap: 6,
                placeItems: "center",
                border:
                  avatarKey === preset.key
                    ? "1px solid rgba(120,220,255,.65)"
                    : "1px solid rgba(0,216,255,.14)",
                background:
                  avatarKey === preset.key
                    ? "linear-gradient(180deg, rgba(0,119,255,.26), rgba(0,216,255,.12))"
                    : "rgba(0,136,255,.05)",
              }}
            >
              <span
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  fontSize: 20,
                  background: `${preset.color}26`,
                  border: `1px solid ${preset.color}66`,
                }}
              >
                {preset.emoji}
              </span>
              <span style={{ color: "#cfe6ff", fontSize: 10, fontWeight: 700 }}>{preset.label}</span>
            </button>
          ))}
        </div>
      </div>

      {saveError ? <div style={fosStyles.errorBox}>{saveError}</div> : null}

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          style={{
            ...fosStyles.primaryButton,
            opacity: !isDirty || isSaving ? 0.55 : 1,
            cursor: !isDirty || isSaving ? "default" : "pointer",
          }}
          disabled={!isDirty || isSaving}
          onClick={() => void handleSave()}
        >
          {isSaving ? "Saving…" : "Save settings"}
        </button>
        {savedAt && !isDirty ? (
          <span style={{ color: "#7cf1af", fontSize: 12, fontWeight: 700 }}>Saved</span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button type="button" style={fosStyles.secondaryButton} onClick={onOpenProfile}>
          Profile →
        </button>
      </div>
    </div>
  );
}
