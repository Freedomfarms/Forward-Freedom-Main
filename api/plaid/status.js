import { handlePlaidStatus } from "../../server/plaid/handlers.js";

export default function handler(request, response) {
  return handlePlaidStatus(request, response);
}
