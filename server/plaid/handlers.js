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
  resolvePlaidOAuthRedirectUri,
} from "../plaidClient.js";
import { detectDuplicatePlaidItem } from "./duplicateItemDetection.js";
import { getPlaidRequestId, logPlaidServerEvent } from "./logging.js";
import { getPrismaClient, isDatabaseConfigured, Prisma } from "../db/prisma.js";
import {
  getSchemaCapabilities,
  isMissingEncryptionColumnError,
  resetSchemaCapabilitiesCache,
} from "../db/schemaCapabilities.js";
import {
  decryptSensitiveValue,
  encryptSensitiveValue,
  isSensitiveEncryptionConfigured,
} from "../security/encryption.js";
import {
  decrypt as decryptField,
  decryptJson,
  decryptNumber,
  encrypt as encryptField,
  encryptJson,
  encryptNumber,
} from "../security/envelope.js";
import { authenticateRequest, authenticateVerifiedRequest, AuthError } from "../auth/verifyAuth.js";

// Pre-encryption column sets. Prisma's generated client always SELECTs every
// schema field (including *Ciphertext), which fails with P2022 on a database
// that has not yet received the privacy migration. These selects keep reads
// working until migrate deploy runs.
const LEGACY_ACCOUNT_SELECT = {
  id: true,
  userId: true,
  workspaceUserId: true,
  plaidItemRecordId: true,
  plaidAccountId: true,
  name: true,
  type: true,
  institution: true,
  status: true,
  balance: true,
  syncSource: true,
  plaidType: true,
  plaidSubtype: true,
  lastSyncedAt: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
};

const LEGACY_TRANSACTION_ROW_SELECT = {
  id: true,
  userId: true,
  workspaceUserId: true,
  accountId: true,
  plaidItemRecordId: true,
  plaidTransactionId: true,
  source: true,
  syncSource: true,
  merchant: true,
  category: true,
  amount: true,
  postedAt: true,
  authorizedAt: true,
  pending: true,
  createdAt: true,
  updatedAt: true,
};

const LEGACY_TRANSACTION_SELECT = {
  ...LEGACY_TRANSACTION_ROW_SELECT,
  account: { select: { name: true } },
};

function buildErrorResponse(message, extra = {}) {
  return {
    error: true,
    message,
    ...extra,
  };
}

function getPlaidErrorDetails(error) {
  const data = error?.response?.data;
  const plaidError = data?.error && typeof data.error === "object" ? data.error : data;

  return {
    code:
      plaidError?.error_code ||
      data?.error_code ||
      error?.code ||
      "PLAID_REQUEST_FAILED",
    message:
      plaidError?.error_message ||
      plaidError?.display_message ||
      data?.error_message ||
      data?.message ||
      error?.message ||
      "Plaid request failed.",
  };
}

function isPlaidProductUnavailable(error) {
  const code = error?.response?.data?.error_code;
  // These mean "this product simply isn't available for this Item" (e.g. a
  // checking account with no loans), not that the connection is broken. They
  // must not flag the whole Item as REQUIRES_ATTENTION when other products
  // (transactions, balances) synced fine.
  return [
    "PRODUCT_NOT_READY",
    "PRODUCT_NOT_ENABLED",
    "NO_ACCOUNTS",
    "NO_LIABILITY_ACCOUNTS",
    "NO_AUTH_ACCOUNTS",
    "NO_INVESTMENT_ACCOUNTS",
  ].includes(code);
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
    accountRecord.metadataCiphertext != null
      ? decryptJson(accountRecord.metadataCiphertext) || {}
      : accountRecord?.metadata && typeof accountRecord.metadata === "object"
        ? accountRecord.metadata
        : {};
  const balance =
    accountRecord.balanceCiphertext != null
      ? decryptNumber(accountRecord.balanceCiphertext)
      : Number(accountRecord.balance || 0);

  return {
    id: accountRecord.plaidAccountId ? `plaid-${accountRecord.plaidAccountId}` : accountRecord.id,
    name: accountRecord.name,
    type: accountRecord.type,
    institution: accountRecord.institution || "Plaid",
    status: accountRecord.status || "Synced",
    balance: Number(balance || 0),
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
  const merchant =
    transactionRecord.merchantCiphertext != null
      ? decryptField(transactionRecord.merchantCiphertext)
      : transactionRecord.merchant;
  const category =
    transactionRecord.categoryCiphertext != null
      ? decryptField(transactionRecord.categoryCiphertext)
      : transactionRecord.category;
  const amount =
    transactionRecord.amountCiphertext != null
      ? decryptNumber(transactionRecord.amountCiphertext)
      : Number(transactionRecord.amount || 0);
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
    merchant: merchant || "Plaid Transaction",
    category: category || "Other",
    account: transactionRecord.account?.name || "Plaid Account",
    amount: Number(amount || 0),
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
  if (!rawBody) return {};

  try {
    return JSON.parse(rawBody);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
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
    // Explicit minimal select so this keeps working against a production
    // database that has not received newer User-column migrations yet
    // (callers only need the row to exist).
    select: { id: true },
  });
}

async function persistPlaidAccounts({
  prisma,
  userId,
  workspaceUserId,
  plaidItemRecordId,
  mappedAccounts,
  encryptionColumns = true,
}) {
  const accountLookup = new Map();

  for (const account of mappedAccounts) {
    const metadataPayload = {
      loanCategory: account.loanCategory || "",
      interestRate: account.interestRate || "",
      monthlyPayment: account.monthlyPayment || "",
      plaidItemId: account.plaidItemId || "",
    };
    const accountFields = encryptionColumns
      ? {
          workspaceUserId,
          plaidItemRecordId,
          name: account.name,
          type: account.type,
          institution: account.institution,
          status: account.status,
          // Balance is encrypted at rest; the plaintext column is left NULL.
          balance: null,
          balanceCiphertext: encryptNumber(Number(account.balance || 0)),
          syncSource: account.syncSource,
          plaidType: account.plaidType || null,
          plaidSubtype: account.plaidSubtype || null,
          lastSyncedAt: account.plaidLastSyncAt ? new Date(account.plaidLastSyncAt) : new Date(),
          // Loan/liability details are encrypted at rest; plaintext column NULL.
          metadata: Prisma.DbNull,
          metadataCiphertext: encryptJson(metadataPayload),
        }
      : {
          // Pre-migration fallback: write plaintext only so the app keeps
          // working until the encryption migration is applied.
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
          lastSyncedAt: account.plaidLastSyncAt ? new Date(account.plaidLastSyncAt) : new Date(),
          metadata: metadataPayload,
        };
    const existingAccount = await prisma.account.findUnique({
      where: { plaidAccountId: account.plaidAccountId },
      ...(encryptionColumns ? {} : { select: LEGACY_ACCOUNT_SELECT }),
    });

    let accountRecord;
    if (existingAccount) {
      if (existingAccount.userId !== userId) {
        logPlaidServerEvent("warn", "account_ownership_conflict", {
          userId,
          plaidAccountId: account.plaidAccountId,
          existingUserId: existingAccount.userId,
        });
        continue;
      }

      accountRecord = await prisma.account.update({
        where: { id: existingAccount.id, userId },
        data: accountFields,
        ...(encryptionColumns ? {} : { select: LEGACY_ACCOUNT_SELECT }),
      });
    } else {
      accountRecord = await prisma.account.create({
        data: {
          userId,
          plaidAccountId: account.plaidAccountId,
          ...accountFields,
        },
        ...(encryptionColumns ? {} : { select: LEGACY_ACCOUNT_SELECT }),
      });
    }

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
  encryptionColumns = true,
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

    const transactionFields = encryptionColumns
      ? {
          workspaceUserId,
          plaidItemRecordId,
          accountId: accountRecord?.id || null,
          syncSource: "Plaid",
          // Merchant, category and amount are encrypted at rest; plaintext NULL.
          merchant: null,
          merchantCiphertext: encryptField(mappedTransaction.merchant || ""),
          category: null,
          categoryCiphertext: encryptField(mappedTransaction.category || ""),
          amount: null,
          amountCiphertext: encryptNumber(Number(mappedTransaction.amount || 0)),
          postedAt: toPlaidDate(transaction.date),
          authorizedAt: toPlaidDate(transaction.authorized_date),
          pending: Boolean(transaction.pending),
        }
      : {
          workspaceUserId,
          plaidItemRecordId,
          accountId: accountRecord?.id || null,
          syncSource: "Plaid",
          merchant: mappedTransaction.merchant || "",
          category: mappedTransaction.category || null,
          amount: String(Number(mappedTransaction.amount || 0).toFixed(2)),
          postedAt: toPlaidDate(transaction.date),
          authorizedAt: toPlaidDate(transaction.authorized_date),
          pending: Boolean(transaction.pending),
        };
    const existingTransaction = await prisma.transaction.findUnique({
      where: { plaidTransactionId: transaction.transaction_id },
      ...(encryptionColumns ? {} : { select: LEGACY_TRANSACTION_ROW_SELECT }),
    });

    if (existingTransaction) {
      if (existingTransaction.userId !== userId) {
        logPlaidServerEvent("warn", "transaction_ownership_conflict", {
          userId,
          plaidTransactionId: transaction.transaction_id,
          existingUserId: existingTransaction.userId,
        });
        continue;
      }

      // The legacy select matters even though we don't read the result:
      // Prisma RETURNINGs every schema column by default, which P2022s on
      // *Ciphertext columns when the migration has not been applied yet.
      await prisma.transaction.update({
        where: { id: existingTransaction.id, userId },
        data: transactionFields,
        ...(encryptionColumns ? {} : { select: LEGACY_TRANSACTION_ROW_SELECT }),
      });
      continue;
    }

    await prisma.transaction.create({
      data: {
        userId,
        plaidTransactionId: transaction.transaction_id,
        source: "PLAID",
        ...transactionFields,
      },
      ...(encryptionColumns ? {} : { select: LEGACY_TRANSACTION_ROW_SELECT }),
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

async function buildWorkspaceSyncPayload(prisma, userId, workspaceUserId, { encryptionColumns = true } = {}) {
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
      ...(encryptionColumns ? {} : { select: LEGACY_ACCOUNT_SELECT }),
    }),
    prisma.transaction.findMany({
      where: {
        userId,
        workspaceUserId,
        source: "PLAID",
      },
      ...(encryptionColumns
        ? {
            include: {
              account: true,
            },
          }
        : { select: LEGACY_TRANSACTION_SELECT }),
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

async function syncPlaidWorkspace({ prisma, plaidClient, userId, workspaceUserId, restrictToItemId }) {
  const capabilities = await getSchemaCapabilities(prisma);
  const encryptionColumns = capabilities.encryptionColumns;

  // When a webhook fires for a single Item, only that Item should be pulled
  // from Plaid. Syncing every Item on each webhook multiplies Plaid API calls
  // and races concurrent webhooks against each other.
  const items = await prisma.plaidItem.findMany({
    where: {
      userId,
      workspaceUserId,
      ...(restrictToItemId ? { itemId: restrictToItemId } : {}),
    },
  });
  const lastSyncAt = new Date();

  for (const item of items) {
    let accessToken;

    try {
      accessToken = decryptSensitiveValue(item.accessTokenCiphertext);
    } catch (error) {
      const details = getPlaidErrorDetails(error);
      logPlaidServerEvent("warn", "access_token_decrypt_failed", {
        itemId: item.itemId,
        institutionId: item.institutionId,
        code: details.code,
        message: details.message,
      });
      await prisma.plaidItem.update({
        where: { id: item.id, userId },
        data: {
          status: "REQUIRES_ATTENTION",
          lastSyncError:
            "Stored bank credentials could not be read. Repair this connection to link it again.",
        },
      });
      continue;
    }

    let accountsResponse;

    try {
      accountsResponse = await plaidClient.accountsGet({
        access_token: accessToken,
      });
      logPlaidServerEvent("info", "accounts_get_success", {
        itemId: item.itemId,
        requestId: getPlaidRequestId(accountsResponse),
        institutionId: item.institutionId,
        accountCount: (accountsResponse.data.accounts || []).length,
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
        where: { id: item.id, userId },
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
          where: { id: item.id, userId },
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
          where: { id: item.id, userId },
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
      encryptionColumns,
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
      encryptionColumns,
    });

    await prisma.plaidItem.update({
      where: { id: item.id, userId },
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
      accountCount: mappedAccounts.length,
    });
  }

  return buildWorkspaceSyncPayload(prisma, userId, workspaceUserId, { encryptionColumns });
}

export async function syncPlaidWorkspaceForWebhookItem(itemId) {
  if (!itemId) {
    return { synced: false, reason: "missing_item_id" };
  }

  if (!isDatabaseConfigured()) {
    return { synced: false, reason: "database_not_configured" };
  }

  if (!isPlaidConfigured() || !isSensitiveEncryptionConfigured()) {
    return { synced: false, reason: "plaid_runtime_not_ready" };
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    return { synced: false, reason: "database_client_unavailable" };
  }

  const item = await prisma.plaidItem.findUnique({
    where: { itemId },
    select: {
      itemId: true,
      userId: true,
      workspaceUserId: true,
    },
  });

  if (!item) {
    return { synced: false, reason: "item_not_found" };
  }

  const plaidClient = getPlaidClient();
  await syncPlaidWorkspace({
    prisma,
    plaidClient,
    userId: item.userId,
    workspaceUserId: item.workspaceUserId,
    restrictToItemId: item.itemId,
  });

  return {
    synced: true,
    itemId: item.itemId,
    userId: item.userId,
    workspaceUserId: item.workspaceUserId,
  };
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
        userId,
      },
    });
  }
}

export async function handlePlaidStatus(request, response) {
  try {
    await authenticateRequest(request);
    const plaidConfig = getPlaidConfig();
    return response.status(200).json({
      ...plaidConfig,
      capabilities: {
        ...plaidConfig.capabilities,
        authenticatedRoutes: true,
        secureTokenStorage: isSensitiveEncryptionConfigured(),
        databasePersistence: isDatabaseConfigured(),
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return response.status(error.status).json(buildErrorResponse(error.message));
    }

    return response.status(500).json(buildErrorResponse("Unable to load Plaid status."));
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
        accessToken,
        enableAccountSelection: Boolean(plaidItemId),
        redirectUri: resolvePlaidOAuthRedirectUri(),
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
          accountCount: linkMetadata.accounts.length,
          reason: duplicateDetection.reason,
        });
        return response.status(409).json(
          buildErrorResponse(
            "This institution is already linked in your workspace. Use Repair connection on that institution to add or update accounts instead of linking it again.",
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

    const plaidItemFields = {
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
    };

    if (existingItem) {
      await prisma.plaidItem.update({
        where: { id: existingItem.id, userId: decodedToken.uid },
        data: plaidItemFields,
      });
    } else {
      await prisma.plaidItem.create({
        data: {
          userId: decodedToken.uid,
          itemId,
          ...plaidItemFields,
        },
      });
    }

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

function isTruthyFlag(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = String(raw ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "live";
}

export async function handleSyncPlaidWorkspace(request, response) {
  try {
    const decodedToken = await authenticateRequest(request);
    const workspaceUserId = normalizeWorkspaceUserId(request.query?.workspaceUserId);
    const wantsLiveRefresh = isTruthyFlag(request.query?.refresh);

    // Default (load/hydration): read already-synced, encrypted financial data
    // straight from the normalized tables. This is the single source of truth
    // and makes NO Plaid API calls, so it can run on every login without cost.
    if (!wantsLiveRefresh) {
      if (!isSensitiveEncryptionConfigured()) {
        return response
          .status(503)
          .json(
            buildErrorResponse(
              "Encryption is not configured, so stored financial data cannot be decrypted."
            )
          );
      }
      const prisma = getPrismaOrThrow();
      await ensureAuthenticatedUserRecord(prisma, decodedToken);
      const capabilities = await getSchemaCapabilities(prisma);
      let storedPayload;
      try {
        storedPayload = await buildWorkspaceSyncPayload(
          prisma,
          decodedToken.uid,
          workspaceUserId,
          { encryptionColumns: capabilities.encryptionColumns }
        );
      } catch (error) {
        if (isMissingEncryptionColumnError(error) && capabilities.encryptionColumns) {
          resetSchemaCapabilitiesCache();
          const refreshed = await getSchemaCapabilities(prisma);
          storedPayload = await buildWorkspaceSyncPayload(
            prisma,
            decodedToken.uid,
            workspaceUserId,
            { encryptionColumns: refreshed.encryptionColumns }
          );
        } else {
          throw error;
        }
      }
      return response.status(200).json(storedPayload);
    }

    // Explicit refresh (Accounts "Refresh" button / webhook): pull from Plaid.
    const { prisma, plaidClient } = assertPlaidRuntimeReady();
    await ensureAuthenticatedUserRecord(prisma, decodedToken);

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
      .json(buildErrorResponse(error?.message || "Unable to delete Plaid data for this workspace."));
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
        buildErrorResponse(
          error?.message || "Unable to remove this linked Plaid institution right now."
        )
      );
  }
}
