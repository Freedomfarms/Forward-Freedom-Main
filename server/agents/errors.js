// Typed error for the agent platform. `code` is a stable machine-readable
// identifier (the HTTP layer added in the next phase maps `status` onto the
// response); message text is always safe to store on AgentRun.error and to
// show to the user.
export class AgentError extends Error {
  constructor(message, code = "AGENT_ERROR", status = 400) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.status = status;
  }
}

export function isAgentError(error) {
  return error instanceof AgentError || error?.name === "AgentError";
}

// Renders any thrown value into text safe for the AgentRun.error column.
export function describeAgentError(error) {
  if (!error) return "Agent run failed for an unknown reason.";
  const message = typeof error.message === "string" && error.message ? error.message : String(error);
  return isAgentError(error) ? `${error.code}: ${message}` : message;
}
