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

export function respondInternalError(response, context, error, message = buildInternalErrorResponse().message) {
  logInternalError(context, error);
  return response.status(500).json(buildInternalErrorResponse(message));
}
