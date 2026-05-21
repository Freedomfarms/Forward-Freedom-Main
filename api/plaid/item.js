import { handleDeletePlaidItem } from "../../server/plaid/handlers.js";

export default function handler(request, response) {
  return handleDeletePlaidItem(request, response);
}
