import { useCallback, useEffect, useState } from "react";
import { styles } from "../../styles.js";
import {
  deleteAgent,
  emailAgentRun,
  fetchAgentRuns,
  triggerAgentRun,
  updateAgent,
} from "../../utils/agentsApi.js";
import { AgentChat } from "./AgentChat.jsx";
import { ModelPicker } from "./ModelPicker.jsx";
import { PermissionLedger } from "./PermissionLedger.jsx";
import { TrustLadder } from "./TrustLadder.jsx";
import {
  DEFAULT_AGENT_MODEL,
  describeAgentApiError,
  formatDateTime,
  formatSchedule,
  fosStyles,
  getAgentTypeMeta,
  runStatusColor,
  statusBadgeStyle,
} from "./freedomOsShared.js";

const RUNS_PAGE_SIZE = 20;

function RunRow({ run, onAskAboutRun, onEmailRun }) {
  const [isEmailing, setIsEmailing] = useState(false);
  const [emailNote, setEmailNote] = useState("");
  const tokens = (run.tokensInput || 0) + (run.tokensOutput || 0);
  const canEmail = run.status === "SUCCEEDED" && typeof onEmailRun === "function";

  const handleEmail = async () => {
    if (isEmailing) return;
    setIsEmailing(true);
    setEmailNote("");
    try {
      const payload = await onEmailRun(run.id);
      setEmailNote(payload?.status || "Emailed to your verified account address.");
    } catch (error) {
      setEmailNote(error?.message || "The email could not be sent.");
    } finally {
      setIsEmailing(false);
    }
  };

  return (
    <div
      style={{
        borderRadius: 12,
        border: "1px solid rgba(30,144,255,.18)",
        background: "rgba(3,17,32,.6)",
        padding: "12px 14px",
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ color: runStatusColor(run.status), fontSize: 11, fontWeight: 900, letterSpacing: 0.6 }}>
          {run.status}
        </span>
        <span style={{ color: "#8faecc", fontSize: 11 }}>{formatDateTime(run.startedAt)}</span>
        {tokens > 0 ? (
          <span style={{ color: "#5f7896", fontSize: 11 }}>
            {tokens.toLocaleString()} tokens
            {run.estimatedCostUsd != null ? ` • ~$${Number(run.estimatedCostUsd).toFixed(4)}` : ""}
          </span>
        ) : null}
      </div>
      <div style={{ color: "#d7ebff", fontSize: 13, lineHeight: 1.55 }}>
        {run.summary || run.error || "No summary recorded for this run."}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={fosStyles.subtleButton} onClick={() => onAskAboutRun(run.id)}>
          Ask about this run
        </button>
        {canEmail ? (
          <button
            type="button"
            style={{ ...fosStyles.subtleButton, opacity: isEmailing ? 0.6 : 1 }}
            disabled={isEmailing}
            onClick={() => void handleEmail()}
          >
            {isEmailing ? "Emailing…" : "Email me this run"}
          </button>
        ) : null}
      </div>
      {emailNote ? (
        <div style={{ color: "#8faecc", fontSize: 12, lineHeight: 1.5 }}>{emailNote}</div>
      ) : null}
    </div>
  );
}

export function AgentDetail({
  agent,
  user,
  onBack,
  onAgentUpdated,
  onAgentDeleted = null,
  onOpenFinanceTool = null,
}) {
  const [runs, setRuns] = useState(null);
  const [runsError, setRunsError] = useState("");
  const [hasMoreRuns, setHasMoreRuns] = useState(false);
  const [isLoadingMoreRuns, setIsLoadingMoreRuns] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [runNowError, setRunNowError] = useState("");
  const [isTogglingStatus, setIsTogglingStatus] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [dodDraft, setDodDraft] = useState(agent?.definitionOfDone || "");
  const [isSavingDod, setIsSavingDod] = useState(false);
  const [dodError, setDodError] = useState("");
  const [dodSavedAt, setDodSavedAt] = useState(null);
  const [modelDraft, setModelDraft] = useState(agent?.model || DEFAULT_AGENT_MODEL);
  const [isSavingModel, setIsSavingModel] = useState(false);
  const [modelError, setModelError] = useState("");
  const [modelSavedAt, setModelSavedAt] = useState(null);
  const [chatRelatedRunId, setChatRelatedRunId] = useState(null);
  const [isTogglingEmail, setIsTogglingEmail] = useState(false);
  const [emailToggleError, setEmailToggleError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const agentId = agent?.id || null;
  const meta = getAgentTypeMeta(agent?.agentType);

  // Callers render <AgentDetail key={agent.id}> so per-agent state resets via
  // remount; this effect loads the run history (and re-runs when a manual
  // trigger bumps runsReloadToken).
  const [runsReloadToken, setRunsReloadToken] = useState(0);
  const reloadRuns = useCallback(() => setRunsReloadToken((current) => current + 1), []);

  useEffect(() => {
    if (!agentId) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const payload = await fetchAgentRuns(agentId, { limit: RUNS_PAGE_SIZE }, { user });
        if (cancelled) return;
        setRuns(Array.isArray(payload?.runs) ? payload.runs : []);
        setHasMoreRuns(Boolean(payload?.hasMore));
        setRunsError("");
      } catch (error) {
        if (!cancelled) {
          setRunsError(describeAgentApiError(error, "Unable to load run history."));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [agentId, user, runsReloadToken]);

  const loadMoreRuns = async () => {
    if (!agentId || !runs?.length) return;
    setIsLoadingMoreRuns(true);
    try {
      const oldest = runs[runs.length - 1];
      const payload = await fetchAgentRuns(
        agentId,
        { limit: RUNS_PAGE_SIZE, before: oldest.startedAt },
        { user }
      );
      setRuns((current) => [...(current || []), ...(payload?.runs || [])]);
      setHasMoreRuns(Boolean(payload?.hasMore));
    } catch (error) {
      setRunsError(describeAgentApiError(error, "Unable to load more runs."));
    } finally {
      setIsLoadingMoreRuns(false);
    }
  };

  const handleRunNow = async () => {
    if (!agentId || isRunning) return;
    setIsRunning(true);
    setRunNowError("");
    try {
      // The run endpoint executes synchronously and returns the finished run.
      const payload = await triggerAgentRun(agentId, { user });
      if (payload?.run) {
        setRuns((current) => [payload.run, ...(current || [])]);
      } else {
        reloadRuns();
      }
    } catch (error) {
      setRunNowError(describeAgentApiError(error, "The run could not be started."));
    } finally {
      setIsRunning(false);
    }
  };

  const handleToggleStatus = async () => {
    if (!agentId || isTogglingStatus) return;
    const nextStatus = agent.status === "PAUSED" ? "ACTIVE" : "PAUSED";
    setIsTogglingStatus(true);
    setStatusError("");
    try {
      const payload = await updateAgent(agentId, { status: nextStatus }, { user });
      if (payload?.agent) onAgentUpdated?.(payload.agent);
    } catch (error) {
      setStatusError(describeAgentApiError(error, "Unable to update the agent status."));
    } finally {
      setIsTogglingStatus(false);
    }
  };

  const handleDeleteAgent = async () => {
    if (!agentId || isDeleting) return;
    setIsDeleting(true);
    setDeleteError("");
    try {
      await deleteAgent(agentId, { user });
      if (typeof onAgentDeleted === "function") {
        onAgentDeleted(agent);
      } else {
        onBack?.();
      }
    } catch (error) {
      setDeleteError(describeAgentApiError(error, "Unable to delete this agent."));
      setIsDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleSaveDod = async () => {
    if (!agentId || isSavingDod) return;
    const trimmed = dodDraft.trim();
    if (!trimmed) {
      setDodError("The definition of done cannot be empty.");
      return;
    }
    setIsSavingDod(true);
    setDodError("");
    try {
      const payload = await updateAgent(agentId, { definitionOfDone: trimmed }, { user });
      if (payload?.agent) onAgentUpdated?.(payload.agent);
      setDodSavedAt(Date.now());
    } catch (error) {
      setDodError(describeAgentApiError(error, "Unable to save the definition of done."));
    } finally {
      setIsSavingDod(false);
    }
  };

  const emailEnabled = agent?.toolAccess?.email === true;
  const handleToggleEmailDelivery = async () => {
    if (!agentId || isTogglingEmail) return;
    setIsTogglingEmail(true);
    setEmailToggleError("");
    try {
      const payload = await updateAgent(
        agentId,
        { toolAccess: emailEnabled ? {} : { email: true } },
        { user }
      );
      if (payload?.agent) onAgentUpdated?.(payload.agent);
    } catch (error) {
      setEmailToggleError(describeAgentApiError(error, "Unable to update email delivery."));
    } finally {
      setIsTogglingEmail(false);
    }
  };

  const handleEmailRun = (runId) => emailAgentRun(agentId, runId, { user });

  const handleSaveModel = async () => {
    if (!agentId || isSavingModel) return;
    setIsSavingModel(true);
    setModelError("");
    try {
      const payload = await updateAgent(agentId, { model: modelDraft }, { user });
      if (payload?.agent) onAgentUpdated?.(payload.agent);
      setModelSavedAt(Date.now());
    } catch (error) {
      setModelError(describeAgentApiError(error, "Unable to update the model."));
    } finally {
      setIsSavingModel(false);
    }
  };

  if (!agent) return null;

  const isPaused = agent.status === "PAUSED";
  const dodDirty = dodDraft.trim() !== (agent.definitionOfDone || "").trim();
  const modelDirty = modelDraft !== (agent.model || DEFAULT_AGENT_MODEL);

  return (
    <div style={{ ...styles.panel, padding: 24, display: "grid", gap: 22 }}>
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
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, color: "white", fontSize: 26, fontWeight: 800 }}>
              {meta.icon} {agent.name}
            </h2>
            <span
              style={{
                ...fosStyles.badge,
                border: `1px solid ${meta.color}55`,
                background: `${meta.color}1a`,
                color: meta.color,
              }}
            >
              {meta.label}
            </span>
            <span style={statusBadgeStyle(agent.status)}>{isPaused ? "Paused" : "Active"}</span>
          </div>
          <div style={{ color: "#9fb0c9", fontSize: 13, marginTop: 8 }}>
            Schedule: {formatSchedule(agent.schedule)}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {agent.agentType === "finance" && typeof onOpenFinanceTool === "function" ? (
            <button type="button" style={fosStyles.secondaryButton} onClick={onOpenFinanceTool}>
              Open Finance tool
            </button>
          ) : null}
          <button
            type="button"
            style={{ ...fosStyles.secondaryButton, opacity: isTogglingStatus ? 0.6 : 1 }}
            disabled={isTogglingStatus}
            onClick={handleToggleStatus}
          >
            {isTogglingStatus ? "Saving…" : isPaused ? "Resume agent" : "Pause agent"}
          </button>
          <button
            type="button"
            style={{ ...fosStyles.primaryButton, opacity: isRunning ? 0.6 : 1 }}
            disabled={isRunning}
            onClick={handleRunNow}
          >
            {isRunning ? "Running…" : "Run now"}
          </button>
        </div>
      </div>
      {statusError ? <div style={fosStyles.errorBox}>{statusError}</div> : null}
      {runNowError ? <div style={fosStyles.errorBox}>{runNowError}</div> : null}

      {/* Sub-agent chat is scoped to this agent only — never mixed with CEO chats. */}
      <div style={{ display: "grid", gap: 10 }}>
        <div>
          <div style={fosStyles.sectionLabel}>Chat with {agent.name}</div>
          <div style={{ color: "#8faecc", fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
            Ask this agent to change its own schedule, instructions, email settings, or to run now.
            Talk to your CEO Agent from the Freedom OS home for cross-agent questions.
          </div>
        </div>
        <AgentChat
          mode="agent"
          agentId={agent.id}
          agentName={agent.name}
          user={user}
          relatedRunId={chatRelatedRunId}
          onClearRelatedRun={() => setChatRelatedRunId(null)}
          onAgentUpdated={(updated) => {
            onAgentUpdated?.(updated);
            if (updated?.definitionOfDone != null) setDodDraft(updated.definitionOfDone);
            if (updated?.model) setModelDraft(updated.model);
          }}
          onRunStarted={() => reloadRuns()}
          listLabel={`${agent.name} chats`}
          placeholder={`Ask ${agent.name} about its work or to update its settings…`}
        />
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <div style={fosStyles.sectionLabel}>Model</div>
        <p style={{ margin: 0, color: "#9fb0c9", fontSize: 12, lineHeight: 1.55 }}>
          Used for this agent&apos;s chat and runs. Independent of your CEO Agent model.
        </p>
        <ModelPicker
          value={modelDraft}
          onChange={setModelDraft}
          disabled={isSavingModel}
          name={`agent-model-${agent.id}`}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            style={{
              ...fosStyles.secondaryButton,
              opacity: !modelDirty || isSavingModel ? 0.55 : 1,
            }}
            disabled={!modelDirty || isSavingModel}
            onClick={() => void handleSaveModel()}
          >
            {isSavingModel ? "Saving…" : "Save model"}
          </button>
          {modelSavedAt && !modelDirty ? (
            <span style={{ color: "#7cf1af", fontSize: 12, fontWeight: 700 }}>Saved</span>
          ) : null}
        </div>
        {modelError ? <div style={fosStyles.errorBox}>{modelError}</div> : null}
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        <div style={fosStyles.sectionLabel}>Definition of done</div>
        <textarea
          value={dodDraft}
          onChange={(event) => setDodDraft(event.target.value)}
          rows={3}
          maxLength={500}
          style={{
            ...fosStyles.input,
            resize: "vertical",
            fontFamily: styles.page.fontFamily,
            lineHeight: 1.6,
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            style={{
              ...fosStyles.secondaryButton,
              opacity: !dodDirty || isSavingDod ? 0.55 : 1,
              cursor: !dodDirty || isSavingDod ? "default" : "pointer",
            }}
            disabled={!dodDirty || isSavingDod}
            onClick={handleSaveDod}
          >
            {isSavingDod ? "Saving…" : "Save definition"}
          </button>
          {dodSavedAt && !dodDirty ? (
            <span style={{ color: "#7cf1af", fontSize: 12, fontWeight: 700 }}>Saved</span>
          ) : null}
        </div>
        {dodError ? <div style={fosStyles.errorBox}>{dodError}</div> : null}
      </div>

      {agent.agentType !== "email" ? (
      <div style={{ display: "grid", gap: 10 }}>
        <div style={fosStyles.sectionLabel}>Email delivery</div>
        <div style={{ color: "#9fb0c9", fontSize: 13, lineHeight: 1.6 }}>
          When enabled, each run&apos;s report is also emailed to your own verified account
          address — never anyone else. You can also email any single run from its row below.
        </div>
        {user && user.emailVerified === false ? (
          <div style={{ color: "#ffcf9d", fontSize: 12, lineHeight: 1.5 }}>
            Your account email is not verified yet, so emails will be skipped until you verify
            it from your account settings.
          </div>
        ) : null}
        <div>
          <button
            type="button"
            style={{ ...fosStyles.secondaryButton, opacity: isTogglingEmail ? 0.6 : 1 }}
            disabled={isTogglingEmail}
            onClick={() => void handleToggleEmailDelivery()}
          >
            {isTogglingEmail
              ? "Saving…"
              : emailEnabled
                ? "Disable email delivery"
                : "Email me each run's report"}
          </button>
        </div>
        {emailToggleError ? <div style={fosStyles.errorBox}>{emailToggleError}</div> : null}
      </div>
      ) : null}

      <div style={{ display: "grid", gap: 12 }}>
        <div style={fosStyles.sectionLabel}>Run history</div>
        {runsError ? <div style={fosStyles.errorBox}>{runsError}</div> : null}
        {runs === null && !runsError ? (
          <div style={{ color: "#8faecc", fontSize: 13 }}>Loading runs…</div>
        ) : null}
        {runs !== null && runs.length === 0 ? (
          <div style={{ color: "#8faecc", fontSize: 13 }}>
            No runs yet — use “Run now” or wait for the schedule.
          </div>
        ) : null}
        {(runs || []).map((run) => (
          <RunRow
            key={run.id}
            run={run}
            onAskAboutRun={(runId) => setChatRelatedRunId(runId)}
            onEmailRun={handleEmailRun}
          />
        ))}
        {hasMoreRuns ? (
          <div>
            <button
              type="button"
              style={{ ...fosStyles.subtleButton, opacity: isLoadingMoreRuns ? 0.6 : 1 }}
              disabled={isLoadingMoreRuns}
              onClick={() => void loadMoreRuns()}
            >
              {isLoadingMoreRuns ? "Loading…" : "Load older runs"}
            </button>
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: "grid",
          gap: 22,
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        }}
      >
        <PermissionLedger
          agentType={agent.agentType}
          toolAccess={agent.toolAccess}
          permissionLevel={agent.permissionLevel}
        />
        <TrustLadder permissionLevel={agent.permissionLevel} />
      </div>

      <div
        style={{
          borderTop: "1px solid rgba(255,93,122,.18)",
          paddingTop: 18,
          display: "grid",
          gap: 10,
        }}
      >
        <div style={{ ...fosStyles.sectionLabel, color: "#ffb3c0" }}>Remove agent</div>
        {!confirmDelete ? (
          <>
            <div style={{ color: "#8faecc", fontSize: 13, lineHeight: 1.55 }}>
              Deletes this agent&apos;s config and chats. Past run history stays in your account for
              audit and digest context.
            </div>
            <div>
              <button
                type="button"
                style={{
                  border: "none",
                  background: "transparent",
                  color: "#ff8fa3",
                  cursor: "pointer",
                  fontWeight: 800,
                  fontSize: 13,
                  padding: 0,
                }}
                onClick={() => {
                  setDeleteError("");
                  setConfirmDelete(true);
                }}
              >
                Delete agent
              </button>
            </div>
          </>
        ) : (
          <div style={fosStyles.errorBox}>
            <div style={{ marginBottom: 10 }}>
              Delete <strong>{agent.name}</strong>? Its chat and config go away. Past run history
              stays in your account.
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                style={{
                  ...fosStyles.secondaryButton,
                  border: "1px solid rgba(255,93,122,.45)",
                  background: "rgba(255,36,77,.16)",
                  color: "#ffd9df",
                  opacity: isDeleting ? 0.6 : 1,
                }}
                disabled={isDeleting}
                onClick={() => void handleDeleteAgent()}
              >
                {isDeleting ? "Deleting…" : "Yes, delete it"}
              </button>
              <button
                type="button"
                style={{ ...fosStyles.subtleButton, opacity: isDeleting ? 0.6 : 1 }}
                disabled={isDeleting}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {deleteError ? <div style={fosStyles.errorBox}>{deleteError}</div> : null}
      </div>
    </div>
  );
}
