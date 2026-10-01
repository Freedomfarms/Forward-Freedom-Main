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
import chiefSessionsHandler from "../api/chief/sessions.js";
import chiefSessionSearchHandler from "../api/chief/session-search.js";
import chiefHistoryHandler from "../api/chief/history.js";
import chiefModelsHandler from "../api/chief/models.js";
import chiefChatHandler from "../api/chief/chat.js";
import chiefApprovalsHandler from "../api/chief/approvals.js";
import chiefModuleAccessHandler from "../api/chief/module-access.js";
import chiefRoomAccessHandler from "../api/chief/access.js";

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

app.use(express.json({ limit: "1mb" }));

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

// CHIEF conversation lifecycle. Vercel serves api/chief/*.js directly; local
// Express mirrors those handlers without changing them.
app
  .route("/api/chief/sessions")
  .get(chiefSessionsHandler)
  .patch(chiefSessionsHandler)
  .delete(chiefSessionsHandler);
app.get("/api/chief/session-search", chiefSessionSearchHandler);
app.get("/api/chief/history", chiefHistoryHandler);
app.get("/api/chief/models", chiefModelsHandler);
app.post("/api/chief/chat", chiefChatHandler);
app.route("/api/chief/approvals").get(chiefApprovalsHandler).post(chiefApprovalsHandler);
app.route("/api/chief/module-access").get(chiefModuleAccessHandler).post(chiefModuleAccessHandler);
app.get("/api/chief/access", chiefRoomAccessHandler);

app.listen(PORT, () => {
  console.log(`Freedom OS API server listening on http://localhost:${PORT}`);
});
