import express from "express";
import helmet from "helmet";
import { expressServerBackstopRateLimit } from "./http/rateLimit.js";
import healthHandler from "../api/health.js";
import meHandler from "../api/me.js";
import workspaceHandler from "../api/workspace.js";
import plaidStatusHandler from "../api/plaid/status.js";
import plaidItemHandler from "../api/plaid/item.js";
import plaidLinkTokenHandler from "../api/plaid/link-token/create.js";
import plaidExchangePublicTokenHandler from "../api/plaid/exchange-public-token.js";
import plaidSyncHandler from "../api/plaid/sync.js";
import plaidUserHandler from "../api/plaid/user.js";
import plaidWebhookHandler from "../api/plaid/webhook.js";
import agentsHandler from "../api/agents.js";
import agentByIdHandler from "../api/agents/[id].js";
import agentRunHandler from "../api/agents/[id]/run.js";
import agentRunsHandler from "../api/agents/[id]/runs.js";
import agentRunByIdHandler from "../api/agents/[id]/runs/[runId].js";
import agentChatHandler from "../api/agents/[id]/chat.js";
import agentConversationsHandler from "../api/agents/[id]/conversations.js";
import agentConversationByIdHandler from "../api/agents/[id]/conversations/[conversationId].js";
import agentConversationMessagesHandler from "../api/agents/[id]/conversations/[conversationId]/messages.js";
import ceoAgentHandler from "../api/agents/ceo.js";
import ceoProfileHandler from "../api/agents/ceo/profile.js";
import ceoNarrativeProfileHandler from "../api/agents/ceo/profile/narrative.js";
import ceoDigestHandler from "../api/agents/ceo/digest.js";
import ceoChatHandler from "../api/agents/ceo/chat.js";
import ceoConversationsHandler from "../api/agents/ceo/conversations.js";
import ceoConversationByIdHandler from "../api/agents/ceo/conversations/[conversationId].js";
import ceoConversationMessagesHandler from "../api/agents/ceo/conversations/[conversationId]/messages.js";
import ceoDocumentsHandler from "../api/agents/ceo/documents.js";
import onboardingHandler from "../api/agents/onboarding.js";
import notificationsHandler from "../api/notifications.js";
import notificationByIdHandler from "../api/notifications/[id].js";
import adminUsageHandler from "../api/admin/usage.js";
import cronAgentDispatchHandler from "../api/cron/agent-dispatch.js";

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// Security headers for every response.
app.use(helmet());

// App-wide per-IP rate-limit backstop (bug C-5). The Vercel deployment gets
// this for free because every api/*.js module enforces its own limiter, but a
// self-hosted Express deployment needs a server-level bound too so no mounted
// route — present or future — is ever reachable unthrottled. Handler-level
// limits (Plaid link/exchange etc.) remain the stricter, binding ones.
app.use("/api", expressServerBackstopRateLimit);

// Plaid signs the webhook against the exact bytes it transmitted. This route
// must be registered BEFORE the global JSON parser and use a raw body parser so
// express.json() never re-serializes the payload — a re-serialized body is not
// byte-identical to what Plaid sent and would make the SHA-256 signature check
// in webhookVerification.js fail for every webhook (bug C-1).
app.post(
  "/api/plaid/webhook",
  express.raw({ type: "*/*", limit: "256kb" }),
  plaidWebhookHandler
);

// Document/onboarding uploads can carry up to 10 files at 500,000 KB each
// (size still enforced in the documents module). Other API routes stay at 1mb.
const largeJsonParser = express.json({ limit: "5500mb" });
const defaultJsonParser = express.json({ limit: "1mb" });
app.use("/api/agents/ceo/documents", largeJsonParser);
app.use("/api/agents/onboarding", largeJsonParser);
app.use(defaultJsonParser);

// Mirror the Vercel route modules in local Express so development and deployment
// exercise the same API entry points. Each handler also enforces its own
// per-route rate limit on top of the app-wide backstop above.
app.get("/api/health", healthHandler);
app.route("/api/me").get(meHandler).post(meHandler).patch(meHandler);
app.route("/api/workspace").get(workspaceHandler).put(workspaceHandler);
app.get("/api/plaid/status", plaidStatusHandler);
app.delete("/api/plaid/item", plaidItemHandler);
app.post("/api/plaid/link-token/create", plaidLinkTokenHandler);
app.post("/api/plaid/exchange-public-token", plaidExchangePublicTokenHandler);
app.get("/api/plaid/sync", plaidSyncHandler);
app.delete("/api/plaid/user", plaidUserHandler);

// Freedom OS agent platform (Phase 5). Static /api/agents/ceo* routes are
// registered BEFORE the dynamic /api/agents/:id routes so "ceo" can never be
// captured as an :id (Vercel resolves the same precedence automatically).
app.route("/api/agents/ceo").get(ceoAgentHandler).put(ceoAgentHandler);
app.route("/api/agents/ceo/profile").get(ceoProfileHandler).patch(ceoProfileHandler);
app
  .route("/api/agents/ceo/profile/narrative")
  .get(ceoNarrativeProfileHandler)
  .post(ceoNarrativeProfileHandler);
app.route("/api/agents/ceo/digest").get(ceoDigestHandler).post(ceoDigestHandler);
app.route("/api/agents/ceo/chat").get(ceoChatHandler).post(ceoChatHandler);
app
  .route("/api/agents/ceo/conversations")
  .get(ceoConversationsHandler)
  .post(ceoConversationsHandler);
app
  .route("/api/agents/ceo/conversations/:conversationId")
  .patch(ceoConversationByIdHandler)
  .delete(ceoConversationByIdHandler);
app.get(
  "/api/agents/ceo/conversations/:conversationId/messages",
  ceoConversationMessagesHandler
);
app
  .route("/api/agents/ceo/documents")
  .get(ceoDocumentsHandler)
  .post(ceoDocumentsHandler)
  .delete(ceoDocumentsHandler);
app.post("/api/agents/onboarding", onboardingHandler);
app.route("/api/agents").get(agentsHandler).post(agentsHandler);
app.route("/api/agents/:id").patch(agentByIdHandler).delete(agentByIdHandler);
app.post("/api/agents/:id/run", agentRunHandler);
app.get("/api/agents/:id/runs", agentRunsHandler);
app
  .route("/api/agents/:id/runs/:runId")
  .get(agentRunByIdHandler)
  .post(agentRunByIdHandler);
app.route("/api/agents/:id/chat").get(agentChatHandler).post(agentChatHandler);
app
  .route("/api/agents/:id/conversations")
  .get(agentConversationsHandler)
  .post(agentConversationsHandler);
app
  .route("/api/agents/:id/conversations/:conversationId")
  .patch(agentConversationByIdHandler)
  .delete(agentConversationByIdHandler);
app.get(
  "/api/agents/:id/conversations/:conversationId/messages",
  agentConversationMessagesHandler
);
app.get("/api/notifications", notificationsHandler);
app.patch("/api/notifications/:id", notificationByIdHandler);
app.get("/api/admin/usage", adminUsageHandler);
// Cron dispatcher: GET with no JSON body; same CRON_SECRET check as Vercel.
app.get("/api/cron/agent-dispatch", cronAgentDispatchHandler);

app.listen(PORT, () => {
  console.log(`Freedom OS API server listening on http://localhost:${PORT}`);
});
