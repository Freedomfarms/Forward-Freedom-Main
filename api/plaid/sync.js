import { handleSyncPlaidWorkspace } from "../../server/plaid/handlers.js";

export default function handler(request, response) {
  return handleSyncPlaidWorkspace(request, response);
}
