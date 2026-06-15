import dotenv from "dotenv";
import { Configuration, PlaidApi, PlaidEnvironments, Products } from "plaid";

dotenv.config();

const PLAID_ENV = (process.env.PLAID_ENV || "development").trim().toLowerCase();
const REQUIRED_PRODUCTS = [Products.Transactions];
const OPTIONAL_PRODUCTS = [Products.Liabilities];
const PLAID_CLIENT_NAME = "Forward Freedom";
const DEFAULT_PLAID_LEGAL_NAME = "Forward Freedom";
const DEFAULT_PLAID_CONTACT_EMAIL = "forwardfreedomfinancial@gmail.com";

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
    products: REQUIRED_PRODUCTS.map(String),
    optionalProducts: OPTIONAL_PRODUCTS.map(String),
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

function normalizeRedirectUri(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function getPlaidIdentity() {
  // Keep Plaid-facing identity fixed to the business brand so personal profile
  // names never leak into bank-sharing notices or Link verification flows.
  return {
    legalName: DEFAULT_PLAID_LEGAL_NAME,
    emailAddress: DEFAULT_PLAID_CONTACT_EMAIL,
  };
}

// Plaid only accepts a redirect_uri that is already registered under
// "Allowed redirect URIs" in the developer dashboard. Sending any other value
// fails link/token/create with INVALID_FIELD, which breaks every connection
// attempt (not just OAuth banks). We therefore only forward an explicitly
// configured URI and never derive one from the request origin.
export function resolvePlaidOAuthRedirectUri() {
  return normalizeRedirectUri(process.env.PLAID_OAUTH_REDIRECT_URI);
}

export function getPlaidLinkTokenRequest({
  userId,
  accessToken,
  enableAccountSelection = false,
  redirectUri,
}) {
  const plaidIdentity = getPlaidIdentity();
  const request = {
    user: {
      client_user_id: userId,
      legal_name: plaidIdentity.legalName,
      email_address: plaidIdentity.emailAddress,
    },
    client_name: PLAID_CLIENT_NAME,
    language: "en",
    country_codes: ["US"],
    products: REQUIRED_PRODUCTS,
    optional_products: OPTIONAL_PRODUCTS,
    transactions: {
      days_requested: 365,
    },
    webhook: process.env.PLAID_WEBHOOK_URL || undefined,
  };

  const resolvedRedirectUri = normalizeRedirectUri(redirectUri);
  if (resolvedRedirectUri) {
    request.redirect_uri = resolvedRedirectUri;
  }

  if (accessToken) {
    request.access_token = accessToken;
    if (enableAccountSelection) {
      request.update = {
        account_selection_enabled: true,
      };
    }
  }

  return request;
}
