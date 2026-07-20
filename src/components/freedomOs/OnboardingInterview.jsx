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
const MAX_UPLOAD_DOCS = 3;
const MAX_DOC_CHARS = 40_000;

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

function readTextFiles(fileList) {
  const files = Array.from(fileList || []);
  return Promise.all(
    files.map(
      (file) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            resolve({
              filename: file.name,
              mimeType: file.type || "text/plain",
              content: String(reader.result || ""),
            });
          };
          reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
          reader.readAsText(file);
        })
    )
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
  const [additionalNotes, setAdditionalNotes] = useState("");
  const [documents, setDocuments] = useState([]);
  const [pasteFilename, setPasteFilename] = useState("notes.txt");
  const [pasteContent, setPasteContent] = useState("");
  const [docError, setDocError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [summaryResult, setSummaryResult] = useState(null);

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

  const addDocuments = (incoming) => {
    setDocError("");
    setDocuments((current) => {
      const next = [...current];
      for (const doc of incoming) {
        if (next.length >= MAX_UPLOAD_DOCS) {
          setDocError(`You can attach up to ${MAX_UPLOAD_DOCS} documents during setup.`);
          break;
        }
        if (!doc.content?.trim()) continue;
        if (doc.content.length > MAX_DOC_CHARS) {
          setDocError(`"${doc.filename}" is too large (max ${MAX_DOC_CHARS.toLocaleString()} characters).`);
          continue;
        }
        if (next.some((item) => item.filename === doc.filename)) continue;
        next.push(doc);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError("");
    const lifeContext = [lifeChips.join("; "), lifeText.trim()].filter(Boolean).join(". ");
    try {
      const payload = await submitCeoOnboarding(
        {
          financialGoals: goals,
          lifeContext: lifeContext || null,
          additionalNotes: additionalNotes.trim() || null,
          priorities,
          communicationPrefs: `Digest frequency: ${digestFrequency}`,
          ceoName: ceoName.trim() || "CEO Agent",
          personalityPreset,
          avatarKey,
          documents,
        },
        { user }
      );
      setSummaryResult({
        ceoAgent: payload?.ceoAgent || null,
        summary: payload?.onboardingSummary?.summary || null,
        documents: payload?.documents || [],
      });
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
          eyebrow="Step 1 of 9"
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
          eyebrow="Step 2 of 9"
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
            placeholder="Optional short note about your situation…"
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
          eyebrow="Step 3 of 9"
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
          eyebrow="Step 4 of 9"
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
          eyebrow="Step 5 of 9"
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
          eyebrow="Step 6 of 9"
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
          eyebrow="Step 7 of 9"
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
    {
      key: "notes",
      render: () => (
        <StepShell
          eyebrow="Step 8 of 9"
          title="Anything else it should know?"
          subtitle="Freeform space for context that didn't fit the earlier questions — family plans, constraints, how you like to work, whatever matters."
        >
          <textarea
            value={additionalNotes}
            onChange={(event) => setAdditionalNotes(event.target.value)}
            placeholder="Example: We're expanding the farm next spring, keep cash reserves higher than usual…"
            rows={7}
            maxLength={2000}
            style={{ ...fosStyles.input, resize: "vertical", fontFamily: styles.page.fontFamily }}
          />
          <div style={{ color: "#5f7896", fontSize: 11, textAlign: "right" }}>
            {additionalNotes.length}/2000
          </div>
        </StepShell>
      ),
    },
    {
      key: "documents",
      render: () => (
        <StepShell
          eyebrow="Step 9 of 9"
          title="Upload documents for your CEO Agent"
          subtitle={`Optional. Text files only (.txt, .md, .csv, .json) — up to ${MAX_UPLOAD_DOCS}. Your CEO Agent can read these when you chat.`}
        >
          <label
            style={{
              ...fosStyles.secondaryButton,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              cursor: documents.length >= MAX_UPLOAD_DOCS ? "default" : "pointer",
              opacity: documents.length >= MAX_UPLOAD_DOCS ? 0.55 : 1,
            }}
          >
            Choose files
            <input
              type="file"
              accept=".txt,.md,.markdown,.csv,.json,text/plain,text/markdown,text/csv,application/json"
              multiple
              disabled={documents.length >= MAX_UPLOAD_DOCS}
              style={{ display: "none" }}
              onChange={(event) => {
                const input = event.target;
                void readTextFiles(input.files)
                  .then((parsed) => addDocuments(parsed))
                  .catch((error) => setDocError(error.message || "Could not read that file."))
                  .finally(() => {
                    input.value = "";
                  });
              }}
            />
          </label>

          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ color: "#9fb0c9", fontSize: 12 }}>Or paste text as a document</div>
            <input
              value={pasteFilename}
              onChange={(event) => setPasteFilename(event.target.value)}
              placeholder="filename.txt"
              maxLength={120}
              style={fosStyles.input}
            />
            <textarea
              value={pasteContent}
              onChange={(event) => setPasteContent(event.target.value)}
              placeholder="Paste notes, a plan outline, or other text…"
              rows={5}
              maxLength={MAX_DOC_CHARS}
              style={{ ...fosStyles.input, resize: "vertical", fontFamily: styles.page.fontFamily }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                style={{
                  ...fosStyles.secondaryButton,
                  opacity: !pasteContent.trim() || documents.length >= MAX_UPLOAD_DOCS ? 0.55 : 1,
                }}
                disabled={!pasteContent.trim() || documents.length >= MAX_UPLOAD_DOCS}
                onClick={() => {
                  addDocuments([
                    {
                      filename: (pasteFilename.trim() || "notes.txt").replace(/[/\\]/g, "-"),
                      mimeType: "text/plain",
                      content: pasteContent,
                    },
                  ]);
                  setPasteContent("");
                }}
              >
                Add pasted text
              </button>
            </div>
          </div>

          {docError ? <div style={fosStyles.errorBox}>{docError}</div> : null}

          {documents.length ? (
            <div style={{ display: "grid", gap: 8 }}>
              {documents.map((doc) => (
                <div
                  key={doc.filename}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    alignItems: "center",
                    borderRadius: 10,
                    border: "1px solid rgba(0,216,255,.18)",
                    background: "rgba(0,136,255,.06)",
                    padding: "10px 12px",
                    color: "#dff7ff",
                    fontSize: 13,
                  }}
                >
                  <span>
                    {doc.filename}{" "}
                    <span style={{ color: "#5f7896" }}>
                      ({doc.content.length.toLocaleString()} chars)
                    </span>
                  </span>
                  <button
                    type="button"
                    style={fosStyles.subtleButton}
                    onClick={() =>
                      setDocuments((current) => current.filter((item) => item.filename !== doc.filename))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: "#8faecc", fontSize: 13 }}>No documents attached yet — totally optional.</div>
          )}
        </StepShell>
      ),
    },
  ];

  if (summaryResult) {
    return (
      <div style={{ ...styles.panel, padding: 28, maxWidth: 760, margin: "0 auto", display: "grid", gap: 20 }}>
        <div>
          <div style={fosStyles.sectionLabel}>Your CEO Agent profile</div>
          <h2 style={{ margin: "8px 0 0", color: "white", fontSize: 24, fontWeight: 800 }}>
            Here&apos;s what {summaryResult.ceoAgent?.name || "your CEO Agent"} knows so far
          </h2>
          <p style={{ margin: "8px 0 0", color: "#9fb0c9", fontSize: 13, lineHeight: 1.6 }}>
            This summary was built from your answers
            {summaryResult.documents?.length
              ? ` and ${summaryResult.documents.length} document${summaryResult.documents.length === 1 ? "" : "s"}`
              : ""}
            . You can edit it anytime under profile.
          </p>
        </div>
        <div
          style={{
            borderRadius: 14,
            border: "1px solid rgba(0,216,255,.22)",
            background: "rgba(3,17,32,.86)",
            padding: "16px 18px",
            color: "#d7ebff",
            fontSize: 13,
            lineHeight: 1.7,
            whiteSpace: "pre-wrap",
          }}
        >
          {summaryResult.summary || "Profile saved. Open your profile anytime to review the details."}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            style={fosStyles.primaryButton}
            onClick={() => onComplete?.(summaryResult.ceoAgent)}
          >
            Enter Freedom OS
          </button>
        </div>
      </div>
    );
  }

  const isLastStep = stepIndex === steps.length - 1;

  return (
    <div style={{ ...styles.panel, padding: 28, maxWidth: 760, margin: "0 auto", display: "grid", gap: 24 }}>
      <div>
        <div style={fosStyles.sectionLabel}>Meet your CEO Agent</div>
        <p style={{ margin: "10px 0 0", color: "#c8d7ea", fontSize: 13, lineHeight: 1.6 }}>
          A short interview so your CEO Agent starts with real context. At the end you can add freeform
          notes and documents — then it writes a profile summary you can review.
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
            {isSubmitting ? "Building your profile…" : "Finish & create profile"}
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
