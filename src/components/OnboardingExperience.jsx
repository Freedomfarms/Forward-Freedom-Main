import { styles } from "../styles.js";

function buildProgressLabel(progress) {
  return `${progress.completedCount} / ${progress.totalSteps}`;
}

export function SetupWelcomeModal({ progress, onStart, onSkip }) {
  if (!progress?.isActive || progress.onboarding?.welcomeDismissedAt) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10010,
        background: "rgba(1, 8, 18, 0.82)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "min(640px, 100%)",
          borderRadius: 24,
          border: "1px solid rgba(0,216,255,.26)",
          background:
            "radial-gradient(circle at top, rgba(0,136,255,.16), rgba(4,14,28,.98) 50%)",
          boxShadow: "0 24px 80px rgba(0,8,18,.76), 0 0 40px rgba(0,136,255,.18)",
          padding: 30,
        }}
      >
        <div
          style={{
            color: "#8feaff",
            textTransform: "uppercase",
            letterSpacing: 1.3,
            fontSize: 12,
            fontWeight: 900,
          }}
        >
          Guided setup
        </div>
        <h2 style={{ margin: "10px 0 0", color: "white", fontSize: 30, lineHeight: 1.1 }}>
          Welcome to Forward Freedom.
        </h2>
        <p style={{ margin: "14px 0 0", color: "#c9d8ee", lineHeight: 1.7, fontSize: 15 }}>
          We&apos;ll walk you through the highest-value setup path: add accounts, define income,
          build the budget, and review transactions before relying on Command Center.
        </p>

        <div
          style={{
            ...styles.panel,
            marginTop: 22,
            padding: 18,
            display: "grid",
            gap: 12,
          }}
        >
          {progress.steps.map((step, index) => (
            <div
              key={step.id}
              style={{
                display: "grid",
                gridTemplateColumns: "30px minmax(0, 1fr)",
                gap: 12,
                alignItems: "start",
              }}
            >
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  border: "1px solid rgba(0,216,255,.24)",
                  background: "rgba(0,136,255,.12)",
                  color: "#8feaff",
                  fontWeight: 900,
                  fontSize: 12,
                }}
              >
                {index + 1}
              </div>
              <div>
                <div style={{ color: "white", fontWeight: 800, fontSize: 14 }}>{step.label}</div>
                <div style={{ color: "#9fb0c9", fontSize: 13, lineHeight: 1.5, marginTop: 4 }}>
                  {step.description}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 24 }}>
          <button
            type="button"
            onClick={onStart}
            style={{
              borderRadius: 12,
              border: "1px solid rgba(120,220,255,.45)",
              background: "linear-gradient(90deg,#0077ff,#00d8ff)",
              color: "white",
              padding: "13px 18px",
              cursor: "pointer",
              fontWeight: 900,
              fontSize: 14,
              boxShadow: "0 0 26px rgba(0,136,255,.24)",
            }}
          >
            Start setup
          </button>
          <button
            type="button"
            onClick={onSkip}
            style={{
              borderRadius: 12,
              border: "1px solid rgba(0,216,255,.20)",
              background: "rgba(0,136,255,.08)",
              color: "#eef6ff",
              padding: "13px 18px",
              cursor: "pointer",
              fontWeight: 800,
              fontSize: 14,
            }}
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}

export function SetupChecklistPanel({ progress, activeTab, onOpenStep, onSkip }) {
  if (!progress?.isActive) return null;

  return (
    <div style={{ ...styles.panel, marginTop: 28, padding: 18 }}>
      <div style={{ color: "#8feaff", fontSize: 12, fontWeight: 900, letterSpacing: 1.1 }}>
        SETUP CENTER
      </div>
      <div style={{ color: "white", fontSize: 18, fontWeight: 800, marginTop: 8 }}>
        Build the workspace in order.
      </div>
      <div style={{ color: "#c8d7ea", fontSize: 12, lineHeight: 1.6, marginTop: 10 }}>
        Progress {buildProgressLabel(progress)} complete. Follow the guided path, or skip anytime
        if you already know where to go.
      </div>

      <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
        {progress.steps.map((step, index) => {
          const isCurrent = progress.currentStep?.id === step.id;
          const isActiveTab = activeTab === step.tab;

          return (
            <button
              key={step.id}
              type="button"
              onClick={() => onOpenStep(step)}
              style={{
                textAlign: "left",
                padding: "12px 14px",
                borderRadius: 12,
                border: step.completed
                  ? "1px solid rgba(0,245,155,.28)"
                  : isCurrent || isActiveTab
                    ? "1px solid rgba(0,216,255,.28)"
                    : "1px solid rgba(0,216,255,.14)",
                background: step.completed
                  ? "rgba(0,245,155,.08)"
                  : isCurrent || isActiveTab
                    ? "linear-gradient(90deg, rgba(0,119,255,.18), rgba(0,216,255,.14))"
                    : "rgba(0,108,255,.06)",
                color: "#eaf3ff",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div style={{ fontWeight: 800, fontSize: 13 }}>
                  {index + 1}. {step.label}
                </div>
                <div
                  style={{
                    color: step.completed ? "#9fffd5" : isCurrent ? "#8feaff" : "#7f96b6",
                    fontSize: 11,
                    fontWeight: 800,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                  }}
                >
                  {step.completed ? "Done" : isCurrent ? "Current" : "Pending"}
                </div>
              </div>
              <div style={{ color: "#9fb0c9", fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
                {step.title}
              </div>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onSkip}
        style={{
          marginTop: 14,
          width: "100%",
          borderRadius: 10,
          border: "1px solid rgba(0,216,255,.16)",
          background: "rgba(0,136,255,.05)",
          color: "#c6d7ea",
          padding: "10px 12px",
          cursor: "pointer",
          fontWeight: 700,
        }}
      >
        Skip setup for now
      </button>
    </div>
  );
}

export function SetupStepBanner({ progress, activeTab, onOpenStep, onSkip }) {
  if (!progress?.isActive || !progress.currentStep) return null;

  const step = progress.currentStep;
  const isCurrentTab = activeTab === step.tab;

  return (
    <div
      style={{
        border: "1px solid rgba(0,216,255,.24)",
        borderRadius: 16,
        background: "linear-gradient(90deg, rgba(0,119,255,.16), rgba(0,216,255,.08))",
        padding: "16px 18px",
        marginBottom: 18,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div>
        <div
          style={{
            color: "#8feaff",
            fontSize: 11,
            fontWeight: 900,
            letterSpacing: 1,
            textTransform: "uppercase",
          }}
        >
          Setup step {progress.completedCount + 1} of {progress.totalSteps}
        </div>
        <div style={{ color: "white", fontSize: 18, fontWeight: 800, marginTop: 6 }}>
          {step.title}
        </div>
        <div style={{ color: "#dce8f6", lineHeight: 1.6, marginTop: 6, maxWidth: 760 }}>
          {step.description}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {!isCurrentTab ? (
          <button
            type="button"
            onClick={() => onOpenStep(step)}
            style={{
              borderRadius: 10,
              border: "1px solid rgba(120,220,255,.45)",
              background: "linear-gradient(90deg,#0077ff,#00d8ff)",
              color: "white",
              padding: "11px 14px",
              cursor: "pointer",
              fontWeight: 900,
            }}
          >
            {step.cta}
          </button>
        ) : (
          <div
            style={{
              borderRadius: 10,
              border: "1px solid rgba(0,216,255,.20)",
              background: "rgba(0,136,255,.08)",
              color: "#dff7ff",
              padding: "11px 14px",
              fontWeight: 800,
            }}
          >
            You&apos;re in the right place.
          </div>
        )}
        <button
          type="button"
          onClick={onSkip}
          style={{
            borderRadius: 10,
            border: "1px solid rgba(0,216,255,.20)",
            background: "rgba(0,136,255,.08)",
            color: "#eef6ff",
            padding: "11px 14px",
            cursor: "pointer",
            fontWeight: 800,
          }}
        >
          Skip setup
        </button>
      </div>
    </div>
  );
}
