import express from "express";
import healthHandler from "../api/health.js";
import meHandler from "../api/me.js";
import workspaceHandler from "../api/workspace.js";
import plaidStatusHandler from "../api/plaid/status.js";
import plaidLinkTokenHandler from "../api/plaid/link-token/create.js";
import plaidExchangePublicTokenHandler from "../api/plaid/exchange-public-token.js";
import plaidSyncHandler from "../api/plaid/sync.js";
import plaidUserHandler from "../api/plaid/user.js";

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(express.json());

// Mirror the Vercel route modules in local Express so development and deployment
// exercise the same API entry points.
app.get("/api/health", healthHandler);
app.get("/api/me", meHandler);
app.route("/api/workspace").get(workspaceHandler).put(workspaceHandler);
app.get("/api/plaid/status", plaidStatusHandler);
app.post("/api/plaid/link-token/create", plaidLinkTokenHandler);
app.post("/api/plaid/exchange-public-token", plaidExchangePublicTokenHandler);
app.get("/api/plaid/sync", plaidSyncHandler);
app.delete("/api/plaid/user", plaidUserHandler);

app.listen(PORT, () => {
  console.log(`Forward Freedom API server listening on http://localhost:${PORT}`);
});
