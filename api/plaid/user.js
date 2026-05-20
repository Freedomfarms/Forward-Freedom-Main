import { handleDeletePlaidWorkspace } from "../../server/plaid/handlers.js";

export default function handler(request, response) {
  return handleDeletePlaidWorkspace(request, response);
}
