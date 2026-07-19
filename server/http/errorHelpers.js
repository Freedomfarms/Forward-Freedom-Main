import { describeDatabaseError } from "../db/describeDatabaseError.js";
import { summarizeError } from "../security/redaction.js";

export function logInternalError(context, error) {
  // Never log the raw error object: axios/Plaid errors carry the request config
  // (Plaid secrets) and response payloads (financial data) on enumerable
  // properties that console.error would serialize. Log a redacted summary only.
  console.error(`[${context}]`, JSON.stringify(summarizeError(error)));
}

export function buildInternalErrorResponse(message = "An unexpected error occurred. Please try again later.") {
  return {
    error: true,
    message,
  };
}

function withDatabaseDiagnostic(message, error) {
  const diagnostic = describeDatabaseError(error);
  if (!diagnostic || message.includes(diagnostic)) return message;
  return `${message} (${diagnostic})`;
}

export function respondInternalError(response, context, error, message = buildInternalErrorResponse().message) {
  logInternalError(context, error);
  // Append a short redacted DB diagnostic (role, code, driver line) so
  // connection/grant/schema failures are identifiable from the UI during
  // rollout without digging through serverless logs. Non-DB errors still
  // produce a useful "role … — <message>" line when DATABASE_URL is set.
  return response.status(500).json(buildInternalErrorResponse(withDatabaseDiagnostic(message, error)));
}
