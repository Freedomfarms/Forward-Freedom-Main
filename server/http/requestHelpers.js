// Reads a dynamic path segment, working both on Vercel (which exposes [name]
// segments on request.query) and on the local Express server (request.params).
export function readPathParam(request, name) {
  const fromParams = request?.params?.[name];
  const fromQuery = request?.query?.[name];
  const raw = fromParams ?? (Array.isArray(fromQuery) ? fromQuery[0] : fromQuery);
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || null;
}

// Reads and parses a JSON request body, working both on Vercel (which
// pre-parses JSON bodies onto request.body) and on the local Express server.
// Invalid JSON raises a 400-tagged error the API handlers surface directly.
export async function readJsonBody(request) {
  if (request.body && typeof request.body === "object") {
    return request.body;
  }

  const chunks = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (!chunks.length) return {};

  const rawBody = Buffer.concat(chunks).toString("utf8");
  if (!rawBody) return {};

  try {
    return JSON.parse(rawBody);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}
