import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import healthHandler from "../api/health.js";
import meHandler from "../api/me.js";
import workspaceHandler from "../api/workspace.js";
import plaidStatusHandler from "../api/plaid/status.js";
import plaidItemHandler from "../api/plaid/item.js";
import plaidLinkTokenHandler from "../api/plaid/link-token/create.js";
import plaidExchangePublicTokenHandler from "../api/plaid/exchange-public-token.js";
import plaidSyncHandler from "../api/plaid/sync.js";
import plaidUserHandler from "../api/plaid/user.js";

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// Security headers for every response.
app.use(helmet());

app.use(express.json({ limit: "256kb" }));

// Rate limiters for Plaid endpoints.
// For Vercel (serverless), configure rate limiting at the edge or via Vercel's
// built-in DDoS protection — in-process limiters reset per cold start there.
const plaidLinkRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: true, message: "Too many link-token requests. Please try again later." },
});

const plaidExchangeRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: true, message: "Too many token exchange requests. Please try again later." },
});

const plaidSyncRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: true, message: "Too many sync requests. Please try again later." },
});

// Mirror the Vercel route modules in local Express so development and deployment
// exercise the same API entry points.
app.get("/api/health", healthHandler);
app.get("/api/me", meHandler);
app.route("/api/workspace").get(workspaceHandler).put(workspaceHandler);
app.get("/api/plaid/status", plaidStatusHandler);
app.delete("/api/plaid/item", plaidItemHandler);
app.post("/api/plaid/link-token/create", plaidLinkRateLimit, plaidLinkTokenHandler);
app.post("/api/plaid/exchange-public-token", plaidExchangeRateLimit, plaidExchangePublicTokenHandler);
app.get("/api/plaid/sync", plaidSyncRateLimit, plaidSyncHandler);
app.delete("/api/plaid/user", plaidUserHandler);

app.listen(PORT, () => {
  console.log(`Forward Freedom API server listening on http://localhost:${PORT}`);
});
