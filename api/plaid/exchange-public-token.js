import { handleExchangePlaidPublicToken } from "../../server/plaid/handlers.js";

export default function handler(request, response) {
  return handleExchangePlaidPublicToken(request, response);
}
