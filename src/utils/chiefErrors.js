// Classifies CHIEF failures that already surface through chat, voice, and
// memory. Unknown failures stay generic. This module does not invent a cause,
// and it does not return provider bodies, paths, secrets, or stack traces.

export const CHIEF_FAILURE_MESSAGE = Object.freeze({
  managedUnconfigured:
    "Claude Managed Agents is not configured. Set ANTHROPIC_API_KEY on the server.",
  managedTemporary: "CHIEF could not reach Claude. Send it again in a moment.",
  managedSession: "Claude did not start this conversation. Send it again.",
  workspace: "That file change is not allowed in the CHIEF workspace.",
  memory: "CHIEF could not store that in memory. Do not treat it as remembered.",
  approval: "CHIEF is waiting for your approval before it continues.",
  approvalGone: "That approval is no longer pending.",
  cursor:
    "Cursor is not configured. Set CURSOR_API_KEY on the server before CHIEF can open a pull request.",
  elevenlabsUnconfigured: "ElevenLabs is not configured.",
  elevenlabs: "CHIEF could not speak this reply. The written answer is still here.",
  playbackBlocked: "Playback is blocked. Tap Play response to hear this answer.",
  voiceUnconfigured: "Spoken voice is not configured.",
  voiceRequired: "Choose a voice before CHIEF can speak.",
  voiceAuth: "Spoken voice could not sign in.",
  voiceBusy: "Spoken voice is busy. Try again in a moment.",
  voicePlayback: "CHIEF could not play that response.",
  voiceNetwork: "CHIEF could not reach voice.",
  voiceStopped: "CHIEF voice stopped.",
  micUnavailable: "No microphone is available.",
  micMissing: "No microphone was found.",
  micDenied: "Microphone permission was denied.",
  micOff: "Microphone permission is off.",
  micUnsupported: "This browser cannot hear speech. Type to CHIEF instead.",
  speechUnsupported: "Speech recognition is not available in this browser.",
  speechNetwork: "Speech recognition needs a network connection.",
  turnInterrupted: "CHIEF could not complete that request. Send it again to continue.",
  turnEmpty: "CHIEF did not return an answer.",
  turnFinish: "CHIEF could not finish that response.",
  turnDeclined: "CHIEF declined that request.",
  turnBudget: "CHIEF stopped because the response budget was reached.",
  unknown: "The turn could not be completed.",
});

export const UNFINISHED_TURN_MESSAGE = CHIEF_FAILURE_MESSAGE.turnInterrupted;

const MANAGED_OPS =
  /^(listAgents|createAgent|listEvents|sendEvents|createSession|listMemoryStores|createMemoryStore|retrieveEnvironment|createEnvironment)$/;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeUserSentence(message) {
  if (!message || message.length > 180 || message.includes("\n")) return false;
  return !/prisma|stack|node_modules|TypeError|ReferenceError|postgres|sk-|whsec_|BSA-|@/i.test(
    message
  );
}

function outcome(fields) {
  return {
    category: fields.category,
    duration: fields.duration,
    message: fields.message,
    known: fields.known,
    operation: fields.operation,
    component: fields.component,
    terminal: fields.terminal,
    completed: fields.completed === true,
    interrupted: fields.interrupted === true,
  };
}

function unknownDuration(status, name) {
  if (status === 408 || status === 409 || status === 429) return "temporary";
  if (typeof status === "number" && status >= 500) return "temporary";
  if (status == null && (name === "TypeError" || name === "FetchError")) return "temporary";
  return "permanent";
}

function isManagedCall(component, operation) {
  return component === "managed_agent" || MANAGED_OPS.test(operation);
}

export function classifyChiefFailure(input = {}) {
  const message = text(input.message);
  const code = text(input.code);
  const name = text(input.name);
  const operation = text(input.operation) || "turn";
  const component = text(input.component);
  const turnStatus = text(input.turnStatus);
  const status = Number.isInteger(input.status) ? input.status : null;

  if (
    turnStatus === "suspended" ||
    code === "approval" ||
    message === CHIEF_FAILURE_MESSAGE.approval ||
    message === CHIEF_FAILURE_MESSAGE.approvalGone
  ) {
    const stale = message === CHIEF_FAILURE_MESSAGE.approvalGone;
    return outcome({
      category: "approval",
      duration: "approval",
      message: stale ? CHIEF_FAILURE_MESSAGE.approvalGone : CHIEF_FAILURE_MESSAGE.approval,
      known: true,
      operation,
      component: "approval",
      terminal: false,
    });
  }

  if (component === "speech" && (code === "aborted" || code === "no-speech")) {
    return outcome({
      category: "microphone",
      duration: "temporary",
      message: "",
      known: true,
      operation,
      component: "microphone",
      terminal: false,
    });
  }

  const microphone = classifyMicrophone({ message, code, component, operation });
  if (microphone) return microphone;

  const voice = classifyVoice({ message, code, component, operation });
  if (voice) return voice;

  if (
    component === "cursor" ||
    code === "cursor_not_configured" ||
    (/cursor/i.test(message) && /not configured|CURSOR_API_KEY|api key/i.test(message))
  ) {
    const kept =
      safeUserSentence(message) && /cursor/i.test(message) ? message : CHIEF_FAILURE_MESSAGE.cursor;
    return outcome({
      category: "cursor",
      duration: "permanent",
      message: kept,
      known: true,
      operation,
      component: "cursor",
      terminal: true,
    });
  }

  if (
    code === "workspace_denied" ||
    message === CHIEF_FAILURE_MESSAGE.workspace ||
    (component === "workspace" && /denied|not permitted|not allowed/i.test(message))
  ) {
    return outcome({
      category: "workspace",
      duration: "permanent",
      message: CHIEF_FAILURE_MESSAGE.workspace,
      known: true,
      operation,
      component: "workspace",
      terminal: true,
    });
  }

  if (
    /did not return a memory store/i.test(message) ||
    /encryption is not configured/i.test(message) ||
    message === CHIEF_FAILURE_MESSAGE.memory ||
    (component === "memory" && (/not configured/i.test(message) || /^P\d+/.test(code)))
  ) {
    return outcome({
      category: "memory",
      duration: "permanent",
      message: CHIEF_FAILURE_MESSAGE.memory,
      known: true,
      operation,
      component: "memory",
      terminal: true,
    });
  }

  if (
    message.startsWith("Claude Managed Agents is not configured") ||
    /ANTHROPIC_API_KEY is not configured/i.test(message)
  ) {
    return outcome({
      category: "managed_agent",
      duration: "permanent",
      message: CHIEF_FAILURE_MESSAGE.managedUnconfigured,
      known: true,
      operation,
      component: "managed_agent",
      terminal: true,
    });
  }

  if (/did not return a (session id|agent version|environment)\b/i.test(message)) {
    return outcome({
      category: "managed_agent",
      duration: "permanent",
      message: CHIEF_FAILURE_MESSAGE.managedSession,
      known: true,
      operation,
      component: "managed_agent",
      terminal: true,
    });
  }

  const network =
    status == null &&
    (name === "TypeError" || name === "FetchError") &&
    /fetch failed|failed to fetch|network error|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i.test(message);
  const retryStatus = status === 408 || status === 429;
  if (
    (network || retryStatus) &&
    (isManagedCall(component, operation) || network) &&
    component !== "elevenlabs" &&
    component !== "microphone" &&
    component !== "speech" &&
    component !== "voice"
  ) {
    return outcome({
      category: "managed_agent",
      duration: "temporary",
      message: CHIEF_FAILURE_MESSAGE.managedTemporary,
      known: true,
      operation,
      component: "managed_agent",
      terminal: false,
    });
  }

  if (turnStatus === "completed") {
    return outcome({
      category: "turn",
      duration: "permanent",
      message: "",
      known: true,
      operation,
      component: "turn",
      terminal: false,
      completed: true,
    });
  }

  if (turnStatus === "continuing" || turnStatus === "running") {
    return outcome({
      category: "managed_agent",
      duration: "temporary",
      message: "",
      known: true,
      operation,
      component: "managed_agent",
      terminal: false,
    });
  }

  const turn = classifyTurnMessage(message, turnStatus, operation);
  if (turn) return turn;

  return outcome({
    category: "unknown",
    duration: unknownDuration(status, name),
    message: CHIEF_FAILURE_MESSAGE.unknown,
    known: false,
    operation,
    component: component || (isManagedCall("", operation) ? "managed_agent" : "turn"),
    terminal: unknownDuration(status, name) !== "temporary",
  });
}

function classifyMicrophone({ message, code, component, operation }) {
  const speech = component === "speech" || component === "microphone";
  const codes = {
    mic_unavailable: CHIEF_FAILURE_MESSAGE.micUnavailable,
    "audio-capture": CHIEF_FAILURE_MESSAGE.micMissing,
    permission_denied: CHIEF_FAILURE_MESSAGE.micOff,
    "not-allowed": CHIEF_FAILURE_MESSAGE.micDenied,
    "service-not-allowed": CHIEF_FAILURE_MESSAGE.micDenied,
    unsupported: speech
      ? component === "speech"
        ? CHIEF_FAILURE_MESSAGE.speechUnsupported
        : CHIEF_FAILURE_MESSAGE.micUnsupported
      : "",
    network: component === "speech" ? CHIEF_FAILURE_MESSAGE.speechNetwork : "",
  };
  const fromCode = codes[code] || "";
  const fromMessage =
    message === CHIEF_FAILURE_MESSAGE.micUnavailable ||
    message === CHIEF_FAILURE_MESSAGE.micMissing ||
    message === CHIEF_FAILURE_MESSAGE.micDenied ||
    message === CHIEF_FAILURE_MESSAGE.micOff ||
    message === CHIEF_FAILURE_MESSAGE.micUnsupported ||
    message === CHIEF_FAILURE_MESSAGE.speechUnsupported ||
    message === CHIEF_FAILURE_MESSAGE.speechNetwork
      ? message
      : "";
  if (!fromCode && !fromMessage) return null;
  const temporary = code === "network";
  return outcome({
    category: "microphone",
    duration: temporary ? "temporary" : "permanent",
    message: fromCode || fromMessage,
    known: true,
    operation,
    component: "microphone",
    terminal: !temporary,
  });
}

function classifyVoice({ message, code, component, operation }) {
  const voice = component === "voice" || component === "elevenlabs";
  if (
    message === CHIEF_FAILURE_MESSAGE.playbackBlocked ||
    code === "playback_blocked" ||
    code === "blocked"
  ) {
    return outcome({
      category: "elevenlabs",
      duration: "permanent",
      message: CHIEF_FAILURE_MESSAGE.playbackBlocked,
      known: true,
      operation,
      component: "elevenlabs",
      terminal: false,
    });
  }
  if (
    message === CHIEF_FAILURE_MESSAGE.elevenlabsUnconfigured ||
    (voice && (code === "not_configured" || /elevenlabs is not configured/i.test(message)))
  ) {
    const kept =
      message === CHIEF_FAILURE_MESSAGE.voiceUnconfigured
        ? message
        : CHIEF_FAILURE_MESSAGE.elevenlabsUnconfigured;
    return outcome({
      category: "elevenlabs",
      duration: "permanent",
      message:
        code === "not_configured" && component === "voice"
          ? CHIEF_FAILURE_MESSAGE.voiceUnconfigured
          : kept,
      known: true,
      operation,
      component: "elevenlabs",
      terminal: false,
    });
  }
  const voiceCodes = {
    voice_required: CHIEF_FAILURE_MESSAGE.voiceRequired,
    authentication_failed: CHIEF_FAILURE_MESSAGE.voiceAuth,
    rate_limited: CHIEF_FAILURE_MESSAGE.voiceBusy,
    playback_failed: CHIEF_FAILURE_MESSAGE.voicePlayback,
    network: CHIEF_FAILURE_MESSAGE.voiceNetwork,
  };
  if (voice && voiceCodes[code]) {
    const temporary = code === "rate_limited" || code === "network";
    return outcome({
      category: "elevenlabs",
      duration: temporary ? "temporary" : "permanent",
      message: voiceCodes[code],
      known: true,
      operation,
      component: "elevenlabs",
      terminal: false,
    });
  }
  if (voice && /elevenlabs|could not speak|spoken voice|playback/i.test(message)) {
    return outcome({
      category: "elevenlabs",
      duration: "permanent",
      message: safeUserSentence(message) ? message : CHIEF_FAILURE_MESSAGE.elevenlabs,
      known: true,
      operation,
      component: "elevenlabs",
      terminal: false,
    });
  }
  if (
    message === CHIEF_FAILURE_MESSAGE.elevenlabs ||
    message === CHIEF_FAILURE_MESSAGE.voiceBusy ||
    message === CHIEF_FAILURE_MESSAGE.voiceNetwork ||
    message === CHIEF_FAILURE_MESSAGE.voicePlayback ||
    message === CHIEF_FAILURE_MESSAGE.voiceAuth ||
    message === CHIEF_FAILURE_MESSAGE.voiceRequired ||
    message === CHIEF_FAILURE_MESSAGE.voiceStopped
  ) {
    const temporary =
      message === CHIEF_FAILURE_MESSAGE.voiceBusy || message === CHIEF_FAILURE_MESSAGE.voiceNetwork;
    return outcome({
      category: "elevenlabs",
      duration: temporary ? "temporary" : "permanent",
      message,
      known: true,
      operation,
      component: "elevenlabs",
      terminal: false,
    });
  }
  return null;
}

function classifyTurnMessage(message, turnStatus, operation) {
  const exact = {
    [CHIEF_FAILURE_MESSAGE.turnEmpty]: CHIEF_FAILURE_MESSAGE.turnEmpty,
    [CHIEF_FAILURE_MESSAGE.turnFinish]: CHIEF_FAILURE_MESSAGE.turnFinish,
    [CHIEF_FAILURE_MESSAGE.turnDeclined]: CHIEF_FAILURE_MESSAGE.turnDeclined,
    [CHIEF_FAILURE_MESSAGE.turnBudget]: CHIEF_FAILURE_MESSAGE.turnBudget,
    [CHIEF_FAILURE_MESSAGE.turnInterrupted]: CHIEF_FAILURE_MESSAGE.turnInterrupted,
  };
  if (exact[message]) {
    return outcome({
      category: "turn",
      duration: "permanent",
      message,
      known: true,
      operation,
      component: "turn",
      terminal: true,
      interrupted: message === CHIEF_FAILURE_MESSAGE.turnInterrupted,
      completed: false,
    });
  }
  if (message.startsWith("CHIEF could not complete that request")) {
    return outcome({
      category: "turn",
      duration: "permanent",
      message: CHIEF_FAILURE_MESSAGE.turnInterrupted,
      known: true,
      operation,
      component: "turn",
      terminal: true,
      interrupted: true,
    });
  }
  if (turnStatus === "empty") {
    return outcome({
      category: "turn",
      duration: "permanent",
      message: CHIEF_FAILURE_MESSAGE.turnEmpty,
      known: true,
      operation,
      component: "turn",
      terminal: true,
      interrupted: false,
    });
  }
  if (turnStatus === "failed") {
    return outcome({
      category: "turn",
      duration: "permanent",
      message: CHIEF_FAILURE_MESSAGE.turnInterrupted,
      known: true,
      operation,
      component: "turn",
      terminal: true,
      interrupted: true,
    });
  }
  return null;
}

export function classifyTurnOutcome({ status = "", text = "" } = {}) {
  const visible = text.trim();
  const classified = classifyChiefFailure({ turnStatus: status, message: visible });
  if (status === "failed") {
    return {
      ...classified,
      completed: false,
      interrupted: classified.message === CHIEF_FAILURE_MESSAGE.turnInterrupted,
    };
  }
  if (status === "empty") {
    return { ...classified, completed: false, interrupted: false };
  }
  if (status === "completed") {
    return { ...classified, completed: true, interrupted: false, message: "" };
  }
  return classified;
}
