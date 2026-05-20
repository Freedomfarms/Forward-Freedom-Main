import express from "express";
import {
  handleCreatePlaidLinkToken,
  handleDeletePlaidWorkspace,
  handleExchangePlaidPublicToken,
  handlePlaidStatus,
  handleSyncPlaidWorkspace,
} from "./plaid/handlers.js";

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(express.json());

app.get("/api/plaid/status", handlePlaidStatus);
app.post("/api/plaid/link-token/create", handleCreatePlaidLinkToken);
app.post("/api/plaid/exchange-public-token", handleExchangePlaidPublicToken);
app.get("/api/plaid/sync", handleSyncPlaidWorkspace);
app.delete("/api/plaid/user", handleDeletePlaidWorkspace);

app.listen(PORT, () => {
  console.log(`Plaid server listening on http://localhost:${PORT}`);
});
