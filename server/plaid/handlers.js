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
import { detectDuplicatePlaidItem } from "./duplicateItemDetection.js";
import { getPlaidRequestId, logPlaidServerEvent } from "./logging.js";
import { getPrismaClient, isDatabaseConfigured } from "../db/prisma.js";
import {
  decryptSensitiveValue,
  encryptSensitiveValue,
  isSensitiveEncryptionConfigured,
} from "../security/encryption.js";
import { authenticateRequest, authenticateVerifiedRequest, AuthError } from "../auth/verifyAuth.js";
import { respondInternalError } from "../http/errorHelpers.js";

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

function normalizePlaidItemId(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeLinkMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;

  const institution =
    metadata.institution && typeof metadata.institution === "object"
      ? {
          institution_id: normalizePlaidItemId(metadata.institution.institution_id),
          name: metadata.institution.name || null,
        }
      : null;
  const accounts = Array.isArray(metadata.accounts)
    ? metadata.accounts
        .map((account) => ({
          id: normalizePlaidItemId(account?.id),
          name: account?.name || null,
          subtype: account?.subtype || null,
          type: account?.type || null,
        }))
        .filter((account) => account.id || account.name)
    : [];

  return {
    institution,
    accounts,
    link_session_id: normalizePlaidItemId(metadata.link_session_id),
    request_id: normalizePlaidItemId(metadata.request_id),
  };
}

async function getExistingPlaidItemsForDetection(prisma, userId, workspaceUserId) {
  return prisma.plaidItem.findMany({
    where: {
      userId,
      workspaceUserId,
    },
    select: {
      itemId: true,
      institutionId: true,
      accounts: {
        select: {
          plaidAccountId: true,
          name: true,
          type: true,
          plaidType: true,
          plaidSubtype: true,
        },
      },
    },
  });
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
    plaidLastSyncAt: accountRecord.lastSyncedAt || null,
    loanCategory: metadata.loanCategory || "",
    interestRate: metadata.interestRate || "",
    monthlyPayment: metadata.monthlyPayment || "",
  };
}

function serializeStoredTransaction(transactionRecord) {
  const postedDate = formatAppDate(transactionRecord.postedAt);
  const authorizedDate = formatAppDate(transactionRecord.authorizedAt);
  return {
    id: transactionRecord.plaidTransactionId
      ? `plaid-${transactionRecord.plaidTransactionId}`
      : transactionRecord.id,
    plaidTransactionId: transactionRecord.plaidTransactionId,
    source: "plaid",
    syncSource: "Plaid",
    date: postedDate,
    plaidPostedDate: postedDate,
    plaidAuthorizedDate: authorizedDate,
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
    const error = new Error("Plaid is not configured yet.");
    error.status = 503;
    throw error;
  }

  if (!isSensitiveEncryptionConfigured()) {
    const error = new Error(
      "PLAID_TOKEN_ENCRYPTION_KEY must be a random secret at least 32 characters long before Plaid access tokens can be stored securely."
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
        plaidMask: null,
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
        plaidMask: null,
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
        raw: null,
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
        raw: null,
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

async function syncTransactionsForItem(plaidClient, accessToken, cursor, { itemId } = {}) {
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
    logPlaidServerEvent("info", "transactions_sync_response", {
      itemId,
      requestId: getPlaidRequestId(response),
      addedCount: response.data.added?.length || 0,
      modifiedCount: response.data.modified?.length || 0,
      removedCount: response.data.removed?.length || 0,
      hasMore: response.data.has_more,
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
      logPlaidServerEvent("info", "accounts_get_success", {
        itemId: item.itemId,
        requestId: getPlaidRequestId(accountsResponse),
        institutionId: item.institutionId,
        accountIds: (accountsResponse.data.accounts || []).map((account) => account.account_id),
      });
    } catch (error) {
      const details = getPlaidErrorDetails(error);
      logPlaidServerEvent("warn", "accounts_get_failed", {
        itemId: item.itemId,
        institutionId: item.institutionId,
        requestId: getPlaidRequestId(error),
        code: details.code,
        message: details.message,
      });
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
      const transactionPayload = await syncTransactionsForItem(plaidClient, accessToken, item.cursor, {
        itemId: item.itemId,
      });
      transactionsCursor = transactionPayload.cursor;
      addedTransactions = transactionPayload.added;
      modifiedTransactions = transactionPayload.modified;
      removedTransactions = transactionPayload.removed;
    } catch (error) {
      if (!isPlaidProductUnavailable(error)) {
        const details = getPlaidErrorDetails(error);
        logPlaidServerEvent("warn", "transactions_sync_failed", {
          itemId: item.itemId,
          institutionId: item.institutionId,
          requestId: getPlaidRequestId(error),
          code: details.code,
          message: details.message,
        });
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
      logPlaidServerEvent("info", "liabilities_get_success", {
        itemId: item.itemId,
        requestId: getPlaidRequestId(liabilitiesResponse),
        institutionId: item.institutionId,
      });
    } catch (error) {
      if (!isPlaidProductUnavailable(error)) {
        const details = getPlaidErrorDetails(error);
        logPlaidServerEvent("warn", "liabilities_get_failed", {
          itemId: item.itemId,
          institutionId: item.institutionId,
          requestId: getPlaidRequestId(error),
          code: details.code,
          message: details.message,
        });
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
    logPlaidServerEvent("info", "plaid_item_sync_complete", {
      itemId: item.itemId,
      institutionId: item.institutionId,
      accountIds: mappedAccounts.map((account) => account.plaidAccountId).filter(Boolean),
    });
  }

  return buildWorkspaceSyncPayload(prisma, userId, workspaceUserId);
}

async function deletePlaidItems({ prisma, userId, plaidItems }) {
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
        userId,
        plaidItemRecordId: {
          in: plaidItemIds,
        },
      },
    });
    await prisma.account.deleteMany({
      where: {
        userId,
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
}

export async function handlePlaidStatus(request, response) {
  try {
    await authenticateRequest(request);
    const plaidConfig = getPlaidConfig();
    return response.status(200).json({
      configured: isPlaidConfigured() && isSensitiveEncryptionConfigured(),
      environment: plaidConfig.environment,
      products: plaidConfig.products,
      optionalProducts: plaidConfig.optionalProducts,
      capabilities: plaidConfig.capabilities,
      notes: plaidConfig.notes,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return response.status(error.status).json(buildErrorResponse(error.message));
    }

    return respondInternalError(response, "plaid/status", error, "Unable to load Plaid status.");
  }
}

export async function handleCreatePlaidLinkToken(request, response) {
  try {
    const decodedToken = await authenticateVerifiedRequest(request);
    const { prisma, plaidClient } = assertPlaidRuntimeReady();
    await ensureAuthenticatedUserRecord(prisma, decodedToken);

    const body = await readJsonBody(request);
    const workspaceUserId = normalizeWorkspaceUserId(body.workspaceUserId);
    const plaidItemId = normalizePlaidItemId(body.plaidItemId);
    const userName = body.userName || decodedToken.name || decodedToken.email || undefined;
    let accessToken;

    if (plaidItemId) {
      const existingItem = await prisma.plaidItem.findUnique({
        where: {
          itemId: plaidItemId,
        },
      });

      if (
        !existingItem ||
        existingItem.userId !== decodedToken.uid ||
        existingItem.workspaceUserId !== workspaceUserId
      ) {
        return response
          .status(404)
          .json(buildErrorResponse("No linked Plaid institution was found for that itemId."));
      }

      accessToken = decryptSensitiveValue(existingItem.accessTokenCiphertext);
    }

    const linkTokenResponse = await plaidClient.linkTokenCreate(
      getPlaidLinkTokenRequest({
        userId: buildPlaidClientUserId(decodedToken.uid, workspaceUserId),
        userName,
        accessToken,
      })
    );
    logPlaidServerEvent("info", "link_token_created", {
      userId: decodedToken.uid,
      workspaceUserId,
      plaidItemId,
      mode: plaidItemId ? "update" : "connect",
      requestId: getPlaidRequestId(linkTokenResponse),
    });

    return response.status(200).json({ linkToken: linkTokenResponse.data.link_token });
  } catch (error) {
    if (error instanceof AuthError) {
      return response.status(error.status).json(buildErrorResponse(error.message));
    }

    const details = getPlaidErrorDetails(error);
    logPlaidServerEvent("warn", "link_token_create_failed", {
      requestId: getPlaidRequestId(error),
      code: details.code,
      message: details.message,
    });
    return response.status(error.status || 500).json(buildErrorResponse(details.message, { code: details.code }));
  }
}

export async function handleExchangePlaidPublicToken(request, response) {
  try {
    const decodedToken = await authenticateVerifiedRequest(request);
    const { prisma, plaidClient } = assertPlaidRuntimeReady();
    await ensureAuthenticatedUserRecord(prisma, decodedToken);

    const body = await readJsonBody(request);
    const publicToken = body.publicToken;
    const workspaceUserId = normalizeWorkspaceUserId(body.workspaceUserId);
    const plaidItemId = normalizePlaidItemId(body.plaidItemId);
    const linkMetadata = normalizeLinkMetadata(body.linkMetadata);

    if (!publicToken) {
      return response
        .status(400)
        .json(buildErrorResponse("publicToken is required to connect a Plaid item."));
    }

    if (!plaidItemId && linkMetadata?.institution?.institution_id && linkMetadata.accounts.length > 0) {
      const existingItems = await getExistingPlaidItemsForDetection(
        prisma,
        decodedToken.uid,
        workspaceUserId
      );
      const duplicateDetection = detectDuplicatePlaidItem({
        currentItemId: plaidItemId,
        existingItems,
        incomingAccounts: linkMetadata.accounts,
        institutionId: linkMetadata.institution.institution_id,
      });

      if (duplicateDetection.isDuplicate) {
        logPlaidServerEvent("warn", "duplicate_item_blocked", {
          userId: decodedToken.uid,
          workspaceUserId,
          institutionId: linkMetadata.institution.institution_id,
          institutionName: linkMetadata.institution.name,
          linkSessionId: linkMetadata.link_session_id,
          requestId: linkMetadata.request_id,
          accountIds: linkMetadata.accounts.map((account) => account.id).filter(Boolean),
          reason: duplicateDetection.reason,
        });
        return response.status(409).json(
          buildErrorResponse(
            "This institution appears to already be linked in your workspace. Repair the existing connection instead of linking it again.",
            { code: "DUPLICATE_PLAID_ITEM" }
          )
        );
      }
    }

    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });
    const accessToken = exchangeResponse.data.access_token;
    const itemId = exchangeResponse.data.item_id;
    logPlaidServerEvent("info", "public_token_exchanged", {
      userId: decodedToken.uid,
      workspaceUserId,
      itemId,
      plaidItemId,
      linkSessionId: linkMetadata?.link_session_id,
      requestId: getPlaidRequestId(exchangeResponse),
    });
    const itemResponse = await plaidClient.itemGet({ access_token: accessToken });
    const institutionId = itemResponse.data.item.institution_id;
    const institutionName = await resolveInstitutionName(plaidClient, institutionId);
    logPlaidServerEvent("info", "item_get_success", {
      userId: decodedToken.uid,
      workspaceUserId,
      itemId,
      institutionId,
      requestId: getPlaidRequestId(itemResponse),
    });

    // Ownership guard: if this itemId already exists, it must belong to the same user.
    // Without this check the update branch would silently re-assign the item to whoever
    // exchanges a public token referencing the same itemId.
    const existingItem = await prisma.plaidItem.findUnique({ where: { itemId } });
    if (existingItem && existingItem.userId !== decodedToken.uid) {
      return response
        .status(409)
        .json(buildErrorResponse("This institution is already linked to a different account."));
    }

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

    logPlaidServerEvent("info", "plaid_item_exchange_complete", {
      userId: decodedToken.uid,
      workspaceUserId,
      itemId,
      institutionId,
      linkSessionId: linkMetadata?.link_session_id,
    });

    return response.status(200).json(syncPayload);
  } catch (error) {
    if (error instanceof AuthError) {
      return response.status(error.status).json(buildErrorResponse(error.message));
    }

    const details = getPlaidErrorDetails(error);
    logPlaidServerEvent("warn", "exchange_public_token_failed", {
      requestId: getPlaidRequestId(error),
      code: details.code,
      message: details.message,
    });
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

    await deletePlaidItems({
      prisma,
      userId: decodedToken.uid,
      plaidItems,
    });

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
      .json(buildErrorResponse("Unable to delete Plaid data for this workspace."));
  }
}

export async function handleDeletePlaidItem(request, response) {
  try {
    const decodedToken = await authenticateRequest(request);
    const prisma = getPrismaOrThrow();
    const workspaceUserId = normalizeWorkspaceUserId(request.query?.workspaceUserId);
    const itemId = normalizePlaidItemId(request.query?.itemId);

    if (!itemId) {
      return response
        .status(400)
        .json(buildErrorResponse("itemId is required to remove a linked Plaid institution."));
    }

    const plaidItems = await prisma.plaidItem.findMany({
      where: {
        userId: decodedToken.uid,
        workspaceUserId,
        itemId,
      },
    });

    if (!plaidItems.length) {
      return response
        .status(404)
        .json(buildErrorResponse("No linked Plaid institution was found for that itemId."));
    }

    await deletePlaidItems({
      prisma,
      userId: decodedToken.uid,
      plaidItems,
    });

    return response.status(200).json({
      deleted: true,
      itemId,
      workspaceUserId,
      deletedItemCount: plaidItems.length,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return response.status(error.status).json(buildErrorResponse(error.message));
    }

    return response
      .status(error.status || 500)
      .json(
buildErrorResponse("Unable to remove this linked Plaid institution right now.")
      );
  }
}
