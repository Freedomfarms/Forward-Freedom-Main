export function logInternalError(context, error) {
  console.error(`[${context}]`, error);
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
