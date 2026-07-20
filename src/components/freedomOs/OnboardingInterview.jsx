import { useState } from "react";
import { styles } from "../../styles.js";
import { ApiRequestError } from "../../utils/api.js";
import { submitCeoOnboarding } from "../../utils/agentsApi.js";
import { CEO_AVATAR_PRESETS } from "../../data/ceoAvatars.js";
import { describeAgentApiError, fosStyles, PERSONALITY_PRESETS } from "./freedomOsShared.js";

// Structured CEO Agent onboarding interview (one-shot POST /api/agents/onboarding).
// Shown when the CEO config exists but onboardingCompletedAt is null.

const GOAL_SUGGESTIONS = [
  "Build a 6-month emergency fund",
  "Pay off all credit card debt",
  "Grow farm/business income",
  "Save for a large purchase",
  "Increase monthly investing",
  "Cut recurring spending",
];

const LIFE_CONTEXT_CHIPS = [
  "Married / partnered household",
  "Kids at home",
  "Run a farm",
  "Own a small business",
  "Single income",
  "Multiple income sources",
  "W-2 income",
  "Self-employed income",
];

const PRIORITY_OPTIONS = [
  "Stay on top of daily spending",
  "Reduce debt",
  "Grow savings and reserves",
  "Plan the year's budget",
  "Track farm/business finances",
  "Keep subscriptions under control",
];

const DIGEST_OPTIONS = [
  { value: "daily", label: "Daily digest", note: "A short morning briefing every day." },
  { value: "weekly", label: "Weekly digest", note: "One summary at the start of the week." },
];

const MAX_GOALS = 3;

function Chip({ selected, onToggle, children, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      style={{
        borderRadius: 999,
        border: selected ? "1px solid rgba(120,220,255,.6)" : "1px solid rgba(0,216,255,.18)",
        background: selected
          ? "linear-gradient(90deg, rgba(0,119,255,.32), rgba(0,216,255,.22))"
          : "rgba(0,136,255,.06)",
        color: selected ? "white" : "#dff7ff",
        padding: "9px 13px",
        cursor: disabled ? "default" : "pointer",
        fontWeight: 700,
        fontSize: 12,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function StepShell({ eyebrow, title, subtitle, children }) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <div style={fosStyles.sectionLabel}>{eyebrow}</div>
        <h2 style={{ margin: "8px 0 0", color: "white", fontSize: 24, fontWeight: 800 }}>{title}</h2>
        {subtitle ? (
          <p style={{ margin: "8px 0 0", color: "#9fb0c9", fontSize: 13, lineHeight: 1.6 }}>{subtitle}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function OnboardingInterview({ user, onComplete }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [goals, setGoals] = useState([]);
  const [customGoal, setCustomGoal] = useState("");
  const [lifeChips, setLifeChips] = useState([]);
  const [lifeText, setLifeText] = useState("");
  const [priorities, setPriorities] = useState([]);
  const [digestFrequency, setDigestFrequency] = useState("daily");
  const [ceoName, setCeoName] = useState("CEO Agent");
  const [personalityPreset, setPersonalityPreset] = useState("DIRECT_EFFICIENT");
  const [avatarKey, setAvatarKey] = useState(CEO_AVATAR_PRESETS[0].key);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const toggleInList = (list, setList, value, { max = null } = {}) => {
    setList((current) => {
      if (current.includes(value)) return current.filter((item) => item !== value);
      if (max && current.length >= max) return current;
      return [...current, value];
    });
  };

  const addCustomGoal = () => {
    const value = customGoal.trim();
    if (!value || goals.length >= MAX_GOALS || goals.includes(value)) return;
    setGoals((current) => [...current, value]);
    setCustomGoal("");
  };

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError("");
    const lifeContext = [
      lifeChips.join("; "),
      lifeText.trim(),
    ]
      .filter(Boolean)
      .join(". ");
    try {
      const payload = await submitCeoOnboarding(
        {
          financialGoals: goals,
          lifeContext: lifeContext || null,
          priorities,
          communicationPrefs: `Digest frequency: ${digestFrequency}`,
          ceoName: ceoName.trim() || "CEO Agent",
          personalityPreset,
          avatarKey,
        },
        { user }
      );
      onComplete?.(payload?.ceoAgent || null);
    } catch (error) {
      // 409 = onboarding already completed elsewhere; treat as done.
      if (error instanceof ApiRequestError && error.status === 409) {
        onComplete?.(null);
        return;
      }
      setSubmitError(describeAgentApiError(error, "Onboarding could not be saved. Try again."));
    } finally {
      setIsSubmitting(false);
    }
  };

  const steps = [
    {
      key: "goals",
      render: () => (
        <StepShell
          eyebrow="Step 1 of 7"
          title="What are your financial goals?"
          subtitle={`Pick up to ${MAX_GOALS} — or add your own. Your CEO Agent uses these to focus its briefings.`}
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {GOAL_SUGGESTIONS.map((goal) => (
              <Chip
                key={goal}
                selected={goals.includes(goal)}
                disabled={!goals.includes(goal) && goals.length >= MAX_GOALS}
                onToggle={() => toggleInList(goals, setGoals, goal, { max: MAX_GOALS })}
              >
                {goal}
              </Chip>
            ))}
            {goals
              .filter((goal) => !GOAL_SUGGESTIONS.includes(goal))
              .map((goal) => (
                <Chip key={goal} selected onToggle={() => toggleInList(goals, setGoals, goal)}>
                  {goal} ✕
                </Chip>
              ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={customGoal}
              onChange={(event) => setCustomGoal(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addCustomGoal();
                }
              }}
              placeholder="Add your own goal…"
              maxLength={120}
              style={{ ...fosStyles.input, flex: 1 }}
              disabled={goals.length >= MAX_GOALS}
            />
            <button
              type="button"
              style={{
                ...fosStyles.secondaryButton,
                opacity: !customGoal.trim() || goals.length >= MAX_GOALS ? 0.5 : 1,
              }}
              disabled={!customGoal.trim() || goals.length >= MAX_GOALS}
              onClick={addCustomGoal}
            >
              Add
            </button>
          </div>
        </StepShell>
      ),
    },
    {
      key: "life",
      render: () => (
        <StepShell
          eyebrow="Step 2 of 7"
          title="Tell it about your life"
          subtitle="Household, business or farm, income sources — pick what applies and add a short note if you like."
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {LIFE_CONTEXT_CHIPS.map((chip) => (
              <Chip
                key={chip}
                selected={lifeChips.includes(chip)}
                onToggle={() => toggleInList(lifeChips, setLifeChips, chip)}
              >
                {chip}
              </Chip>
            ))}
          </div>
          <textarea
            value={lifeText}
            onChange={(event) => setLifeText(event.target.value)}
            placeholder="Anything else worth knowing? (optional, short)"
            rows={3}
            maxLength={500}
            style={{ ...fosStyles.input, resize: "vertical", fontFamily: styles.page.fontFamily }}
          />
        </StepShell>
      ),
    },
    {
      key: "priorities",
      render: () => (
        <StepShell
          eyebrow="Step 3 of 7"
          title="What matters most right now?"
          subtitle="Select all that apply."
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {PRIORITY_OPTIONS.map((priority) => (
              <Chip
                key={priority}
                selected={priorities.includes(priority)}
                onToggle={() => toggleInList(priorities, setPriorities, priority)}
              >
                {priority}
              </Chip>
            ))}
          </div>
        </StepShell>
      ),
    },
    {
      key: "communication",
      render: () => (
        <StepShell
          eyebrow="Step 4 of 7"
          title="How often should it brief you?"
          subtitle="Tone follows the personality you pick in a later step."
        >
          <div style={{ display: "grid", gap: 10 }}>
            {DIGEST_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setDigestFrequency(option.value)}
                style={{
                  textAlign: "left",
                  borderRadius: 12,
                  padding: "14px 16px",
                  cursor: "pointer",
                  border:
                    digestFrequency === option.value
                      ? "1px solid rgba(120,220,255,.6)"
                      : "1px solid rgba(0,216,255,.16)",
                  background:
                    digestFrequency === option.value
                      ? "linear-gradient(90deg, rgba(0,119,255,.24), rgba(0,216,255,.14))"
                      : "rgba(0,136,255,.05)",
                  color: "#eef6ff",
                }}
              >
                <div style={{ fontWeight: 800, fontSize: 14 }}>{option.label}</div>
                <div style={{ color: "#9fb0c9", fontSize: 12, marginTop: 4 }}>{option.note}</div>
              </button>
            ))}
          </div>
        </StepShell>
      ),
    },
    {
      key: "name",
      render: () => (
        <StepShell
          eyebrow="Step 5 of 7"
          title="Name your CEO Agent"
          subtitle="The default works fine — you can change it any time in settings."
        >
          <input
            value={ceoName}
            onChange={(event) => setCeoName(event.target.value)}
            maxLength={80}
            placeholder="CEO Agent"
            style={fosStyles.input}
          />
        </StepShell>
      ),
    },
    {
      key: "personality",
      render: () => (
        <StepShell
          eyebrow="Step 6 of 7"
          title="Pick a personality"
          subtitle="Presets only — this keeps your CEO Agent predictable and safe."
        >
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
            {PERSONALITY_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                onClick={() => setPersonalityPreset(preset.value)}
                style={{
                  textAlign: "left",
                  borderRadius: 12,
                  padding: "16px",
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
                <div style={{ fontWeight: 800, fontSize: 14 }}>{preset.label}</div>
                <div style={{ color: "#9fb0c9", fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                  {preset.description}
                </div>
              </button>
            ))}
          </div>
        </StepShell>
      ),
    },
    {
      key: "avatar",
      render: () => (
        <StepShell
          eyebrow="Step 7 of 7"
          title="Choose an avatar"
          subtitle="A simple preset — no photos, nothing generated."
        >
          <div
            style={{
              display: "grid",
              gap: 10,
              gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))",
            }}
          >
            {CEO_AVATAR_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                onClick={() => setAvatarKey(preset.key)}
                aria-label={`Avatar: ${preset.label}`}
                style={{
                  borderRadius: 12,
                  padding: "12px 8px",
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
                    width: 42,
                    height: 42,
                    borderRadius: "50%",
                    display: "grid",
                    placeItems: "center",
                    fontSize: 22,
                    background: `${preset.color}26`,
                    border: `1px solid ${preset.color}66`,
                  }}
                >
                  {preset.emoji}
                </span>
                <span style={{ color: "#cfe6ff", fontSize: 11, fontWeight: 700 }}>{preset.label}</span>
              </button>
            ))}
          </div>
        </StepShell>
      ),
    },
  ];

  const isLastStep = stepIndex === steps.length - 1;

  return (
    <div style={{ ...styles.panel, padding: 28, maxWidth: 760, margin: "0 auto", display: "grid", gap: 24 }}>
      <div>
        <div style={fosStyles.sectionLabel}>Meet your CEO Agent</div>
        <p style={{ margin: "10px 0 0", color: "#c8d7ea", fontSize: 13, lineHeight: 1.6 }}>
          A short interview so your CEO Agent starts with real context. Everything here lands in a
          profile you can review and edit later.
        </p>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        {steps.map((step, index) => (
          <div
            key={step.key}
            style={{
              flex: 1,
              height: 5,
              borderRadius: 999,
              background:
                index <= stepIndex
                  ? "linear-gradient(90deg,#0077ff,#00d8ff)"
                  : "rgba(19,71,129,.4)",
            }}
          />
        ))}
      </div>

      {steps[stepIndex].render()}

      {submitError ? <div style={fosStyles.errorBox}>{submitError}</div> : null}

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <button
          type="button"
          style={{ ...fosStyles.secondaryButton, visibility: stepIndex === 0 ? "hidden" : "visible" }}
          onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
        >
          Back
        </button>
        {isLastStep ? (
          <button
            type="button"
            style={{ ...fosStyles.primaryButton, opacity: isSubmitting ? 0.6 : 1 }}
            disabled={isSubmitting}
            onClick={() => void handleSubmit()}
          >
            {isSubmitting ? "Setting up…" : "Finish setup"}
          </button>
        ) : (
          <button
            type="button"
            style={fosStyles.primaryButton}
            onClick={() => setStepIndex((current) => Math.min(steps.length - 1, current + 1))}
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
