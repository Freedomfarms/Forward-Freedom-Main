import dotenv from "dotenv";
import { Configuration, PlaidApi, PlaidEnvironments, Products } from "plaid";

dotenv.config();

const PLAID_ENV = (process.env.PLAID_ENV || "development").trim().toLowerCase();
const DEFAULT_PRODUCTS = [Products.Transactions, Products.Liabilities];

let cachedClient = null;

function getBasePath() {
  const basePath = PlaidEnvironments[PLAID_ENV];
  if (!basePath) {
    throw new Error('PLAID_ENV must be one of "sandbox", "development", or "production".');
  }
  return basePath;
}

export function isPlaidConfigured() {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

export function getPlaidConfig() {
  return {
    configured: isPlaidConfigured(),
    environment: PLAID_ENV,
    products: DEFAULT_PRODUCTS.map(String),
    optionalProducts: [],
    capabilities: {
      accounts: true,
      transactions: true,
      investments: false,
      liabilities: true,
      realtimeBalances: false,
      webhooksConfigured: Boolean(process.env.PLAID_WEBHOOK_URL),
    },
    notes: [
      "Depository and credit transactions typically refresh one to four times per day.",
      "Liability statement and payment details generally refresh about once per day.",
      "Forward Freedom only requests account names, balances, transactions, statement dates, and payment details.",
      "Realtime balances require additional Plaid balance workflows and may incur extra cost.",
    ],
  };
}

export function getPlaidClient() {
  if (!isPlaidConfigured()) {
    throw new Error("Plaid environment variables are not configured.");
  }

  if (!cachedClient) {
    const configuration = new Configuration({
      basePath: getBasePath(),
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
          "PLAID-SECRET": process.env.PLAID_SECRET,
        },
      },
    });

    cachedClient = new PlaidApi(configuration);
  }

  return cachedClient;
}

export function getPlaidLinkTokenRequest({ userId, userName, accessToken }) {
  const request = {
    user: {
      client_user_id: userId,
      legal_name: userName || undefined,
    },
    client_name: "Forward Freedom",
    language: "en",
    country_codes: ["US"],
    products: DEFAULT_PRODUCTS,
    transactions: {
      days_requested: 365,
    },
    webhook: process.env.PLAID_WEBHOOK_URL || undefined,
  };

  if (accessToken) {
    request.access_token = accessToken;
  }

  return request;
}
