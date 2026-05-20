import {
  buildLiabilityLookup,
  mapPlaidAccountsToAppAccounts,
  mapPlaidTransactionsToAppTransactions,
} from "../mappers.js";
import {
  getPlaidClient,
  getPlaidConfig,
  getPlaidLinkTokenRequest,
  isPlaidConfigured,
} from "../plaidClient.js";
import { getPrismaClient, isDatabaseConfigured } from "../db/prisma.js";
import {
  decryptSensitiveValue,
  encryptSensitiveValue,
  isSensitiveEncryptionConfigured,
} from "../security/encryption.js";
import { authenticateRequest, AuthError } from "../auth/verifyAuth.js";

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

function normalizeWorkspaceUserId(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function buildPlaidClientUserId(authUserId, workspaceUserId) {
  return workspaceUserId ? `${authUserId}:${workspaceUserId}` : authUserId;
}

function toPlaidDate(value) {
  if (!value) return null;
  return new Date(`${value}T12:00:00Z`);
}

function formatAppDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function serializeStoredAccount(accountRecord) {
  const metadata =
    accountRecord?.metadata && typeof accountRecord.metadata === "object" ? accountRecord.metadata : {};

  return {
    id: accountRecord.plaidAccountId ? `plaid-${accountRecord.plaidAccountId}` : accountRecord.id,
    name: accountRecord.name,
    type: accountRecord.type,
    institution: accountRecord.institution || "Plaid",
    status: accountRecord.status || "Synced",
    balance: Number(accountRecord.balance || 0),
    syncSource: accountRecord.syncSource || "Plaid",
    plaidAccountId: accountRecord.plaidAccountId || "",
    plaidItemId: metadata.plaidItemId || "",
    plaidType: accountRecord.plaidType || "",
    plaidSubtype: accountRecord.plaidSubtype || "",
    plaidMask: accountRecord.plaidMask || "",
    plaidLastSyncAt: accountRecord.lastSyncedAt || null,
    loanCategory: metadata.loanCategory || "",
    interestRate: metadata.interestRate || "",
    monthlyPayment: metadata.monthlyPayment || "",
  };
}

function serializeStoredTransaction(transactionRecord) {
  return {
    id: transactionRecord.plaidTransactionId
      ? `plaid-${transactionRecord.plaidTransactionId}`
      : transactionRecord.id,
    plaidTransactionId: transactionRecord.plaidTransactionId,
    source: "plaid",
    syncSource: "Plaid",
    date: formatAppDate(transactionRecord.postedAt),
    merchant: transactionRecord.merchant || "Plaid Transaction",
    category: transactionRecord.category || "Other",
    account: transactionRecord.account?.name || "Plaid Account",
    amount: Number(transactionRecord.amount || 0),
    pending: Boolean(transactionRecord.pending),
  };
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

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object") {
    return request.body;
  }

  const chunks = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (!chunks.length) return {};

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

function getPrismaOrThrow() {
  if (!isDatabaseConfigured()) {
    const error = new Error("Database is not configured for Plaid persistence.");
    error.status = 503;
    throw error;
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    const error = new Error("Database client is not configured for Plaid persistence.");
    error.status = 503;
    throw error;
  }

  return prisma;
}

function assertPlaidRuntimeReady() {
  if (!isPlaidConfigured()) {
    const error = new Error("Plaid is not configured yet. Add PLAID_CLIENT_ID and PLAID_SECRET.");
    error.status = 503;
    throw error;
  }

  if (!isSensitiveEncryptionConfigured()) {
    const error = new Error(
      "PLAID_TOKEN_ENCRYPTION_KEY is required before Plaid access tokens can be stored securely."
    );
    error.status = 503;
    throw error;
  }

  return {
    prisma: getPrismaOrThrow(),
    plaidClient: getPlaidClient(),
  };
}

async function ensureAuthenticatedUserRecord(prisma, decodedToken) {
  return prisma.user.upsert({
    where: { id: decodedToken.uid },
    update: {
      email: decodedToken.email || null,
      displayName: decodedToken.name || null,
      photoURL: decodedToken.picture || null,
      lastLoginAt: new Date(),
    },
    create: {
      id: decodedToken.uid,
      email: decodedToken.email || null,
      displayName: decodedToken.name || null,
      photoURL: decodedToken.picture || null,
      lastLoginAt: new Date(),
    },
  });
}

async function persistPlaidAccounts({
  prisma,
  userId,
  workspaceUserId,
  plaidItemRecordId,
  mappedAccounts,
}) {
  const accountLookup = new Map();

  for (const account of mappedAccounts) {
    const accountRecord = await prisma.account.upsert({
      where: {
        plaidAccountId: account.plaidAccountId,
      },
      update: {
        userId,
        workspaceUserId,
        plaidItemRecordId,
        name: account.name,
        type: account.type,
        institution: account.institution,
        status: account.status,
        balance: String(Number(account.balance || 0).toFixed(2)),
        syncSource: account.syncSource,
        plaidType: account.plaidType || null,
        plaidSubtype: account.plaidSubtype || null,
        plaidMask: account.plaidMask || null,
        lastSyncedAt: account.plaidLastSyncAt ? new Date(account.plaidLastSyncAt) : new Date(),
        metadata: {
          loanCategory: account.loanCategory || "",
          interestRate: account.interestRate || "",
          monthlyPayment: account.monthlyPayment || "",
          plaidItemId: account.plaidItemId || "",
        },
      },
      create: {
        userId,
        workspaceUserId,
        plaidItemRecordId,
        plaidAccountId: account.plaidAccountId,
        name: account.name,
        type: account.type,
        institution: account.institution,
        status: account.status,
        balance: String(Number(account.balance || 0).toFixed(2)),
        syncSource: account.syncSource,
        plaidType: account.plaidType || null,
        plaidSubtype: account.plaidSubtype || null,
        plaidMask: account.plaidMask || null,
        lastSyncedAt: account.plaidLastSyncAt ? new Date(account.plaidLastSyncAt) : new Date(),
        metadata: {
          loanCategory: account.loanCategory || "",
          interestRate: account.interestRate || "",
          monthlyPayment: account.monthlyPayment || "",
          plaidItemId: account.plaidItemId || "",
        },
      },
    });

    accountLookup.set(account.plaidAccountId, accountRecord);
  }

  return accountLookup;
}

async function persistPlaidTransactions({
  prisma,
  userId,
  workspaceUserId,
  plaidItemRecordId,
  rawTransactions,
  removedTransactions,
  mappedAccounts,
  accountLookup,
}) {
  const mappedTransactionsById = new Map(
    mapPlaidTransactionsToAppTransactions(
      rawTransactions,
      Object.fromEntries(mappedAccounts.map((account) => [account.plaidAccountId, account]))
    ).map((transaction) => [transaction.plaidTransactionId, transaction])
  );

  for (const transaction of rawTransactions) {
    const accountRecord = accountLookup.get(transaction.account_id);
    const mappedTransaction = mappedTransactionsById.get(transaction.transaction_id);

    if (!mappedTransaction) continue;

    await prisma.transaction.upsert({
      where: {
        plaidTransactionId: transaction.transaction_id,
      },
      update: {
        userId,
        workspaceUserId,
        plaidItemRecordId,
        accountId: accountRecord?.id || null,
        syncSource: "Plaid",
        merchant: mappedTransaction.merchant,
        category: mappedTransaction.category,
        amount: String(Number(mappedTransaction.amount || 0).toFixed(2)),
        postedAt: toPlaidDate(transaction.date),
        authorizedAt: toPlaidDate(transaction.authorized_date),
        pending: Boolean(transaction.pending),
        raw: transaction,
      },
      create: {
        userId,
        workspaceUserId,
        plaidItemRecordId,
        accountId: accountRecord?.id || null,
        plaidTransactionId: transaction.transaction_id,
        source: "PLAID",
        syncSource: "Plaid",
        merchant: mappedTransaction.merchant,
        category: mappedTransaction.category,
        amount: String(Number(mappedTransaction.amount || 0).toFixed(2)),
        postedAt: toPlaidDate(transaction.date),
        authorizedAt: toPlaidDate(transaction.authorized_date),
        pending: Boolean(transaction.pending),
        raw: transaction,
      },
    });
  }

  const removedIds = (removedTransactions || [])
    .map((transaction) => transaction.transaction_id)
    .filter(Boolean);
  if (removedIds.length) {
    await prisma.transaction.deleteMany({
      where: {
        userId,
        plaidItemRecordId,
        plaidTransactionId: {
          in: removedIds,
        },
      },
    });
  }
}

async function syncTransactionsForItem(plaidClient, accessToken, cursor) {
  let nextCursor = cursor || null;
  let hasMore = true;
  let added = [];
  let modified = [];
  let removed = [];

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor: nextCursor,
      count: 250,
    });

    added = added.concat(response.data.added || []);
    modified = modified.concat(response.data.modified || []);
    removed = removed.concat(response.data.removed || []);
    nextCursor = response.data.next_cursor;
    hasMore = response.data.has_more;
  }

  return {
    cursor: nextCursor,
    added,
    modified,
    removed,
  };
}

async function buildWorkspaceSyncPayload(prisma, userId, workspaceUserId) {
  const [plaidItems, accounts, transactions] = await Promise.all([
    prisma.plaidItem.findMany({
      where: {
        userId,
        workspaceUserId,
      },
      orderBy: {
        createdAt: "asc",
      },
    }),
    prisma.account.findMany({
      where: {
        userId,
        workspaceUserId,
        syncSource: "Plaid",
      },
      orderBy: {
        createdAt: "asc",
      },
    }),
    prisma.transaction.findMany({
      where: {
        userId,
        workspaceUserId,
        source: "PLAID",
      },
      include: {
        account: true,
      },
      orderBy: {
        postedAt: "desc",
      },
    }),
  ]);

  const lastSyncAt = plaidItems
    .map((item) => item.lastSyncAt)
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null;

  return {
    plaidItems: plaidItems.map((item) => ({
      itemId: item.itemId,
      institutionName: item.institutionName || "Plaid Linked Institution",
      accountIds: accounts
        .filter((account) => account.plaidItemRecordId === item.id)
        .map((account) => account.plaidAccountId)
        .filter(Boolean),
      lastSyncAt: item.lastSyncAt,
      status: item.status === "CONNECTED" ? "connected" : "requires_attention",
    })),
    accounts: accounts.map(serializeStoredAccount),
    transactions: transactions.map(serializeStoredTransaction),
    lastSyncAt,
  };
}

async function syncPlaidWorkspace({ prisma, plaidClient, userId, workspaceUserId }) {
  const items = await prisma.plaidItem.findMany({
    where: {
      userId,
      workspaceUserId,
    },
  });
  const lastSyncAt = new Date();

  for (const item of items) {
    const accessToken = decryptSensitiveValue(item.accessTokenCiphertext);
    let accountsResponse;

    try {
      accountsResponse = await plaidClient.accountsGet({
        access_token: accessToken,
      });
    } catch (error) {
      const details = getPlaidErrorDetails(error);
      await prisma.plaidItem.update({
        where: { id: item.id },
        data: {
          status: "REQUIRES_ATTENTION",
          lastSyncError: details.message,
        },
      });
      continue;
    }

    let transactionsCursor = item.cursor;
    let addedTransactions = [];
    let modifiedTransactions = [];
    let removedTransactions = [];

    try {
      const transactionPayload = await syncTransactionsForItem(plaidClient, accessToken, item.cursor);
      transactionsCursor = transactionPayload.cursor;
      addedTransactions = transactionPayload.added;
      modifiedTransactions = transactionPayload.modified;
      removedTransactions = transactionPayload.removed;
    } catch (error) {
      if (!isPlaidProductUnavailable(error)) {
        const details = getPlaidErrorDetails(error);
        await prisma.plaidItem.update({
          where: { id: item.id },
          data: {
            status: "REQUIRES_ATTENTION",
            lastSyncError: details.message,
          },
        });
      }
    }

    let liabilitiesResponse = null;
    try {
      liabilitiesResponse = await plaidClient.liabilitiesGet({
        access_token: accessToken,
      });
    } catch (error) {
      if (!isPlaidProductUnavailable(error)) {
        const details = getPlaidErrorDetails(error);
        await prisma.plaidItem.update({
          where: { id: item.id },
          data: {
            status: "REQUIRES_ATTENTION",
            lastSyncError: details.message,
          },
        });
      }
    }

    try {
      await plaidClient.investmentsHoldingsGet({
        access_token: accessToken,
      });
    } catch (error) {
      if (!isPlaidProductUnavailable(error)) {
        const details = getPlaidErrorDetails(error);
        await prisma.plaidItem.update({
          where: { id: item.id },
          data: {
            status: "REQUIRES_ATTENTION",
            lastSyncError: details.message,
          },
        });
      }
    }

    const liabilityLookup = buildLiabilityLookup(liabilitiesResponse?.data?.liabilities);
    const mappedAccounts = mapPlaidAccountsToAppAccounts({
      accounts: accountsResponse.data.accounts || [],
      itemId: item.itemId,
      institutionName: item.institutionName,
      liabilityLookup,
    });
    const accountLookup = await persistPlaidAccounts({
      prisma,
      userId,
      workspaceUserId,
      plaidItemRecordId: item.id,
      mappedAccounts,
    });
    await persistPlaidTransactions({
      prisma,
      userId,
      workspaceUserId,
      plaidItemRecordId: item.id,
      rawTransactions: [...modifiedTransactions, ...addedTransactions],
      removedTransactions,
      mappedAccounts,
      accountLookup,
    });

    await prisma.plaidItem.update({
      where: { id: item.id },
      data: {
        cursor: transactionsCursor,
        status: "CONNECTED",
        lastSyncAt,
        lastSyncError: "",
      },
    });
  }

  return buildWorkspaceSyncPayload(prisma, userId, workspaceUserId);
}

export async function handlePlaidStatus(_request, response) {
  const plaidConfig = getPlaidConfig();

  response.status(200).json({
    ...plaidConfig,
    capabilities: {
      ...plaidConfig.capabilities,
      authenticatedRoutes: true,
      secureTokenStorage: isSensitiveEncryptionConfigured(),
      databasePersistence: isDatabaseConfigured(),
    },
  });
}

export async function handleCreatePlaidLinkToken(request, response) {
  try {
    const decodedToken = await authenticateRequest(request);
    const { prisma, plaidClient } = assertPlaidRuntimeReady();
    await ensureAuthenticatedUserRecord(prisma, decodedToken);

    const body = await readJsonBody(request);
    const workspaceUserId = normalizeWorkspaceUserId(body.workspaceUserId);
    const userName = body.userName || decodedToken.name || decodedToken.email || undefined;
    const linkTokenResponse = await plaidClient.linkTokenCreate(
      getPlaidLinkTokenRequest({
        userId: buildPlaidClientUserId(decodedToken.uid, workspaceUserId),
        userName,
      })
    );

    return response.status(200).json({ linkToken: linkTokenResponse.data.link_token });
  } catch (error) {
    if (error instanceof AuthError) {
      return response.status(error.status).json(buildErrorResponse(error.message));
    }

    const details = getPlaidErrorDetails(error);
    return response.status(error.status || 500).json(buildErrorResponse(details.message, { code: details.code }));
  }
}

export async function handleExchangePlaidPublicToken(request, response) {
  try {
    const decodedToken = await authenticateRequest(request);
    const { prisma, plaidClient } = assertPlaidRuntimeReady();
    await ensureAuthenticatedUserRecord(prisma, decodedToken);

    const body = await readJsonBody(request);
    const publicToken = body.publicToken;
    const workspaceUserId = normalizeWorkspaceUserId(body.workspaceUserId);

    if (!publicToken) {
      return response
        .status(400)
        .json(buildErrorResponse("publicToken is required to connect a Plaid item."));
    }

    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });
    const accessToken = exchangeResponse.data.access_token;
    const itemId = exchangeResponse.data.item_id;
    const itemResponse = await plaidClient.itemGet({ access_token: accessToken });
    const institutionId = itemResponse.data.item.institution_id;
    const institutionName = await resolveInstitutionName(plaidClient, institutionId);

    await prisma.plaidItem.upsert({
      where: {
        itemId,
      },
      update: {
        userId: decodedToken.uid,
        workspaceUserId,
        institutionId,
        institutionName,
        environment: getPlaidConfig().environment,
        accessTokenCiphertext: encryptSensitiveValue(accessToken),
        cursor: null,
        status: "CONNECTED",
        products: {
          products: itemResponse.data.item.available_products || [],
          billedProducts: itemResponse.data.item.billed_products || [],
        },
        lastSyncAt: null,
        lastSyncError: "",
      },
      create: {
        userId: decodedToken.uid,
        workspaceUserId,
        itemId,
        institutionId,
        institutionName,
        environment: getPlaidConfig().environment,
        accessTokenCiphertext: encryptSensitiveValue(accessToken),
        cursor: null,
        status: "CONNECTED",
        products: {
          products: itemResponse.data.item.available_products || [],
          billedProducts: itemResponse.data.item.billed_products || [],
        },
        lastSyncAt: null,
        lastSyncError: "",
      },
    });

    const syncPayload = await syncPlaidWorkspace({
      prisma,
      plaidClient,
      userId: decodedToken.uid,
      workspaceUserId,
    });

    return response.status(200).json(syncPayload);
  } catch (error) {
    if (error instanceof AuthError) {
      return response.status(error.status).json(buildErrorResponse(error.message));
    }

    const details = getPlaidErrorDetails(error);
    return response.status(error.status || 500).json(buildErrorResponse(details.message, { code: details.code }));
  }
}

export async function handleSyncPlaidWorkspace(request, response) {
  try {
    const decodedToken = await authenticateRequest(request);
    const { prisma, plaidClient } = assertPlaidRuntimeReady();
    await ensureAuthenticatedUserRecord(prisma, decodedToken);

    const workspaceUserId = normalizeWorkspaceUserId(request.query?.workspaceUserId);
    const syncPayload = await syncPlaidWorkspace({
      prisma,
      plaidClient,
      userId: decodedToken.uid,
      workspaceUserId,
    });

    return response.status(200).json(syncPayload);
  } catch (error) {
    if (error instanceof AuthError) {
      return response.status(error.status).json(buildErrorResponse(error.message));
    }

    const details = getPlaidErrorDetails(error);
    return response.status(error.status || 500).json(buildErrorResponse(details.message, { code: details.code }));
  }
}

export async function handleDeletePlaidWorkspace(request, response) {
  try {
    const decodedToken = await authenticateRequest(request);
    const prisma = getPrismaOrThrow();
    const workspaceUserId = normalizeWorkspaceUserId(request.query?.workspaceUserId);

    const plaidItems = await prisma.plaidItem.findMany({
      where: {
        userId: decodedToken.uid,
        workspaceUserId,
      },
    });

    const plaidClient =
      isPlaidConfigured() && isSensitiveEncryptionConfigured() ? getPlaidClient() : null;
    for (const item of plaidItems) {
      try {
        if (plaidClient) {
          await plaidClient.itemRemove({
            access_token: decryptSensitiveValue(item.accessTokenCiphertext),
          });
        }
      } catch {
        // Continue deleting local metadata even if Plaid item removal fails.
      }
    }

    const plaidItemIds = plaidItems.map((item) => item.id);
    if (plaidItemIds.length) {
      await prisma.transaction.deleteMany({
        where: {
          userId: decodedToken.uid,
          plaidItemRecordId: {
            in: plaidItemIds,
          },
        },
      });
      await prisma.account.deleteMany({
        where: {
          userId: decodedToken.uid,
          plaidItemRecordId: {
            in: plaidItemIds,
          },
        },
      });
      await prisma.plaidItem.deleteMany({
        where: {
          id: {
            in: plaidItemIds,
          },
        },
      });
    }

    return response.status(200).json({
      deleted: true,
      workspaceUserId,
      deletedItemCount: plaidItems.length,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return response.status(error.status).json(buildErrorResponse(error.message));
    }

    return response
      .status(error.status || 500)
      .json(buildErrorResponse(error?.message || "Unable to delete Plaid data for this workspace."));
  }
}
