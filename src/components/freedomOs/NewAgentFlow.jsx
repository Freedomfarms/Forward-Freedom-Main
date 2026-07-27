import { useEffect, useRef, useState } from "react";
import { discardCeoAgentCreation } from "../../utils/agentsApi.js";
import { AgentChat } from "./AgentChat.jsx";
import { CreationDraftPanel } from "./CreationDraftPanel.jsx";
import { fosStyles } from "./freedomOsShared.js";

// Aim opener — keep in sync with server/agents/creationDraft.js AIM_OPENER.
const AIM_OPENER =
  "What's the one outcome this agent is responsible for? Not the steps — the result.\n\n" +
  'For example: "Every morning my inbox is empty, replies are drafted in my voice, and anything urgent is flagged."';

// "+ New Agent" — slide-over where the CEO Agent interviews through chat
// (mode: "create_agent"). Slice 1: Aim → full interview → draft review → confirm.
// Draft panel stays closed until the interview is finished (or the user skips).
//
// This UI does not load creation history, so unfinished drafts are not a feature:
// close discards them, and the first Aim answer sends startFresh as a backstop.
// Resume only makes sense once we show the prior transcript in this panel.

export function NewAgentFlow({ ceoAgent, user, onClose, onAgentCreated }) {
  const [createdAgent, setCreatedAgent] = useState(null);
  const [creationDraft, setCreationDraft] = useState(null);
  const createdAgentRef = useRef(null);
  const ceoName = ceoAgent?.name || "CEO Agent";

  // Leaving the blank panel without creating must not leave an invisible
  // "active" draft on the shared creation thread.
  useEffect(() => {
    return () => {
      if (createdAgentRef.current) return;
      void discardCeoAgentCreation({ user }).catch(() => {});
    };
  }, [user]);

  const handleClose = () => {
    if (!createdAgentRef.current) {
      void discardCeoAgentCreation({ user }).catch(() => {});
    }
    onClose?.();
  };

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
        if (event.target === event.currentTarget) handleClose();
      }}
    >
      <aside
        style={{
          width: "min(520px, 100vw)",
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
              onClick={handleClose}
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
            {ceoName} will ask a few questions first (you can answer naturally or say skip). The
            draft opens only after that — nothing is created until you approve it. New agents always
            start read-only.
          </div>
        </div>

        <div style={{ padding: 18, overflowY: "auto", display: "grid", gap: 14, alignContent: "start" }}>
          <CreationDraftPanel draft={creationDraft} />
          <AgentChat
            mode="create_agent"
            agentName={ceoName}
            user={user}
            maxHeight={9999}
            introMessage={AIM_OPENER}
            placeholder='e.g. "Every weekday I know what needs my attention by 9am" — or say skip later'
            onCreationDraftChange={setCreationDraft}
            onAgentCreated={(agent) => {
              createdAgentRef.current = agent;
              setCreatedAgent(agent);
              onAgentCreated?.(agent);
            }}
          />
          {createdAgent ? (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" style={fosStyles.primaryButton} onClick={handleClose}>
                Done — back to Freedom OS
              </button>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
