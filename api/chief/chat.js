// CHIEF chat — one turn over SSE.
//
// The active conversation path is Claude Managed Agents. The previous custom
// reasoning classes remain in the repository and are not called from here.
// A missing provider configuration is an error, not a legacy fallback.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { createManagedClient, runManagedChiefTurn } from "../../server/chief/managed/chatTurn.js";
import { providerErrorFields } from "../../server/chief/managed/redact.js";
import { MANAGED_SCHEDULE_ORIGIN } from "../../server/chief/managed/productionAgent.js";
import { encodeSseEvent, eventMsg, makeEvent } from "../../server/chief/protocol/index.js";
import { PrismaCheckpointStore } from "../../server/chief/runtime/checkpoint.js";
import { titleFromTranscript } from "../../server/chief/runtime/conversationTitle.js";
import { createChiefTooling } from "../../server/chief/tools/builtin.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

function defaultDeps() {
  return {
    store: new PrismaCheckpointStore(),
    authenticate: authenticateRequest,
    createClient: () => createManagedClient(),
    createTooling: createChiefTooling,
  };
}

function configurationFailure(error) {
  return (
    error?.status === 503 &&
    typeof error.message === "string" &&
    error.message.startsWith("Claude Managed Agents is not configured")
  );
}

export async function handleChiefChat(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  if (request.method !== "POST") {
    response.status(405).json({ error: "POST required" });
    return;
  }

  const authenticate = deps.authenticate ?? authenticateRequest;
  let userId;
  try {
    userId = (await authenticate(request)).uid;
  } catch (error) {
    response.status(error.status || 401).json({ error: error.message || "Unauthorized" });
    return;
  }

  const body = request.body ?? {};
  if (!body.submission) {
    response.status(400).json({ error: "submission is required" });
    return;
  }

  const store = deps.store ?? new PrismaCheckpointStore();
  let existing = null;
  if (typeof body.session_id === "string" && body.session_id) {
    existing = await store.load(userId, body.session_id);
    if (existing?.archivedAt) {
      response.status(409).json({
        error: "This conversation is archived. Restore it before sending.",
      });
      return;
    }
  }

  response.status(200);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  if (existing?.checkpoint?.context?.origin === MANAGED_SCHEDULE_ORIGIN) {
    response.write(
      encodeSseEvent(
        makeEvent(
          eventMsg.submissionRejected(
            "This scheduled session continues from Approvals. Chat does not resume it."
          )
        )
      )
    );
    response.end();
    return;
  }
  const controller = new AbortController();
  request.on?.("close", () => controller.abort());

  let toolExecutor = deps.toolExecutor ?? null;
  let toolSpecs = deps.toolSpecs ?? null;
  if (!toolExecutor) {
    const tooling = await (deps.createTooling ?? createChiefTooling)({
      userId,
      stores: deps.stores ?? {},
      policy: deps.policy,
      audit: deps.audit,
    });
    toolExecutor = tooling.executor;
    toolSpecs = deps.toolSpecs ?? tooling.specs;
  }

  let client;
  if (Object.hasOwn(deps, "client")) {
    client = deps.client;
  } else {
    try {
      client = (deps.createClient ?? createManagedClient)();
    } catch (error) {
      if (!configurationFailure(error)) throw error;
      response.write(
        encodeSseEvent(
          makeEvent(
            eventMsg.error({
              kind: "internal",
              message: error.message,
              retryable: false,
            })
          )
        )
      );
      response.end();
      return;
    }
  }

  let result = null;
  let turnError = null;
  try {
    result = await runManagedChiefTurn({
      userId,
      sessionId: body.session_id ?? null,
      submission: body.submission,
      signal: controller.signal,
      store,
      client,
      toolExecutor,
      toolSpecs: toolSpecs ?? [],
      bindings: deps.bindings,
      threads: deps.threads,
      jobs: deps.jobs,
      sleepFn: deps.sleepFn,
      budgetMs: deps.budgetMs,
      onEvent: (event) => {
        response.write(encodeSseEvent(event));
      },
    });
  } catch (error) {
    turnError = error;
  }

  if (!turnError && result?.status === "completed") {
    try {
      await titleCompletedSession(store, userId, result);
    } catch (error) {
      console.error("[chief/chat] title", error?.name || "Error");
    }
  }
  if (turnError) {
    const configured = configurationFailure(turnError);
    response.write(
      encodeSseEvent(
        makeEvent(
          eventMsg.error({
            kind: "internal",
            message: configured ? turnError.message : "The turn could not be completed.",
            retryable: !configured,
          })
        )
      )
    );
    const logged = providerErrorFields(turnError);
    console.error("[chief/chat]", logged.operation, logged.status, logged.message);
  } else {
    const msg = { type: "session_configured", status: result.status };
    if (result.sessionId) msg.session_id = result.sessionId;
    response.write(encodeSseEvent(makeEvent(msg)));
  }
  response.end();
}

async function titleCompletedSession(store, userId, result) {
  const origin = result.checkpoint?.context?.origin;
  if (origin === "schedule" || origin === MANAGED_SCHEDULE_ORIGIN) return;
  if (typeof store.setTitleIfEmpty === "function") {
    const title = titleFromTranscript(result.checkpoint?.transcript);
    if (title) await store.setTitleIfEmpty(userId, result.sessionId, title);
  }
  if (typeof store.setRecallDocument === "function") {
    await store.setRecallDocument(userId, result.sessionId, result.checkpoint?.transcript);
  }
}

export default function handler(request, response) {
  return handleChiefChat(request, response, defaultDeps());
}
