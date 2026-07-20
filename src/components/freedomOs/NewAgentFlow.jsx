import { useState } from "react";
import { AgentChat } from "./AgentChat.jsx";
import { fosStyles } from "./freedomOsShared.js";

// "+ New Agent" — a slide-over where the CEO Agent drives creation through
// chat (mode: "create_agent" on the server routes the whole conversation
// through the deterministic creation session; the final confirm hits the same
// validated creation path as POST /api/agents).

export function NewAgentFlow({ ceoAgent, user, onClose, onAgentCreated }) {
  const [createdAgent, setCreatedAgent] = useState(null);
  const ceoName = ceoAgent?.name || "CEO Agent";

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
          width: "min(460px, 100vw)",
          height: "100vh",
          background: "#07111d",
          borderLeft: "1px solid rgba(0,216,255,.22)",
          boxShadow: "-18px 0 48px rgba(0,0,0,.48)",
          display: "grid",
          gridTemplateRows: "auto 1fr",
        }}
      >
        <div style={{ padding: "18px 18px 14px", borderBottom: "1px solid rgba(0,216,255,.12)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <div>
              <div style={fosStyles.sectionLabel}>New agent</div>
              <div style={{ color: "white", fontSize: 20, fontWeight: 900, marginTop: 4 }}>
                Create with {ceoName}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
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
            {ceoName} will gather purpose, data, schedule, and a definition of done (you can answer
            naturally — details in any order are fine), then show a review before anything is
            created. New agents always start read-only.
          </div>
        </div>

        <div style={{ padding: 18, overflowY: "auto", display: "grid", gap: 14, alignContent: "start" }}>
          <AgentChat
            mode="create_agent"
            agentName={ceoName}
            user={user}
            maxHeight={9999}
            placeholder='e.g. "I want a research agent that tracks cattle prices"'
            onAgentCreated={(agent) => {
              setCreatedAgent(agent);
              onAgentCreated?.(agent);
            }}
          />
          {createdAgent ? (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" style={fosStyles.primaryButton} onClick={onClose}>
                Done — back to Freedom OS
              </button>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
