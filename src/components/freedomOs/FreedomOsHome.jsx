import { useState } from "react";
import { styles } from "../../styles.js";
import { regenerateCeoDigest } from "../../utils/agentsApi.js";
import { getCeoAvatarPreset } from "../../data/ceoAvatars.js";
import { useFreedomOsBootstrap } from "../../hooks/useFreedomOsBootstrap.js";
import { AgentChat } from "./AgentChat.jsx";
import { AgentDetail } from "./AgentDetail.jsx";
import { CeoSettingsPanel } from "./CeoSettingsPanel.jsx";
import { NewAgentFlow } from "./NewAgentFlow.jsx";
import { NotificationsBell } from "./NotificationsBell.jsx";
import { OnboardingInterview } from "./OnboardingInterview.jsx";
import { ProfileView } from "./ProfileView.jsx";
import {
  describeAgentApiError,
  formatRelativeTime,
  fosStyles,
  getAgentTypeMeta,
  getPersonalityLabel,
  statusBadgeStyle,
} from "./freedomOsShared.js";

// Freedom OS home — the authenticated default view. CEO Agent panel on top
// (digest + chat + actions), agent card grid below. Finance agent cards jump
// to the existing Command Center; every other type opens AgentDetail inline.

function truncate(text, maxLength = 110) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function AgentCard({ agent, onOpen }) {
  const meta = getAgentTypeMeta(agent.agentType);
  const latestRun = agent.latestRun || null;
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        textAlign: "left",
        borderRadius: 14,
        border: "1px solid rgba(30,144,255,.24)",
        background: "rgba(3,17,32,.72)",
        padding: "16px 18px",
        cursor: "pointer",
        display: "grid",
        gap: 10,
        alignContent: "start",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            display: "grid",
            placeItems: "center",
            fontSize: 16,
            background: `${meta.color}1f`,
            border: `1px solid ${meta.color}55`,
            flexShrink: 0,
          }}
        >
          {meta.icon}
        </span>
        <span style={{ color: "white", fontWeight: 800, fontSize: 15, flex: 1 }}>{agent.name}</span>
        <span style={statusBadgeStyle(agent.status)}>
          {agent.status === "PAUSED" ? "Paused" : "Active"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span
          style={{
            ...fosStyles.badge,
            border: `1px solid ${meta.color}55`,
            background: `${meta.color}14`,
            color: meta.color,
          }}
        >
          {meta.label}
        </span>
        <span style={{ color: "#5f7896", fontSize: 11 }}>
          Last run: {latestRun ? formatRelativeTime(latestRun.startedAt) : "never"}
        </span>
      </div>
      {latestRun?.summary ? (
        <div style={{ color: "#c8d7ea", fontSize: 12, lineHeight: 1.55 }}>
          {truncate(latestRun.summary, 140)}
        </div>
      ) : null}
      {agent.definitionOfDone ? (
        <div style={{ color: "#8faecc", fontSize: 11, lineHeight: 1.5 }}>
          Done means: {truncate(agent.definitionOfDone)}
        </div>
      ) : null}
    </button>
  );
}

// Static card for demo mode / unauthenticated sessions: Freedom OS agents
// require a signed-in account (all data is server-side, per-user, encrypted).
export function FreedomOsSignedOutCard() {
  return (
    <div style={{ ...styles.panel, padding: 32, textAlign: "center", display: "grid", gap: 12, justifyItems: "center" }}>
      <div style={{ fontSize: 44, color: "#00d8ff", textShadow: "0 0 25px rgba(0,216,255,.7)" }}>◈</div>
      <div style={{ color: "white", fontSize: 22, fontWeight: 900 }}>Freedom OS</div>
      <div style={{ color: "#9fb0c9", fontSize: 14, lineHeight: 1.6, maxWidth: 440 }}>
        Sign in to use Freedom OS agents. Your CEO Agent, briefings, and agent team live in your
        secure account — they are not part of the demo sandbox.
      </div>
    </div>
  );
}

export function FreedomOsHome({ user, onOpenFinanceTool }) {
  const bootstrap = useFreedomOsBootstrap({ user, enabled: Boolean(user) });
  const {
    ceoAgent,
    setCeoAgent,
    ceoError,
    digest,
    setDigest,
    digestError,
    setDigestError,
    agents,
    setAgents,
    agentsError,
    unreadCount,
    setUnreadCount,
    isLoading,
    refreshAgents,
    refreshUnreadCount,
    reload,
  } = bootstrap;

  const [view, setView] = useState("home"); // home | settings | profile
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [isDigestOpen, setIsDigestOpen] = useState(false);
  const [isNewAgentOpen, setIsNewAgentOpen] = useState(false);
  const [isRefreshingDigest, setIsRefreshingDigest] = useState(false);
  const [toast, setToast] = useState("");

  const ceoName = ceoAgent?.name || "CEO Agent";
  const avatar = getCeoAvatarPreset(ceoAgent?.avatarKey);

  const handleRefreshDigest = async () => {
    if (isRefreshingDigest) return;
    setIsRefreshingDigest(true);
    setDigestError("");
    try {
      const payload = await regenerateCeoDigest({ user });
      setDigest(payload || null);
    } catch (error) {
      setDigestError(describeAgentApiError(error, "The digest could not be refreshed."));
    } finally {
      setIsRefreshingDigest(false);
    }
  };

  const handleAgentCreated = (agentCreated) => {
    // Show the new agent immediately even if the follow-up list refresh fails
    // (e.g. a transient edge 403) — the create response already confirmed it.
    setAgents((current) => {
      const list = Array.isArray(current) ? current : [];
      if (!agentCreated?.id || list.some((agent) => agent.id === agentCreated.id)) {
        return list;
      }
      return [
        ...list,
        {
          id: agentCreated.id,
          name: agentCreated.name,
          agentType: agentCreated.agentType,
          status: "ACTIVE",
          permissionLevel: "READ_ONLY",
          instructions: null,
          definitionOfDone: null,
          toolAccess: null,
          schedule: null,
          latestRun: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
    });
    void refreshAgents();
    setToast(`"${agentCreated.name}" was created and is ready to go.`);
    window.setTimeout(() => setToast(""), 6000);
  };

  // ── Loading / error shell ──────────────────────────────────────────────────
  if (isLoading && !ceoAgent) {
    return (
      <div style={{ ...styles.panel, padding: 32, textAlign: "center" }}>
        <div style={{ fontSize: 44, color: "#00d8ff", textShadow: "0 0 25px rgba(0,216,255,.7)" }}>◈</div>
        <div style={{ color: "white", fontSize: 20, fontWeight: 800, marginTop: 12 }}>Freedom OS</div>
        <div style={{ color: "#8faecc", fontSize: 14, marginTop: 8 }}>Waking up your CEO Agent…</div>
      </div>
    );
  }

  if (!ceoAgent && ceoError) {
    return (
      <div style={{ ...styles.panel, padding: 32, display: "grid", gap: 14, justifyItems: "start" }}>
        <h1 style={styles.pageTitle}>Freedom OS</h1>
        <div style={fosStyles.errorBox}>{ceoError}</div>
        <button type="button" style={fosStyles.secondaryButton} onClick={reload}>
          Retry
        </button>
      </div>
    );
  }

  // ── Onboarding gate ────────────────────────────────────────────────────────
  if (ceoAgent && !ceoAgent.onboardingCompletedAt) {
    return (
      <OnboardingInterview
        user={user}
        onComplete={(updatedCeo) => {
          if (updatedCeo) {
            setCeoAgent(updatedCeo);
          } else {
            // 409 / no payload — onboarding finished elsewhere; refetch state.
            reload();
          }
        }}
      />
    );
  }

  // ── Sub-views ──────────────────────────────────────────────────────────────
  if (view === "profile") {
    return <ProfileView user={user} onBack={() => setView("settings")} />;
  }

  if (view === "settings") {
    return (
      <CeoSettingsPanel
        ceoAgent={ceoAgent}
        user={user}
        onBack={() => setView("home")}
        onSaved={(updatedCeo) => setCeoAgent(updatedCeo)}
        onOpenProfile={() => setView("profile")}
      />
    );
  }

  const selectedAgent = selectedAgentId
    ? (agents || []).find((agent) => agent.id === selectedAgentId) || null
    : null;

  if (selectedAgent) {
    return (
      <AgentDetail
        key={selectedAgent.id}
        agent={selectedAgent}
        user={user}
        onBack={() => setSelectedAgentId(null)}
        onOpenFinanceTool={onOpenFinanceTool}
        onAgentUpdated={(updatedAgent) =>
          setAgents((current) =>
            (current || []).map((agent) =>
              agent.id === updatedAgent.id ? { ...agent, ...updatedAgent } : agent
            )
          )
        }
      />
    );
  }

  // ── Home ───────────────────────────────────────────────────────────────────
  // ChatGPT/Claude-style primary surface: CEO conversations + chat first.
  // Daily digest is secondary. Sub-agent chats live only on AgentDetail.
  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div style={styles.pageHeader}>
        <div>
          <h1 style={styles.pageTitle}>Freedom OS</h1>
          <p style={styles.pageSubtitle}>Your agents, briefings, and one place to run it all.</p>
        </div>
        <NotificationsBell
          user={user}
          unreadCount={unreadCount}
          onUnreadCountChange={(next) => {
            setUnreadCount(next);
            void refreshUnreadCount();
          }}
        />
      </div>

      {toast ? <div style={fosStyles.noticeBox}>{toast}</div> : null}

      {/* CEO Agent chat workspace */}
      <div style={{ ...styles.panel, padding: 22, display: "grid", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <span
            style={{
              width: 52,
              height: 52,
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
              fontSize: 26,
              background: `${avatar.color}26`,
              border: `1px solid ${avatar.color}66`,
              boxShadow: `0 0 22px ${avatar.color}33`,
              flexShrink: 0,
            }}
          >
            {avatar.emoji}
          </span>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ color: "white", fontSize: 20, fontWeight: 900 }}>{ceoName}</div>
            <div style={{ color: "#9fb0c9", fontSize: 12, marginTop: 4 }}>
              {getPersonalityLabel(ceoAgent?.personalityPreset)} • Your main chat — separate from
              sub-agent threads
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" style={fosStyles.primaryButton} onClick={() => setIsNewAgentOpen(true)}>
              + New Agent
            </button>
            <button type="button" style={fosStyles.secondaryButton} onClick={() => setView("settings")}>
              Settings
            </button>
          </div>
        </div>

        <div
          style={{
            borderRadius: 12,
            border: "1px solid rgba(0,216,255,.14)",
            background: "rgba(0,136,255,.04)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: "100%",
              padding: "12px 16px",
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
              <div style={fosStyles.sectionLabel}>Daily digest</div>
              <span style={{ color: "#5f7896", fontSize: 11 }}>
                {digest?.generatedAt ? `Updated ${formatRelativeTime(digest.generatedAt)}` : "Briefing"}
              </span>
            </div>
            {isDigestOpen ? (
              <button
                type="button"
                disabled={isRefreshingDigest}
                onClick={() => void handleRefreshDigest()}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "#8feaff",
                  fontSize: 12,
                  padding: 0,
                  cursor: isRefreshingDigest ? "default" : "pointer",
                  opacity: isRefreshingDigest ? 0.6 : 1,
                }}
              >
                {isRefreshingDigest ? "Refreshing…" : "Refresh"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setIsDigestOpen((current) => !current)}
              style={{
                border: "none",
                background: "transparent",
                color: "#8feaff",
                fontSize: 12,
                padding: 0,
                cursor: "pointer",
              }}
            >
              {isDigestOpen ? "Hide ▴" : "Show ▾"}
            </button>
          </div>
          {isDigestOpen ? (
            <div style={{ padding: "0 16px 14px", display: "grid", gap: 10 }}>
              {digestError ? <div style={fosStyles.errorBox}>{digestError}</div> : null}
              {!digestError && digest?.digest ? (
                <div style={{ color: "#d7ebff", fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                  {digest.digest}
                </div>
              ) : null}
              {!digestError && !digest?.digest ? (
                <div style={{ color: "#8faecc", fontSize: 13 }}>
                  No digest yet — hit Refresh for your first briefing.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <AgentChat
          mode="ceo"
          agentName={ceoName}
          user={user}
          layout="workspace"
          listLabel={`${ceoName} chats`}
          placeholder={`Ask ${ceoName} anything about your money or your agents…`}
          onDigestUpdated={(nextDigest) => {
            setDigest(nextDigest || null);
            setDigestError("");
            setIsDigestOpen(true);
          }}
        />
      </div>

      {/* Agent grid */}
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={fosStyles.sectionLabel}>Your agents</div>
          <span style={{ color: "#5f7896", fontSize: 11 }}>
            {agents ? `${agents.length} agent${agents.length === 1 ? "" : "s"}` : ""}
          </span>
        </div>
        {agentsError ? <div style={fosStyles.errorBox}>{agentsError}</div> : null}
        {agents === null && !agentsError ? (
          <div style={{ color: "#8faecc", fontSize: 13 }}>Loading agents…</div>
        ) : null}
        {agents !== null && agents.length === 0 ? (
          <div
            style={{
              ...styles.panel,
              padding: 28,
              textAlign: "center",
              display: "grid",
              gap: 10,
              justifyItems: "center",
            }}
          >
            <div style={{ fontSize: 34 }}>◈</div>
            <div style={{ color: "white", fontWeight: 800, fontSize: 16 }}>No agents yet</div>
            <div style={{ color: "#9fb0c9", fontSize: 13 }}>
              Ask your CEO Agent to create one — it takes under a minute.
            </div>
            <button type="button" style={fosStyles.primaryButton} onClick={() => setIsNewAgentOpen(true)}>
              + New Agent
            </button>
          </div>
        ) : null}
        {agents?.length ? (
          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            }}
          >
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onOpen={() => {
                  if (agent.agentType === "finance" && typeof onOpenFinanceTool === "function") {
                    onOpenFinanceTool();
                  } else {
                    setSelectedAgentId(agent.id);
                  }
                }}
              />
            ))}
          </div>
        ) : null}
      </div>

      {isNewAgentOpen ? (
        <NewAgentFlow
          ceoAgent={ceoAgent}
          user={user}
          onClose={() => setIsNewAgentOpen(false)}
          onAgentCreated={handleAgentCreated}
        />
      ) : null}
    </div>
  );
}
