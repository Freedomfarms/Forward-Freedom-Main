import express from "express";
import helmet from "helmet";
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

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// Security headers for every response.
app.use(helmet());

app.use(express.json({ limit: "256kb" }));

// Mirror the Vercel route modules in local Express so development and deployment
// exercise the same API entry points. Rate limiting is enforced inside each handler.
app.get("/api/health", healthHandler);
app.get("/api/me", meHandler);
app.route("/api/workspace").get(workspaceHandler).put(workspaceHandler);
app.get("/api/plaid/status", plaidStatusHandler);
app.delete("/api/plaid/item", plaidItemHandler);
app.post("/api/plaid/link-token/create", plaidLinkTokenHandler);
app.post("/api/plaid/exchange-public-token", plaidExchangePublicTokenHandler);
app.get("/api/plaid/sync", plaidSyncHandler);
app.delete("/api/plaid/user", plaidUserHandler);
app.post("/api/plaid/webhook", plaidWebhookHandler);

app.listen(PORT, () => {
  console.log(`Forward Freedom API server listening on http://localhost:${PORT}`);
});
