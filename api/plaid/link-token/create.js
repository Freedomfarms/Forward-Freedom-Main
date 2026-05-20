import { handleCreatePlaidLinkToken } from "../../../server/plaid/handlers.js";

export default function handler(request, response) {
  return handleCreatePlaidLinkToken(request, response);
}
