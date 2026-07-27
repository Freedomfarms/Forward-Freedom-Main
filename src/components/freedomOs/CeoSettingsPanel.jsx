import { useEffect, useState } from "react";
import { styles } from "../../styles.js";
import { updateCeoAgent } from "../../utils/agentsApi.js";
import {
  detectBrowserTimeZone,
  fetchAuthenticatedUserProfile,
  updateUserTimezone,
} from "../../utils/api.js";
import { CEO_AVATAR_PRESETS } from "../../data/ceoAvatars.js";
import { ModelPicker } from "./ModelPicker.jsx";
import {
  DEFAULT_AGENT_MODEL,
  describeAgentApiError,
  fosStyles,
  PERSONALITY_PRESETS,
} from "./freedomOsShared.js";

// CEO Agent settings: name, personality, avatar, model, and the default model
// for newly created sub-agents. Personality is preset-only by contract.

export function CeoSettingsPanel({ ceoAgent, user, onBack, onSaved, onOpenProfile }) {
  const [name, setName] = useState(ceoAgent?.name || "CEO Agent");
  const [personalityPreset, setPersonalityPreset] = useState(
    ceoAgent?.personalityPreset || "DIRECT_EFFICIENT"
  );
  const [avatarKey, setAvatarKey] = useState(ceoAgent?.avatarKey || CEO_AVATAR_PRESETS[0].key);
  const [model, setModel] = useState(ceoAgent?.model || DEFAULT_AGENT_MODEL);
  const [defaultSubAgentModel, setDefaultSubAgentModel] = useState(
    ceoAgent?.defaultSubAgentModel || DEFAULT_AGENT_MODEL
  );
  const [timezone, setTimezone] = useState("");
  const [savedTimezone, setSavedTimezone] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await fetchAuthenticatedUserProfile({ user });
        if (cancelled) return;
        const tz = payload?.user?.timezone || detectBrowserTimeZone() || "America/New_York";
        setTimezone(tz);
        setSavedTimezone(payload?.user?.timezone || "");
      } catch {
        if (!cancelled) {
          setTimezone(detectBrowserTimeZone() || "America/New_York");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const isDirty =
    name.trim() !== (ceoAgent?.name || "CEO Agent") ||
    personalityPreset !== (ceoAgent?.personalityPreset || "DIRECT_EFFICIENT") ||
    avatarKey !== (ceoAgent?.avatarKey || CEO_AVATAR_PRESETS[0].key) ||
    model !== (ceoAgent?.model || DEFAULT_AGENT_MODEL) ||
    defaultSubAgentModel !== (ceoAgent?.defaultSubAgentModel || DEFAULT_AGENT_MODEL) ||
    timezone.trim() !== savedTimezone;

  const handleSave = async () => {
    if (isSaving) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setSaveError("The CEO Agent needs a name.");
      return;
    }
    const trimmedTz = timezone.trim();
    if (!trimmedTz) {
      setSaveError("Timezone is required (IANA, e.g. America/New_York).");
      return;
    }
    setIsSaving(true);
    setSaveError("");
    try {
      if (trimmedTz !== savedTimezone) {
        await updateUserTimezone(trimmedTz, { user });
        setSavedTimezone(trimmedTz);
      }
      const payload = await updateCeoAgent(
        {
          name: trimmedName,
          personalityPreset,
          avatarKey,
          model,
          defaultSubAgentModel,
        },
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div style={fosStyles.sectionLabel}>Name</div>
          <button
            type="button"
            style={{
              ...fosStyles.secondaryButton,
              padding: "8px 12px",
              fontSize: 12,
            }}
            onClick={onOpenProfile}
          >
            Profile →
          </button>
        </div>
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

      <div style={{ display: "grid", gap: 10 }}>
        <div style={fosStyles.sectionLabel}>Timezone</div>
        <p style={{ margin: 0, color: "#9fb0c9", fontSize: 12, lineHeight: 1.55 }}>
          Used for agent schedules and local times. Detected from your browser when possible;
          otherwise defaults to Eastern Time (America/New_York). Schedules use your local time,
          not UTC.
        </p>
        <input
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          placeholder="America/New_York"
          maxLength={64}
          style={{ ...fosStyles.input, maxWidth: 380 }}
        />
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <div style={fosStyles.sectionLabel}>CEO Agent model</div>
        <p style={{ margin: 0, color: "#9fb0c9", fontSize: 12, lineHeight: 1.55 }}>
          Used for CEO chat (with read-only live web search), digests, and Read your Profile.
          Background jobs stay on a fast model automatically.
        </p>
        <ModelPicker value={model} onChange={setModel} name="ceo-model" />
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <div style={fosStyles.sectionLabel}>Default for new agents</div>
        <p style={{ margin: 0, color: "#9fb0c9", fontSize: 12, lineHeight: 1.55 }}>
          Pre-selected when you create a sub-agent. Independent of the CEO Agent model — you can
          still change each agent later.
        </p>
        <ModelPicker
          value={defaultSubAgentModel}
          onChange={setDefaultSubAgentModel}
          name="default-sub-agent-model"
        />
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
      </div>
    </div>
  );
}
