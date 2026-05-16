import express from "express";
import {
  buildLiabilityLookup,
  mapPlaidAccountsToAppAccounts,
  mapPlaidTransactionsToAppTransactions,
} from "./mappers.js";
import {
  getPlaidClient,
  getPlaidConfig,
  getPlaidLinkTokenRequest,
  isPlaidConfigured,
} from "./plaidClient.js";
import { ensurePlaidUserStore, readPlaidStore, writePlaidStore } from "./store.js";

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(express.json());

function buildErrorResponse(message, extra = {}) {
  return {
    error: true,
    message,
    ...extra,
  };
}

function getPlaidErrorDetails(error) {
  const data = error?.response?.data;
  return {
    code: data?.error_code || error?.code || "PLAID_REQUEST_FAILED",
    message: data?.error_message || error?.message || "Plaid request failed.",
  };
}

function isPlaidProductUnavailable(error) {
  const code = error?.response?.data?.error_code;
  return ["PRODUCT_NOT_READY", "PRODUCT_NOT_ENABLED", "NO_ACCOUNTS"].includes(code);
}

async function resolveInstitutionName(plaidClient, institutionId) {
  if (!institutionId) return "Plaid Linked Institution";

  try {
    const response = await plaidClient.institutionsGetById({
      institution_id: institutionId,
      country_codes: ["US"],
    });
    return response.data?.institution?.name || "Plaid Linked Institution";
  } catch {
    return "Plaid Linked Institution";
  }
}

function applyTransactionDiff(currentTransactions, added, modified, removed) {
  const removedIds = new Set((removed || []).map((transaction) => transaction.transaction_id));
  const nextTransactions = currentTransactions.filter(
    (transaction) => !removedIds.has(transaction.transaction_id)
  );
  const transactionIndexById = new Map(
    nextTransactions.map((transaction, index) => [transaction.transaction_id, index])
  );

  modified.forEach((transaction) => {
    const index = transactionIndexById.get(transaction.transaction_id);
    if (index == null) {
      nextTransactions.push(transaction);
      transactionIndexById.set(transaction.transaction_id, nextTransactions.length - 1);
      return;
    }

    nextTransactions[index] = transaction;
  });

  added.forEach((transaction) => {
    const index = transactionIndexById.get(transaction.transaction_id);
    if (index == null) {
      nextTransactions.push(transaction);
      transactionIndexById.set(transaction.transaction_id, nextTransactions.length - 1);
    } else {
      nextTransactions[index] = transaction;
    }
  });

  return nextTransactions;
}

async function syncTransactionsForItem(plaidClient, itemRecord) {
  let cursor = itemRecord.transactionsCursor || null;
  let hasMore = true;
  let accumulatedAdded = [];
  let accumulatedModified = [];
  let accumulatedRemoved = [];

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token: itemRecord.accessToken,
      cursor,
      count: 250,
    });

    accumulatedAdded = accumulatedAdded.concat(response.data.added || []);
    accumulatedModified = accumulatedModified.concat(response.data.modified || []);
    accumulatedRemoved = accumulatedRemoved.concat(response.data.removed || []);
    cursor = response.data.next_cursor;
    hasMore = response.data.has_more;
  }

  return {
    ...itemRecord,
    transactionsCursor: cursor,
    transactions: applyTransactionDiff(
      itemRecord.transactions || [],
      accumulatedAdded,
      accumulatedModified,
      accumulatedRemoved
    ),
  };
}

async function syncPlaidUser(userId) {
  const plaidClient = getPlaidClient();
  const store = await readPlaidStore();
  const userRecord = ensurePlaidUserStore(store, userId);
  const itemEntries = Object.entries(userRecord.items || {});
  const mappedAccounts = [];
  const mappedTransactions = [];
  const plaidItems = [];
  const lastSyncAt = new Date().toISOString();

  for (const [itemId, itemRecord] of itemEntries) {
    let nextItemRecord = { ...itemRecord };
    let accountsResponse;

    try {
      accountsResponse = await plaidClient.accountsGet({
        access_token: itemRecord.accessToken,
      });
    } catch (error) {
      nextItemRecord.lastSyncError = getPlaidErrorDetails(error).message;
      userRecord.items[itemId] = nextItemRecord;
      continue;
    }

    try {
      nextItemRecord = await syncTransactionsForItem(plaidClient, nextItemRecord);
    } catch (error) {
      if (!isPlaidProductUnavailable(error)) {
        nextItemRecord.lastSyncError = getPlaidErrorDetails(error).message;
      }
    }

    let liabilitiesResponse = null;
    try {
      liabilitiesResponse = await plaidClient.liabilitiesGet({
        access_token: itemRecord.accessToken,
      });
    } catch (error) {
      if (!isPlaidProductUnavailable(error)) {
        nextItemRecord.lastSyncError = getPlaidErrorDetails(error).message;
      }
    }

    try {
      await plaidClient.investmentsHoldingsGet({
        access_token: itemRecord.accessToken,
      });
    } catch (error) {
      if (!isPlaidProductUnavailable(error)) {
        nextItemRecord.lastSyncError = getPlaidErrorDetails(error).message;
      }
    }

    const liabilityLookup = buildLiabilityLookup(liabilitiesResponse?.data?.liabilities);
    const appAccounts = mapPlaidAccountsToAppAccounts({
      accounts: accountsResponse.data.accounts || [],
      itemId,
      institutionName: itemRecord.institutionName,
      liabilityLookup,
    });
    const accountsById = Object.fromEntries(
      appAccounts.map((account) => [account.plaidAccountId, account])
    );
    const appTransactions = mapPlaidTransactionsToAppTransactions(
      nextItemRecord.transactions || [],
      accountsById
    );

    mappedAccounts.push(...appAccounts);
    mappedTransactions.push(...appTransactions);
    plaidItems.push({
      itemId,
      institutionName: itemRecord.institutionName,
      accountIds: appAccounts.map((account) => account.plaidAccountId),
      lastSyncAt,
      status: "connected",
    });

    userRecord.items[itemId] = {
      ...nextItemRecord,
      accountIds: appAccounts.map((account) => account.plaidAccountId),
      lastSyncAt,
      lastSyncError: "",
    };
  }

  store.users[userId] = userRecord;
  await writePlaidStore(store);

  return {
    plaidItems,
    accounts: mappedAccounts,
    transactions: mappedTransactions,
    lastSyncAt,
  };
}

app.get("/api/plaid/status", (_request, response) => {
  response.json(getPlaidConfig());
});

app.post("/api/plaid/link-token/create", async (request, response) => {
  if (!isPlaidConfigured()) {
    return response
      .status(503)
      .json(
        buildErrorResponse("Plaid is not configured yet. Add PLAID_CLIENT_ID and PLAID_SECRET.")
      );
  }

  const { userId, userName } = request.body || {};
  if (!userId) {
    return response
      .status(400)
      .json(buildErrorResponse("A userId is required to create a link token."));
  }

  try {
    const plaidClient = getPlaidClient();
    const linkTokenResponse = await plaidClient.linkTokenCreate(
      getPlaidLinkTokenRequest({ userId, userName })
    );
    return response.json({ linkToken: linkTokenResponse.data.link_token });
  } catch (error) {
    const details = getPlaidErrorDetails(error);
    return response.status(500).json(buildErrorResponse(details.message, { code: details.code }));
  }
});

app.post("/api/plaid/exchange-public-token", async (request, response) => {
  if (!isPlaidConfigured()) {
    return response
      .status(503)
      .json(
        buildErrorResponse("Plaid is not configured yet. Add PLAID_CLIENT_ID and PLAID_SECRET.")
      );
  }

  const { publicToken, userId } = request.body || {};
  if (!publicToken || !userId) {
    return response
      .status(400)
      .json(buildErrorResponse("publicToken and userId are required to connect a Plaid item."));
  }

  try {
    const plaidClient = getPlaidClient();
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });
    const accessToken = exchangeResponse.data.access_token;
    const itemId = exchangeResponse.data.item_id;
    const itemResponse = await plaidClient.itemGet({ access_token: accessToken });
    const institutionId = itemResponse.data.item.institution_id;
    const institutionName = await resolveInstitutionName(plaidClient, institutionId);

    const store = await readPlaidStore();
    const userRecord = ensurePlaidUserStore(store, userId);
    userRecord.items[itemId] = {
      accessToken,
      itemId,
      institutionId,
      institutionName,
      transactionsCursor: null,
      transactions: [],
      accountIds: [],
      lastSyncAt: null,
      lastSyncError: "",
    };
    store.users[userId] = userRecord;
    await writePlaidStore(store);

    const syncPayload = await syncPlaidUser(userId);
    return response.json(syncPayload);
  } catch (error) {
    const details = getPlaidErrorDetails(error);
    return response.status(500).json(buildErrorResponse(details.message, { code: details.code }));
  }
});

app.get("/api/plaid/sync", async (request, response) => {
  if (!isPlaidConfigured()) {
    return response
      .status(503)
      .json(
        buildErrorResponse("Plaid is not configured yet. Add PLAID_CLIENT_ID and PLAID_SECRET.")
      );
  }

  const userId = request.query.userId;
  if (!userId) {
    return response.status(400).json(buildErrorResponse("userId is required to sync Plaid data."));
  }

  try {
    const syncPayload = await syncPlaidUser(String(userId));
    return response.json(syncPayload);
  } catch (error) {
    const details = getPlaidErrorDetails(error);
    return response.status(500).json(buildErrorResponse(details.message, { code: details.code }));
  }
});

app.listen(PORT, () => {
  console.log(`Plaid server listening on http://localhost:${PORT}`);
});
