import { useEffect, useMemo, useState } from "react";
import { styles } from "../styles.js";
import {
  buildWorkspaceGuideContext,
  buildWorkspaceGuideSuggestions,
  buildWorkspaceGuideWelcome,
  resolveWorkspaceGuideReply,
} from "../utils/workspaceGuide.js";

function ActionButtons({ actions, onAction }) {
  if (!Array.isArray(actions) || actions.length === 0) return null;

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
      {actions.map((action) => (
        <button
          key={`${action.label}-${action.tab || "action"}`}
          type="button"
          onClick={() => onAction(action)}
          style={{
            borderRadius: 999,
            border: "1px solid rgba(0,216,255,.24)",
            background: "rgba(0,136,255,.10)",
            color: "#dff7ff",
            padding: "8px 11px",
            cursor: "pointer",
            fontWeight: 800,
            fontSize: 12,
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

export function WorkspaceGuideAssistant({
  open,
  onClose,
  activeTab,
  onboardingProgress,
  accounts,
  incomeStreams,
  budgetRows,
  transactions,
  plaidIntegration,
  onNavigateToTab,
}) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([]);

  const context = useMemo(
    () =>
      buildWorkspaceGuideContext({
        activeTab,
        onboardingProgress,
        accounts,
        incomeStreams,
        budgetRows,
        transactions,
        plaidIntegration,
      }),
    [
      activeTab,
      onboardingProgress,
      accounts,
      incomeStreams,
      budgetRows,
      transactions,
      plaidIntegration,
    ]
  );

  const suggestions = useMemo(() => buildWorkspaceGuideSuggestions(context), [context]);

  useEffect(() => {
    if (!open) return;
    setMessages((current) => {
      if (current.length > 0) return current;
      const welcome = buildWorkspaceGuideWelcome(context);
      return [
        {
          id: "welcome",
          role: "assistant",
          text: welcome.text,
          actions: welcome.actions,
        },
      ];
    });
  }, [context, open]);

  const handleAction = (action) => {
    if (action?.tab) {
      onNavigateToTab?.(action.tab);
      onClose?.();
    }
  };

  const submitQuestion = (rawValue) => {
    const value = String(rawValue || "").trim();
    if (!value) return;

    const reply = resolveWorkspaceGuideReply(value, context);
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: "user", text: value },
      {
        id: `assistant-${Date.now() + 1}`,
        role: "assistant",
        text: reply.text,
        actions: reply.actions,
      },
    ]);
    setDraft("");
  };

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "rgba(1,8,18,.58)",
        display: "flex",
        justifyContent: "flex-end",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <aside
        style={{
          width: "min(420px, 100vw)",
          height: "100vh",
          background: "#07111d",
          borderLeft: "1px solid rgba(0,216,255,.22)",
          boxShadow: "-18px 0 48px rgba(0,0,0,.48)",
          display: "grid",
          gridTemplateRows: "auto auto 1fr auto",
        }}
      >
        <div style={{ padding: "18px 18px 14px", borderBottom: "1px solid rgba(0,216,255,.12)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <div>
              <div
                style={{
                  color: "#8feaff",
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  fontSize: 11,
                  fontWeight: 900,
                }}
              >
                AI Guide beta
              </div>
              <div style={{ color: "white", fontSize: 22, fontWeight: 900, marginTop: 4 }}>
                Ask Forward Freedom
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{
                borderRadius: 999,
                width: 36,
                height: 36,
                border: "1px solid rgba(0,216,255,.18)",
                background: "rgba(0,136,255,.08)",
                color: "#eef6ff",
                cursor: "pointer",
                fontWeight: 900,
              }}
            >
              ×
            </button>
          </div>
          <div style={{ color: "#9fb0c9", lineHeight: 1.55, marginTop: 10, fontSize: 13 }}>
            I explain what each card, chart, and module does, walk you through tasks, and point you
            to the right screen. I do not give financial advice or recommendations.
          </div>
        </div>

        <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(0,216,255,.10)" }}>
          <div style={{ color: "#cfe6ff", fontSize: 12, lineHeight: 1.55 }}>
            Current tab: <strong>{context.activeTab}</strong>
            {context.onboardingProgress?.currentStep
              ? ` • Next step: ${context.onboardingProgress.currentStep.label}`
              : " • Setup complete"}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => submitQuestion(suggestion)}
                style={{
                  borderRadius: 999,
                  border: "1px solid rgba(0,216,255,.18)",
                  background: "rgba(0,136,255,.06)",
                  color: "#dff7ff",
                  padding: "8px 11px",
                  cursor: "pointer",
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>

        <div style={{ overflowY: "auto", padding: 18, display: "grid", gap: 12 }}>
          {messages.map((message) => (
            <div
              key={message.id}
              style={{
                justifySelf: message.role === "user" ? "end" : "stretch",
                maxWidth: message.role === "user" ? "88%" : "100%",
                borderRadius: 16,
                padding: "12px 14px",
                border:
                  message.role === "user"
                    ? "1px solid rgba(0,216,255,.18)"
                    : "1px solid rgba(0,136,255,.22)",
                background:
                  message.role === "user"
                    ? "linear-gradient(90deg, rgba(0,119,255,.18), rgba(0,216,255,.12))"
                    : "rgba(3,17,32,.86)",
              }}
            >
              <div
                style={{
                  color: message.role === "user" ? "#eef6ff" : "#d7ebff",
                  lineHeight: 1.65,
                  fontSize: 13,
                  whiteSpace: "pre-wrap",
                }}
              >
                {message.text}
              </div>
              <ActionButtons actions={message.actions} onAction={handleAction} />
            </div>
          ))}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitQuestion(draft);
          }}
          style={{
            padding: 18,
            borderTop: "1px solid rgba(0,216,255,.12)",
            display: "grid",
            gap: 10,
          }}
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask how to use the site, where to go next, or what a feature means."
            rows={3}
            style={{
              width: "100%",
              resize: "vertical",
              borderRadius: 14,
              border: "1px solid rgba(0,216,255,.20)",
              background: "rgba(0,136,255,.07)",
              color: "#eef6ff",
              padding: "12px 13px",
              outline: "none",
              fontFamily: styles.page.fontFamily,
            }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
            <div style={{ color: "#8faecc", fontSize: 12 }}>
              Product help only — no financial advice.
            </div>
            <button
              type="submit"
              style={{
                borderRadius: 12,
                border: "1px solid rgba(120,220,255,.45)",
                background: "linear-gradient(90deg,#0077ff,#00d8ff)",
                color: "white",
                padding: "11px 14px",
                cursor: "pointer",
                fontWeight: 900,
              }}
            >
              Ask guide
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
