import { useCallback, useEffect, useRef, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import {
  APP_TABS,
  UNCATEGORIZED_CATEGORY,
  budgetMonths,
  navMain,
  navTools,
} from "./data/constants.jsx";
import {
  isHouseholdDemoSeedAccount,
  isHouseholdDemoSeedTransaction,
} from "./data/householdDemoSeed.js";
import { styles } from "./styles.js";
import { getBudgetPeriodAtOffset, getCurrentTimestamp } from "./utils/date.js";
import { money, parseMoney } from "./utils/format.js";
import { addMoney, roundMoney, subtractMoney, sumMoney } from "./utils/money.js";
import {
  createOnboardingState,
  evaluateOnboardingProgress,
} from "./utils/onboarding.js";
import {
  accountSupportsManualTransactions,
  calculateRealEstateEquity,
  isPlaidLinkedAccount,
  normalizeAccount,
} from "./utils/accounts.js";
import { createManualAccount, updateManualAccountInUser } from "./utils/manualAccounts.js";
import {
  createEmptyUserProfile,
  loadPersistedAppState,
  persistAppState,
} from "./utils/appState.js";
import { sanitizeWorkspaceStateForPersistence } from "./utils/workspacePersistence.js";
import {
  buildMerchantCategoryRules,
  categorizeTransactions,
} from "./utils/transactionCategorization.js";
import { buildMonthlySpendSnapshot } from "./utils/budgetReview.js";
import {
  buildPlanningYearOptions,
  buildPlanYearData,
  ensurePlanYearData,
  normalizePlansByYear,
} from "./utils/planning.js";
import {
  clearOAuthStateFromUrl,
  clearPendingPlaidLinkState,
  consumeOAuthReceivedRedirectUri,
  hasOAuthStateInUrl,
  loadPendingPlaidLinkState,
  savePendingPlaidLinkState,
} from "./utils/plaidOAuth.js";
import {
  createPlaidLinkToken,
  deletePlaidItem,
  deletePlaidUser,
  exchangePlaidPublicToken,
  getPlaidStatus,
  shouldFetchPlaidStatus,
  syncPlaidUser,
} from "./utils/plaid.js";
import { logPlaidClientEvent } from "./utils/plaidLogging.js";
import {
  applyPlaidNicknamesToAccounts,
  buildPlaidNicknameMap,
  normalizePlaidNicknameMap,
} from "./utils/plaidNicknames.js";
import {
  applyPlaidTransactionOverrides,
  buildPlaidTransactionOverrideMap,
  upsertPlaidCategoryOverride,
  upsertPlaidDateNicknameOverride,
} from "./utils/plaidTransactionOverrides.js";
import {
  acceptRecurringSuggestionKey,
  buildRecurringSuggestions,
  buildRecurringSubscriptionFromTransaction,
  dismissRecurringSuggestionKeys,
  normalizeRecurringPreferences,
  resolveSubscriptionSuggestionKey,
} from "./utils/recurringSuggestions.js";
import {
  calculateCryptoBalance,
  fetchCryptoQuotes,
  isCryptoPriceStale,
} from "./utils/cryptoPricing.js";
import {
  fetchPreciousMetalsSpotPrices,
  isPreciousMetalsPriceStale,
  normalizePreciousMetalsPricePerUnit,
} from "./utils/preciousMetalsPricing.js";
import { AccountsView } from "./components/AccountsView.jsx";
import { ViewErrorBoundary } from "./components/ErrorBoundary.jsx";
import { buildReserveReadiness, computeTrueCash, isReserveRow } from "./utils/reserves.js";
import { BudgetCommandCenter } from "./components/BudgetCommandCenter.jsx";
import { DashboardView } from "./components/DashboardView.jsx";
import { ForecastLab } from "./components/ForecastLab.jsx";
import { IncomeHub } from "./components/IncomeHub.jsx";
import { LandingPage } from "./components/LandingPage.jsx";
import { AppSidebar, ModulePlaceholder } from "./components/Layout.jsx";
import {
  SetupStepBanner,
  SetupWelcomeModal,
} from "./components/OnboardingExperience.jsx";
import { OperationsBoard } from "./components/OperationsBoard.jsx";
import { ObjectivesBoard } from "./components/ObjectivesBoard.jsx";
import { RecurringSubscriptions } from "./components/RecurringSubscriptions.jsx";
import { TransactionsView } from "./components/TransactionsView.jsx";
import { WorkspaceGuideAssistant } from "./components/WorkspaceGuideAssistant.jsx";
import {
  FreedomOsHome,
  FreedomOsSignedOutCard,
} from "./components/freedomOs/FreedomOsHome.jsx";
import { FreedomOsDeck } from "./components/freedomOs/FreedomOsDeck.jsx";
import { FreedomOsModuleHub } from "./components/freedomOs/FreedomOsModuleHub.jsx";
import { FREEDOM_OS_MODULE_IDS } from "./components/freedomOs/freedomOsModules.js";
import { AdminUsagePanel } from "./components/freedomOs/AdminUsagePanel.jsx";
import { useViewportUIScale } from "./utils/useViewportUIScale.js";
import { LegalModal } from "./components/LegalDocuments.jsx";

const roundCurrency = roundMoney;

function normalizeCryptoPrice(value) {
  return Number((Number(value) || 0).toFixed(8));
}

const LIQUID_ACCOUNT_TYPES = new Set(["Checking", "Savings", "Manual Cash"]);
const CRYPTO_PRICE_SOURCE = "CoinGecko";
const THIRTY_DAY_WINDOW = 30;
const SNAPSHOT_RETENTION_DAYS = 400;
// Admin Usage is deliberately outside navMain/navTools — it only appears in
// the sidebar for isAdmin users, but the tab itself must always be renderable.
const SUPPORTED_APP_TABS = new Set([
  ...[...navMain, ...navTools].map((item) => item.label),
  APP_TABS.ADMIN_USAGE,
]);

const METRIC_ICONS = {
  trueCash: (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 9.2h17M3.5 14.8h17" stroke="currentColor" strokeWidth="1.4" opacity="0.85" />
    </svg>
  ),
  liquidCash: (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
      <path
        d="M12 3.8L18.5 8v8L12 20.2 5.5 16V8L12 3.8Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M8.8 12h6.4M10.2 14.5h3.6M10.2 9.5h3.6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  creditCardDebt: (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
      <rect x="3.5" y="6.5" width="17" height="11" rx="2.4" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 10.2h17" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 14h3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M13.6 13.2l2.6 2.6M16.2 13.2l-2.6 2.6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  monthlyFlow: (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
      <path d="M4 15.2c2.1 0 2.1-6.4 4.2-6.4s2.1 6.4 4.2 6.4 2.1-6.4 4.2-6.4S18.7 15.2 21 15.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M4 19.2h17" stroke="currentColor" strokeWidth="1.6" opacity="0.85" />
    </svg>
  ),
  reserves: (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
      <path
        d="M12 3.5l6.5 2.4v5.2c0 4.1-2.8 7.1-6.5 8.4-3.7-1.3-6.5-4.3-6.5-8.4V5.9L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M9.2 12l1.9 1.9 3.7-3.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

const EMPTY_USER_STATE = Object.freeze({
  id: null,
  name: "",
  createdAt: null,
  selectedAccount: null,
  accounts: [],
  transactions: [],
  budgetRows: [],
  incomeStreams: [],
  objectives: [],
  subscriptions: [],
  recurringPreferences: normalizeRecurringPreferences(null),
  plaidItems: [],
  plaidNicknames: {},
  plaidTransactionOverrides: {},
  lastPlaidSyncAt: null,
  merchantCategoryRules: {},
  onboarding: createOnboardingState(),
  activeTab: APP_TABS.FREEDOM_OS,
  activeRange: "ALL",
  metricSnapshots: {},
});

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseSnapshotDateKey(dateKey) {
  const [year, month, day] = String(dateKey || "")
    .split("-")
    .map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function resolveUserAnchorStartingMonth(user, fallbackMonth) {
  const createdAt =
    typeof user?.createdAt === "string" ? new Date(user.createdAt) : null;
  if (createdAt && !Number.isNaN(createdAt.getTime())) {
    return getBudgetPeriodAtOffset(0, createdAt).month;
  }

  const earliestSnapshotDate = Object.keys(user?.metricSnapshots || {})
    .map((dateKey) => parseSnapshotDateKey(dateKey))
    .filter((date) => date && !Number.isNaN(date.getTime()))
    .sort((a, b) => a - b)[0];
  if (earliestSnapshotDate) {
    return getBudgetPeriodAtOffset(0, earliestSnapshotDate).month;
  }

  return fallbackMonth;
}

function trimMetricSnapshots(snapshots) {
  const sortedEntries = Object.entries(snapshots).sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(sortedEntries.slice(-SNAPSHOT_RETENTION_DAYS));
}

function buildTrackedMetricMeta(snapshots, metricKey, currentValue, increaseIsGood = true) {
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - THIRTY_DAY_WINDOW);
  const thresholdKey = getLocalDateKey(thresholdDate);
  const comparisonKey = Object.keys(snapshots)
    .sort()
    .reverse()
    .find(
      (key) =>
        key <= thresholdKey && snapshots[key] && typeof snapshots[key][metricKey] === "number"
    );

  if (!comparisonKey) {
    return {
      change: "Tracking 30-day baseline",
      changeColor: "#8fb1d9",
      changeIcon: "•",
      subLabel: "daily tracking in progress",
    };
  }

  const previousValue = Number(snapshots[comparisonKey][metricKey]) || 0;
  const delta = roundCurrency(currentValue - previousValue);
  const changeIcon = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";

  if (previousValue === 0) {
    return {
      change: `${delta >= 0 ? "+" : "-"}${money(Math.abs(delta))}`,
      changeColor: "#8fb1d9",
      changeIcon,
      subLabel: `since ${comparisonKey}`,
    };
  }

  const percentChange = Math.abs((delta / Math.abs(previousValue)) * 100);
  const isGood = delta === 0 ? true : increaseIsGood ? delta >= 0 : delta <= 0;

  return {
    change: `${delta >= 0 ? "+" : "-"}${money(Math.abs(delta))} (${percentChange.toFixed(2)}%)`,
    changeColor: isGood ? "#00f59b" : "#ff355d",
    changeIcon,
    subLabel: "vs last 30 days",
  };
}

function buildTrackedTrueCashMeta(snapshots, currentTrueCash, increaseIsGood = true) {
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - THIRTY_DAY_WINDOW);
  const thresholdKey = getLocalDateKey(thresholdDate);
  const comparisonKey = Object.keys(snapshots)
    .sort()
    .reverse()
    .find((key) => {
      const snap = snapshots[key];
      if (!(key <= thresholdKey && snap)) return false;
      if (typeof snap.trueCash === "number") return true;
      return typeof snap.liquidCash === "number" && typeof snap.creditCardDebt === "number";
    });

  if (!comparisonKey) {
    return {
      change: "Tracking 30-day baseline",
      changeColor: "#8fb1d9",
      changeIcon: "•",
      subLabel: "daily tracking in progress",
    };
  }

  const previousSnapshot = snapshots[comparisonKey];
  const previousValue =
    typeof previousSnapshot.trueCash === "number"
      ? roundCurrency(previousSnapshot.trueCash)
      : roundCurrency(Number(previousSnapshot.liquidCash) - Number(previousSnapshot.creditCardDebt));
  const delta = roundCurrency(currentTrueCash - previousValue);
  const changeIcon = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";

  if (previousValue === 0) {
    return {
      change: `${delta >= 0 ? "+" : "-"}${money(Math.abs(delta))}`,
      changeColor: "#8fb1d9",
      changeIcon,
      subLabel: `since ${comparisonKey}`,
    };
  }

  const percentChange = Math.abs((delta / Math.abs(previousValue)) * 100);
  const isGood = delta === 0 ? true : increaseIsGood ? delta >= 0 : delta <= 0;

  return {
    change: `${delta >= 0 ? "+" : "-"}${money(Math.abs(delta))} (${percentChange.toFixed(2)}%)`,
    changeColor: isGood ? "#00f59b" : "#ff355d",
    changeIcon,
    subLabel: "vs last 30 days",
  };
}

function syncDerivedAccountValues(accounts) {
  return accounts.map((account) => {
    if (account.type !== "Real Estate") return account;
    if (!account.linkedLoanId || !account.propertyMarketValue) return account;

    const linkedLoan = accounts.find((candidate) => candidate.id === account.linkedLoanId);
    if (!linkedLoan) return account;

    const nextEquity = calculateRealEstateEquity(account.propertyMarketValue, linkedLoan.balance);
    if (account.balance === nextEquity && account.equitySource === "Derived") {
      return account;
    }

    return {
      ...account,
      balance: nextEquity,
      equitySource: "Derived",
      lastValuedAt: account.lastValuedAt || null,
    };
  });
}

function buildTodayMetricSnapshot(liquidCash, creditCardDebt, totalNetWorth, trueCash) {
  return {
    liquidCash: roundCurrency(liquidCash),
    creditCardDebt: roundCurrency(creditCardDebt),
    totalNetWorth: roundCurrency(totalNetWorth),
    trueCash: roundCurrency(trueCash),
  };
}

function ensureTodayMetricSnapshot(metricSnapshots, nextSnapshot) {
  const todayKey = getLocalDateKey();
  const existing = metricSnapshots[todayKey];

  if (
    existing &&
    existing.liquidCash === nextSnapshot.liquidCash &&
    existing.creditCardDebt === nextSnapshot.creditCardDebt &&
    existing.totalNetWorth === nextSnapshot.totalNetWorth &&
    existing.trueCash === nextSnapshot.trueCash
  ) {
    return metricSnapshots;
  }

  return trimMetricSnapshots({
    ...metricSnapshots,
    [todayKey]: nextSnapshot,
  });
}

function getDisplayUserName(user, index = 0) {
  return user?.name?.trim() || `User ${index + 1}`;
}

function sortTransactionsByDate(transactions) {
  return [...transactions].sort((a, b) => new Date(b.date) - new Date(a.date));
}

function normalizeRecurringMatchToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function resolveAutoDetectedSubscriptionStatus(category, currentStatus = "Suggested") {
  const normalizedCategory = normalizeRecurringMatchToken(category);
  if (currentStatus === "Cancelled") return "Cancelled";
  if (normalizedCategory === "subscriptions") {
    return "Active";
  }
  if (currentStatus === "Active" || currentStatus === "Paused") {
    return currentStatus;
  }
  return "Suggested";
}

function syncAutoDetectedSubscriptions(currentSubscriptions, recurringSuggestions) {
  const subscriptionList = Array.isArray(currentSubscriptions) ? currentSubscriptions : [];
  const suggestionsByKey = new Map(
    recurringSuggestions.map((suggestion) => [suggestion.suggestionKey, suggestion])
  );
  const manualTrackedKeys = new Set(
    subscriptionList
      .filter((subscription) => !subscription.autoDetected)
      .map(
        (subscription) =>
          `${normalizeRecurringMatchToken(subscription.name)}|${normalizeRecurringMatchToken(
            subscription.account
          )}`
      )
  );

  const nextSubscriptions = [];
  let hasChanges = false;

  subscriptionList.forEach((subscription) => {
    if (!subscription.autoDetected || !subscription.suggestionKey) {
      nextSubscriptions.push(subscription);
      return;
    }

    const suggestion = suggestionsByKey.get(subscription.suggestionKey);
    if (!suggestion) {
      hasChanges = true;
      return;
    }

    const normalizedStatus = resolveAutoDetectedSubscriptionStatus(
      suggestion.category,
      subscription.status
    );
    const updatedSubscription = {
      ...subscription,
      name: suggestion.merchant || suggestion.category || subscription.name,
      amount: Number(suggestion.amount || subscription.amount || 0),
      category: suggestion.category || subscription.category,
      account: suggestion.account || subscription.account,
      billing: Number(suggestion.billing || subscription.billing || 1),
      frequency: suggestion.frequency || subscription.frequency || "Monthly",
      icon: suggestion.icon || subscription.icon || "💳",
      status: normalizedStatus,
    };
    if (JSON.stringify(updatedSubscription) !== JSON.stringify(subscription)) {
      hasChanges = true;
    }
    nextSubscriptions.push(updatedSubscription);
    suggestionsByKey.delete(subscription.suggestionKey);
  });

  suggestionsByKey.forEach((suggestion) => {
    const manualKey = `${normalizeRecurringMatchToken(suggestion.merchant)}|${normalizeRecurringMatchToken(
      suggestion.account
    )}`;
    if (manualTrackedKeys.has(manualKey)) return;
    hasChanges = true;
    nextSubscriptions.push({
      id: `sub-auto-${Date.now()}-${nextSubscriptions.length + 1}`,
      name: suggestion.merchant || suggestion.category || "Recurring Expense",
      amount: Number(suggestion.amount || 0),
      frequency: suggestion.frequency || "Monthly",
      category: suggestion.category || UNCATEGORIZED_CATEGORY,
      billing: Number(suggestion.billing || 1),
      account: suggestion.account || "",
      icon: suggestion.icon || "💳",
      status: resolveAutoDetectedSubscriptionStatus(suggestion.category),
      autoDetected: true,
      suggestionKey: suggestion.suggestionKey,
      createdAt: getCurrentTimestamp(),
    });
  });

  return hasChanges ? nextSubscriptions : subscriptionList;
}

function mergePlaidSyncIntoUser(user, syncPayload) {
  const hasLivePlaidItems = Array.isArray(user.plaidItems) && user.plaidItems.length > 0;
  const shouldReplaceDemoSyncedData = !hasLivePlaidItems;
  const existingPlaidNicknamesByKey = new Map(
    Object.entries(normalizePlaidNicknameMap(user.plaidNicknames || {}))
  );
  user.accounts
    .filter((account) => account.syncSource === "Plaid" || account.plaidAccountId)
    .forEach((account) => {
      if (typeof account.nickname === "string" && account.nickname.trim().length > 0) {
        existingPlaidNicknamesByKey.set(account.plaidAccountId || account.id, account.nickname.trim());
      }
    });
  const syncedAccounts = applyPlaidNicknamesToAccounts(
    (syncPayload.accounts || []).map((account, index) => normalizeAccount(account, index)),
    Object.fromEntries(existingPlaidNicknamesByKey)
  );
  const existingPlaidTransactions = new Map(
    user.transactions
      .filter((transaction) => transaction.source === "plaid")
      .map((transaction) => [transaction.id, transaction])
  );
  const syncedTransactions = applyPlaidTransactionOverrides(
    (syncPayload.transactions || []).map((transaction) => {
      const existing = existingPlaidTransactions.get(transaction.id);
      if (!existing) return transaction;

      let mergedTransaction = transaction;
      if (existing.categorySource === "user" || existing.categorySource === "manual") {
        mergedTransaction = {
          ...mergedTransaction,
          category: existing.category,
          categorySource: existing.categorySource,
          categoryConfidence: existing.categoryConfidence,
          needsReview: existing.needsReview,
        };
      }

      const nicknameDate =
        typeof existing.dateNickname === "string" && existing.dateNickname.trim()
          ? existing.dateNickname.trim()
          : "";
      if (!nicknameDate) {
        return mergedTransaction;
      }

      return {
        ...mergedTransaction,
        plaidPostedDate: transaction.plaidPostedDate || existing.plaidPostedDate || transaction.date,
        date: nicknameDate,
        dateNickname: nicknameDate,
        dateNicknameUpdatedAt: existing.dateNicknameUpdatedAt || null,
      };
    }),
    user.plaidTransactionOverrides || {}
  );
  // On the FIRST Plaid link only, clear untouched demo-seed placeholder
  // accounts (identified by their stable seed ids, never by status alone) and
  // the seeded transactions that posted to them. Accounts the user actively
  // used — by posting their own transactions to them — are kept, so a first
  // Plaid connect can never silently delete user-entered data. Editing a demo
  // account already converts its status to "Manual", which also keeps it.
  const accountNamesWithUserEntries = new Set(
    user.transactions
      .filter(
        (transaction) =>
          transaction.source === "manual" && !isHouseholdDemoSeedTransaction(transaction)
      )
      .map((transaction) => transaction.account)
  );
  const removedDemoAccountNames = new Set();
  const retainedAccounts = user.accounts
    .filter((account) => {
      if (account.syncSource === "Plaid" || account.plaidAccountId) return false;
      if (
        shouldReplaceDemoSyncedData &&
        account.status === "Synced" &&
        isHouseholdDemoSeedAccount(account) &&
        !accountNamesWithUserEntries.has(account.name)
      ) {
        removedDemoAccountNames.add(account.name);
        return false;
      }
      return true;
    })
    .map((account) =>
      // A surviving demo-styled "Synced" account becomes a plain manual
      // account once real bank data exists, so it stops presenting as linked.
      shouldReplaceDemoSyncedData && account.status === "Synced"
        ? { ...account, status: "Manual" }
        : account
    );
  const retainedTransactions = user.transactions.filter((transaction) => {
    if (transaction.source === "plaid") return false;
    if (
      shouldReplaceDemoSyncedData &&
      isHouseholdDemoSeedTransaction(transaction) &&
      removedDemoAccountNames.has(transaction.account)
    ) {
      return false;
    }
    return true;
  });

  return {
    ...user,
    accounts: [...retainedAccounts, ...syncedAccounts],
    transactions: sortTransactionsByDate([...syncedTransactions, ...retainedTransactions]),
    plaidItems: syncPayload.plaidItems || user.plaidItems,
    plaidNicknames: buildPlaidNicknameMap(syncedAccounts),
    lastPlaidSyncAt: syncPayload.lastSyncAt || user.lastPlaidSyncAt,
  };
}

export function isStalePlaidSyncError(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("request blocked") ||
    normalized.includes("request failed") ||
    normalized.includes("unable to sync plaid") ||
    normalized.includes("sign-in session is still restoring")
  );
}

function removeManualAccountFromUser(user, targetAccount) {
  const targetAccountName = targetAccount.name;
  const nextAccounts = user.accounts
    .filter((account) => account.id !== targetAccount.id)
    .map((account) => {
      const updates = {};
      if (account.linkedLoanId === targetAccount.id) {
        updates.linkedLoanId = "";
      }
      if (account.linkedPropertyId === targetAccount.id) {
        updates.linkedPropertyId = "";
      }

      return Object.keys(updates).length ? { ...account, ...updates } : account;
    });

  return {
    ...user,
    accounts: nextAccounts,
    transactions: user.transactions.filter((transaction) => transaction.account !== targetAccountName),
    subscriptions: user.subscriptions.filter(
      (subscription) =>
        subscription.account !== targetAccountName && subscription.accountId !== targetAccount.id
    ),
    selectedAccount: user.selectedAccount === targetAccountName ? null : user.selectedAccount,
  };
}

function removePlaidItemFromUser(user, plaidItemId) {
  const linkedAccounts = user.accounts.filter((account) => account.plaidItemId === plaidItemId);
  const linkedAccountNames = new Set(linkedAccounts.map((account) => account.name));
  const linkedAccountIds = new Set(linkedAccounts.map((account) => account.id));

  return {
    ...user,
    accounts: user.accounts.filter((account) => account.plaidItemId !== plaidItemId),
    transactions: user.transactions.filter(
      (transaction) => !(transaction.source === "plaid" && linkedAccountNames.has(transaction.account))
    ),
    subscriptions: user.subscriptions.filter(
      (subscription) =>
        !linkedAccountNames.has(subscription.account) && !linkedAccountIds.has(subscription.accountId)
    ),
    plaidItems: (user.plaidItems || []).filter((item) => item.itemId !== plaidItemId),
    selectedAccount: linkedAccountNames.has(user.selectedAccount) ? null : user.selectedAccount,
  };
}

function ForwardFreedomDashboard({
  initialView = "landing",
  storageKey,
  initialAppStateOverride,
  onPersistedStateChange,
  sessionControls,
  // Local persistence is opt-in: writing financial state to localStorage must
  // be an explicit caller decision, never a default for public/unauthenticated
  // render paths.
  persistLocally = false,
  isDemoMode = false,
  onEnterDemo,
  onExitDemo,
  // Returns to the Freedom OS public landing (the platform homepage) from the
  // internally rendered FFF landing view.
  onBackToOs,
  // /api/me profile of the signed-in user (null for demo/unauthenticated).
  // Freedom OS uses it for the isAdmin gate on the Admin Usage tab.
  workspaceProfile = null,
} = {}) {
  const [initialAppState] = useState(() => {
    const base = initialAppStateOverride || loadPersistedAppState(storageKey);
    // Authenticated sign-on always opens the Freedom OS module hub first.
    // Demo / public paths keep whatever tab their seed state uses.
    if (initialAppStateOverride && !isDemoMode) {
      return {
        ...base,
        users: (base.users || []).map((user) => ({
          ...user,
          activeTab: APP_TABS.FREEDOM_OS,
        })),
      };
    }
    return base;
  });
  const [currentView, setCurrentView] = useState(initialView);
  const [users, setUsers] = useState(initialAppState.users);
  const [activeUserId, setActiveUserId] = useState(initialAppState.activeUserId);
  // null = module hub; ceo_agents = Module 01. Module 02 switches activeTab.
  const [freedomOsModule, setFreedomOsModule] = useState(null);
  const [editingUserId, setEditingUserId] = useState(null);
  const [draftUserName, setDraftUserName] = useState("");
  const [pendingManualEditAccountId, setPendingManualEditAccountId] = useState(null);
  const [plaidStatus, setPlaidStatus] = useState({
    configured: false,
    environment: "development",
    notes: [],
  });
  const [plaidLinkToken, setPlaidLinkToken] = useState(null);
  const [plaidShouldOpen, setPlaidShouldOpen] = useState(false);
  const [plaidTargetUserId, setPlaidTargetUserId] = useState(null);
  const [plaidTargetItemId, setPlaidTargetItemId] = useState(null);
  const [plaidConsentPrompt, setPlaidConsentPrompt] = useState(null);
  const [hasAcceptedPlaidConsent, setHasAcceptedPlaidConsent] = useState(false);
  const [plaidConsentError, setPlaidConsentError] = useState("");
  const [emailVerificationPromptOpen, setEmailVerificationPromptOpen] = useState(false);
  const [activeLegalDocument, setActiveLegalDocument] = useState(null);
  const [plaidError, setPlaidError] = useState("");
  const [isPlaidSyncing, setIsPlaidSyncing] = useState(false);
  const [plaidOAuthRedirectUri, setPlaidOAuthRedirectUri] = useState(() =>
    consumeOAuthReceivedRedirectUri()
  );
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  // Live-price refresh failures (CoinGecko / precious metals). Stale prices in
  // a fintech context must never fail silently, so these feed a visible banner.
  const [priceFeedNotices, setPriceFeedNotices] = useState({ crypto: "", metals: "" });
  const setPriceFeedNotice = (feed, message) => {
    setPriceFeedNotices((current) =>
      current[feed] === message ? current : { ...current, [feed]: message }
    );
  };
  const plaidRecoverySyncUserIdsRef = useRef(new Set());
  const plaidOAuthResumeAttemptedRef = useRef(false);
  const activeUser = users.find((user) => user.id === activeUserId) || users[0] || EMPTY_USER_STATE;
  const accounts = activeUser.accounts;
  const transactions = activeUser.transactions;
  const selectedAccount = activeUser.selectedAccount;
  const budgetRows = activeUser.budgetRows;
  const incomeStreams = activeUser.incomeStreams;
  const rawSubscriptions = activeUser.subscriptions;
  const recurringPreferences = normalizeRecurringPreferences(activeUser.recurringPreferences);
  const objectives = Array.isArray(activeUser.objectives) ? activeUser.objectives : [];
  const plaidItems = activeUser.plaidItems;
  const lastPlaidSyncAt = activeUser.lastPlaidSyncAt;
  const merchantCategoryRules = activeUser.merchantCategoryRules || {};
  const plaidTransactionOverrides = activeUser.plaidTransactionOverrides || {};
  const activeTab = SUPPORTED_APP_TABS.has(activeUser.activeTab)
    ? activeUser.activeTab
    : APP_TABS.FREEDOM_OS;
  const onboardingProgress = evaluateOnboardingProgress(activeUser, activeTab);
  // Freedom OS requires an authenticated Firebase user for its API calls; in
  // demo/public sessions the tab renders a static sign-in card instead.
  const freedomOsAuthUser = !isDemoMode && sessionControls?.user ? sessionControls.user : null;
  const isPlatformAdmin = Boolean(freedomOsAuthUser) && workspaceProfile?.isAdmin === true;
  const activeRange = activeUser.activeRange;
  const metricSnapshots = activeUser.metricSnapshots;
  const currentBudgetPeriod = getBudgetPeriodAtOffset(0);
  const currentPlanYear = currentBudgetPeriod.year;
  const setActiveUserField = (field, valueOrUpdater) => {
    if (!activeUser?.id) return;

    setUsers((currentUsers) =>
      currentUsers.map((user) => {
        if (user.id !== activeUser.id) return user;

        const nextValue =
          typeof valueOrUpdater === "function" ? valueOrUpdater(user[field]) : valueOrUpdater;
        return user[field] === nextValue ? user : { ...user, [field]: nextValue };
      })
    );
  };
  const setAccounts = (valueOrUpdater) => setActiveUserField("accounts", valueOrUpdater);
  const setTransactions = (valueOrUpdater) => setActiveUserField("transactions", valueOrUpdater);
  const setSelectedAccount = (valueOrUpdater) =>
    setActiveUserField("selectedAccount", valueOrUpdater);
  const setBudgetRows = (valueOrUpdater) => setActiveUserField("budgetRows", valueOrUpdater);
  const setIncomeStreams = (valueOrUpdater) => setActiveUserField("incomeStreams", valueOrUpdater);
  const setSubscriptionsBase = (valueOrUpdater) =>
    setActiveUserField("subscriptions", valueOrUpdater);
  const setRecurringPreferences = (valueOrUpdater) =>
    setActiveUserField("recurringPreferences", (currentValue) =>
      normalizeRecurringPreferences(
        typeof valueOrUpdater === "function"
          ? valueOrUpdater(normalizeRecurringPreferences(currentValue))
          : valueOrUpdater
      )
    );
  const setObjectives = (valueOrUpdater) => setActiveUserField("objectives", valueOrUpdater);
  const setMerchantCategoryRules = (valueOrUpdater) =>
    setActiveUserField("merchantCategoryRules", valueOrUpdater);
  const setPlaidTransactionOverrides = (valueOrUpdater) =>
    setActiveUserField("plaidTransactionOverrides", valueOrUpdater);
  const setOnboarding = (valueOrUpdater) => setActiveUserField("onboarding", valueOrUpdater);
  const setActiveTab = (valueOrUpdater) => {
    const current = activeUser.activeTab;
    const next =
      typeof valueOrUpdater === "function" ? valueOrUpdater(current) : valueOrUpdater;
    // Returning to Freedom OS always shows the module hub, not a nested module.
    if (next === APP_TABS.FREEDOM_OS) {
      setFreedomOsModule(null);
    }
    setActiveUserField("activeTab", next);
  };

  const handleSelectFreedomOsModule = (moduleId) => {
    if (moduleId === FREEDOM_OS_MODULE_IDS.CEO_AGENTS) {
      setFreedomOsModule(FREEDOM_OS_MODULE_IDS.CEO_AGENTS);
      return;
    }
    if (moduleId === FREEDOM_OS_MODULE_IDS.FREEDOM_FINANCIAL) {
      setFreedomOsModule(null);
      setActiveTab(APP_TABS.DASHBOARD);
    }
  };
  const setActiveRange = (valueOrUpdater) => setActiveUserField("activeRange", valueOrUpdater);
  const openGuide = () => setIsGuideOpen(true);
  const closeGuide = () => setIsGuideOpen(false);
  const openOnboardingStep = (step) => {
    if (!step?.tab) return;
    setOnboarding((currentValue) => ({
      ...createOnboardingState(),
      ...currentValue,
      welcomeDismissedAt: currentValue?.welcomeDismissedAt || new Date().toISOString(),
      skippedAt: null,
      completedAt: null,
    }));
    setActiveTab(step.tab);
    setIsMobileNavOpen(false);
  };
  const startOnboarding = () => {
    if (onboardingProgress.currentStep) {
      openOnboardingStep(onboardingProgress.currentStep);
    }
  };
  const skipOnboarding = () => {
    const timestamp = new Date().toISOString();
    setOnboarding((currentValue) => ({
      ...createOnboardingState(),
      ...currentValue,
      welcomeDismissedAt: currentValue?.welcomeDismissedAt || timestamp,
      skippedAt: timestamp,
      completedAt: currentValue?.completedAt || null,
    }));
  };
  const syncedAccounts = syncDerivedAccountValues(accounts);

  const categorizedTransactions = categorizeTransactions(transactions, {
    budgetRows,
    merchantCategoryRules,
  });
  const recurringSuggestions = buildRecurringSuggestions(
    categorizedTransactions,
    rawSubscriptions,
    recurringPreferences
  );
  const subscriptions = syncAutoDetectedSubscriptions(rawSubscriptions, recurringSuggestions);

  // Write the synced list back into user state whenever auto-detection changed
  // it. The UI renders the derived list, but persistence reads
  // user.subscriptions, so without this write-back every reload would silently
  // drop the auto-detected entries the user can see (bug C-4). Storing the
  // exact derived array also keeps the generated subscription ids stable
  // across renders. syncAutoDetectedSubscriptions returns the input array
  // untouched when nothing changed, so this converges instead of looping.
  useEffect(() => {
    if (!activeUser?.id) return;
    if (subscriptions === rawSubscriptions) return;
    setSubscriptionsBase((currentSubscriptions) =>
      // Skip the write if another update landed since this render; the next
      // render re-derives from the fresh state and re-syncs if still needed.
      currentSubscriptions === rawSubscriptions ? subscriptions : currentSubscriptions
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUser?.id, rawSubscriptions, subscriptions]);

  const setSubscriptions = (valueOrUpdater) =>
    setSubscriptionsBase((currentSubscriptions) => {
      const syncedSubscriptions = syncAutoDetectedSubscriptions(
        currentSubscriptions,
        recurringSuggestions
      );
      return typeof valueOrUpdater === "function"
        ? valueOrUpdater(syncedSubscriptions)
        : valueOrUpdater;
    });

  useEffect(() => {
    if (!activeUser?.id) return;

    const timestamp = new Date().toISOString();
    const completedAtByStepId = onboardingProgress.steps
      .filter((step) => step.derivedComplete && !step.completedAt)
      .reduce((accumulator, step) => {
        accumulator[step.id] = timestamp;
        return accumulator;
      }, {});
    const shouldMarkComplete =
      onboardingProgress.isComplete && !onboardingProgress.onboarding.completedAt;

    if (Object.keys(completedAtByStepId).length === 0 && !shouldMarkComplete) return;

    setOnboarding((currentValue) => {
      const seed = createOnboardingState();
      const base = {
        ...seed,
        ...currentValue,
        steps: {
          ...seed.steps,
          ...(currentValue?.steps || {}),
        },
      };
      let didChange = false;
      const nextSteps = { ...base.steps };

      for (const [stepId, completedAt] of Object.entries(completedAtByStepId)) {
        if (!nextSteps[stepId]?.completedAt) {
          nextSteps[stepId] = {
            completedAt,
          };
          didChange = true;
        }
      }

      const nextCompletedAt = shouldMarkComplete && !base.completedAt ? timestamp : base.completedAt;
      if (nextCompletedAt !== base.completedAt) {
        didChange = true;
      }

      const shouldDismissWelcome =
        Boolean(base.welcomeDismissedAt) || Object.keys(completedAtByStepId).length > 0;
      const nextWelcomeDismissedAt = shouldDismissWelcome
        ? base.welcomeDismissedAt || timestamp
        : base.welcomeDismissedAt;
      if (nextWelcomeDismissedAt !== base.welcomeDismissedAt) {
        didChange = true;
      }

      if (!didChange) return currentValue;

      return {
        ...base,
        welcomeDismissedAt: nextWelcomeDismissedAt,
        completedAt: nextCompletedAt,
        steps: nextSteps,
      };
    });
  }, [activeUser?.id, onboardingProgress]);

  const removeSubscription = (subscription) => {
    if (!subscription?.id || !activeUser?.id) return;

    const suggestionKey = resolveSubscriptionSuggestionKey(subscription);
    setUsers((currentUsers) =>
      currentUsers.map((user) => {
        if (user.id !== activeUser.id) return user;

        const preferences = normalizeRecurringPreferences(user.recurringPreferences);
        const nextPreferences = suggestionKey
          ? dismissRecurringSuggestionKeys(preferences, suggestionKey)
          : preferences;
        const userCategorizedTransactions = categorizeTransactions(user.transactions, {
          budgetRows: user.budgetRows,
          merchantCategoryRules: user.merchantCategoryRules || {},
        });
        const suggestions = buildRecurringSuggestions(
          userCategorizedTransactions,
          user.subscriptions,
          nextPreferences
        );
        const syncedSubscriptions = syncAutoDetectedSubscriptions(
          user.subscriptions,
          suggestions
        );
        const nextSubscriptions = syncedSubscriptions.filter((sub) => sub.id !== subscription.id);
        const preferencesChanged =
          JSON.stringify(nextPreferences) !== JSON.stringify(preferences);
        const subscriptionsChanged =
          JSON.stringify(nextSubscriptions) !== JSON.stringify(user.subscriptions);

        if (!preferencesChanged && !subscriptionsChanged) return user;

        return {
          ...user,
          recurringPreferences: nextPreferences,
          subscriptions: nextSubscriptions,
        };
      })
    );
  };

  const liquidCash = sumMoney(
    syncedAccounts.filter((account) => LIQUID_ACCOUNT_TYPES.has(account.type)),
    (account) => account.balance
  );

  // Credit card balances are stored as negative when money is owed. Net the
  // balances and floor at zero instead of Math.abs-ing the sum: a positive
  // balance (e.g. an overpayment credit or a data glitch) must reduce reported
  // debt, never be silently counted as more debt.
  const creditCardNetBalance = sumMoney(
    syncedAccounts.filter((account) => account.type === "Credit Card"),
    (account) => account.balance
  );
  const creditCardDebt = Math.max(0, -creditCardNetBalance);

  // Reserve (committed) cash: the sum of every reserve category's balance.
  // This money physically sits in checking but is no longer spendable True Cash.
  const reserveReadiness = buildReserveReadiness(
    budgetRows.filter(isReserveRow),
    categorizedTransactions,
    { asOfMonth: currentBudgetPeriod.month, asOfYear: currentBudgetPeriod.year }
  );
  const reservesBalance = reserveReadiness.totalBalance;

  // Gross True Cash keeps the pre-reserves meaning (liquid minus credit cards) and
  // is what net worth / allocations use, because reserve cash is still real cash.
  const grossTrueCash = subtractMoney(liquidCash, creditCardDebt);
  // Spendable True Cash removes committed reserve dollars. Allowed to go negative:
  // a negative value honestly signals the user has committed more than they hold.
  const trueCash = computeTrueCash({ liquidCash, creditCardDebt, reservesBalance });
  const isReservesOvercommitted = reservesBalance > liquidCash;

  const sumAccountTypeBalance = (accountType) =>
    sumMoney(
      syncedAccounts.filter((account) => account.type === accountType),
      (account) => account.balance
    );

  const investmentTotal = sumAccountTypeBalance("Investment");
  const cryptoTotal = sumAccountTypeBalance("Crypto");
  const preciousMetalsTotal = sumAccountTypeBalance("Precious Metals");
  const realEstateTotal = sumAccountTypeBalance("Real Estate");
  const retirementTotal = sumAccountTypeBalance("Retirement");

  const currentMonth = currentBudgetPeriod.month;
  const anchorStartingMonth = resolveUserAnchorStartingMonth(activeUser, currentMonth);
  const currentMonthSpendSnapshot = buildMonthlySpendSnapshot(categorizedTransactions, budgetRows, {
    month: currentBudgetPeriod.month,
    year: currentBudgetPeriod.year,
  });
  const currentMonthIncome = sumMoney(
    incomeStreams.filter((s) => (s.months || budgetMonths).includes(currentMonth)),
    (s) => parseMoney(s.amount)
  );
  const currentMonthBudget = sumMoney(
    budgetRows.filter((r) => (r.months || budgetMonths).includes(currentMonth)),
    (r) => r.budget
  );
  const monthlyFlow = subtractMoney(currentMonthIncome, currentMonthBudget);
  const currentYearPlanState = activeUser.plansByYear?.[String(currentPlanYear)];
  const baseCurrentPlanData = buildPlanYearData({
    budgetRows: activeUser.budgetRows,
    incomeStreams: activeUser.incomeStreams,
    startingMonth: anchorStartingMonth,
    startingTrueCash:
      currentYearPlanState?.startingTrueCash && currentYearPlanState.startingTrueCash !== 0
        ? currentYearPlanState.startingTrueCash
        : trueCash,
  });
  const plansByYear = ensurePlanYearData(
    normalizePlansByYear(activeUser.plansByYear, baseCurrentPlanData),
    currentPlanYear,
    baseCurrentPlanData
  );
  const availablePlanningYears = buildPlanningYearOptions(plansByYear, currentPlanYear);
  const activePlaidNicknames = buildPlaidNicknameMap(syncedAccounts);
  const activePlaidTransactionOverrides = buildPlaidTransactionOverrideMap(
    categorizedTransactions,
    plaidTransactionOverrides
  );

  const totalNetWorth = Math.max(
    addMoney(
      grossTrueCash,
      investmentTotal,
      cryptoTotal,
      preciousMetalsTotal,
      realEstateTotal,
      retirementTotal
    ),
    1
  );
  const pct = (v) => `${((v / totalNetWorth) * 100).toFixed(1)}%`;
  const trackedMetricSnapshots = ensureTodayMetricSnapshot(
    metricSnapshots,
    buildTodayMetricSnapshot(liquidCash, creditCardDebt, totalNetWorth, trueCash)
  );
  const ensurePlanningYear = (targetYear) => {
    setActiveUserField("plansByYear", (currentPlansByYear) =>
      ensurePlanYearData(currentPlansByYear, targetYear, baseCurrentPlanData)
    );
  };
  const getBudgetRowsForYear = (targetYear) =>
    targetYear === currentPlanYear
      ? budgetRows
      : ensurePlanYearData(plansByYear, targetYear, baseCurrentPlanData)[String(targetYear)]
          ?.budgetRows || [];
  const getIncomeStreamsForYear = (targetYear) =>
    targetYear === currentPlanYear
      ? incomeStreams
      : ensurePlanYearData(plansByYear, targetYear, baseCurrentPlanData)[String(targetYear)]
          ?.incomeStreams || [];
  const getPlanningAnchorForYear = (targetYear) =>
    ensurePlanYearData(plansByYear, targetYear, baseCurrentPlanData)[String(targetYear)] || {};
  const setBudgetRowsForYear = (targetYear, valueOrUpdater) => {
    if (targetYear === currentPlanYear) {
      setBudgetRows(valueOrUpdater);
      return;
    }

    setActiveUserField("plansByYear", (currentPlansByYear) => {
      const nextPlansByYear = ensurePlanYearData(
        currentPlansByYear,
        targetYear,
        baseCurrentPlanData
      );
      const yearKey = String(targetYear);
      const currentValue = nextPlansByYear[yearKey]?.budgetRows || [];
      const nextValue =
        typeof valueOrUpdater === "function" ? valueOrUpdater(currentValue) : valueOrUpdater;

      return {
        ...nextPlansByYear,
        [yearKey]: {
          ...nextPlansByYear[yearKey],
          budgetRows: nextValue,
        },
      };
    });
  };
  const setIncomeStreamsForYear = (targetYear, valueOrUpdater) => {
    if (targetYear === currentPlanYear) {
      setIncomeStreams(valueOrUpdater);
      return;
    }

    setActiveUserField("plansByYear", (currentPlansByYear) => {
      const nextPlansByYear = ensurePlanYearData(
        currentPlansByYear,
        targetYear,
        baseCurrentPlanData
      );
      const yearKey = String(targetYear);
      const currentValue = nextPlansByYear[yearKey]?.incomeStreams || [];
      const nextValue =
        typeof valueOrUpdater === "function" ? valueOrUpdater(currentValue) : valueOrUpdater;

      return {
        ...nextPlansByYear,
        [yearKey]: {
          ...nextPlansByYear[yearKey],
          incomeStreams: nextValue,
        },
      };
    });
  };
  const setPlanningAnchorForYear = (targetYear, nextAnchor) => {
    setActiveUserField("plansByYear", (currentPlansByYear) => {
      const nextPlansByYear = ensurePlanYearData(
        currentPlansByYear,
        targetYear,
        baseCurrentPlanData
      );
      const yearKey = String(targetYear);
      const currentPlan = nextPlansByYear[yearKey] || buildPlanYearData(baseCurrentPlanData);
      const stableStartingMonth = currentPlan.startingMonth || baseCurrentPlanData.startingMonth;

      return {
        ...nextPlansByYear,
        [yearKey]: {
          ...currentPlan,
          ...nextAnchor,
          startingMonth: stableStartingMonth,
        },
      };
    });
  };
  const persistedUsers = users.map((user, index) =>
    user.id === activeUser?.id
      ? {
          ...user,
          name: getDisplayUserName(user, index),
          accounts: syncedAccounts,
          transactions: categorizedTransactions,
          merchantCategoryRules,
          plaidNicknames: activePlaidNicknames,
          plaidTransactionOverrides: activePlaidTransactionOverrides,
          plansByYear: {
            ...plansByYear,
            [String(currentPlanYear)]: buildPlanYearData({
              budgetRows,
              incomeStreams,
              startingMonth: baseCurrentPlanData.startingMonth,
              startingTrueCash: baseCurrentPlanData.startingTrueCash,
            }),
          },
          metricSnapshots: trackedMetricSnapshots,
        }
      : {
          ...user,
          name: getDisplayUserName(user, index),
          // Inactive profiles are persisted as a raw spread, but their derived
          // Plaid preference maps must still reflect any nicknames/overrides
          // captured on their own accounts/transactions. Merge (never replace)
          // so a profile whose Plaid data isn't loaded this session keeps its
          // saved maps, while a profile that was edited then switched away
          // still persists the fresh values instead of a stale snapshot.
          plaidNicknames: {
            ...(user.plaidNicknames || {}),
            ...buildPlaidNicknameMap(user.accounts),
          },
          plaidTransactionOverrides: buildPlaidTransactionOverrideMap(
            user.transactions,
            user.plaidTransactionOverrides
          ),
        }
  );

  const dynamicAllocations = [
    {
      name: "True Cash",
      amount: money(grossTrueCash),
      percent: pct(grossTrueCash),
      color: "#8b34ff",
      valueNumber: grossTrueCash,
    },
    {
      name: "Investments",
      amount: money(investmentTotal),
      percent: pct(investmentTotal),
      color: "#168bff",
      valueNumber: investmentTotal,
    },
    {
      name: "Crypto",
      amount: money(cryptoTotal),
      percent: pct(cryptoTotal),
      color: "#00d8ff",
      valueNumber: cryptoTotal,
    },
    {
      name: "Precious Metals",
      amount: money(preciousMetalsTotal),
      percent: pct(preciousMetalsTotal),
      color: "#f6c453",
      valueNumber: preciousMetalsTotal,
    },
    {
      name: "Real Estate",
      amount: money(realEstateTotal),
      percent: pct(realEstateTotal),
      color: "#00f59b",
      valueNumber: realEstateTotal,
    },
    {
      name: "Retirement",
      amount: money(retirementTotal),
      percent: pct(retirementTotal),
      color: "#ff5d7a",
      valueNumber: retirementTotal,
    },
  ];

  useEffect(() => {
    const nextPersistedState = {
      users: persistedUsers,
      activeUserId: activeUser?.id || persistedUsers[0]?.id || null,
    };

    if (persistLocally) {
      persistAppState(sanitizeWorkspaceStateForPersistence(nextPersistedState), storageKey);
    }
    if (typeof onPersistedStateChange === "function") {
      onPersistedStateChange(nextPersistedState);
    }
  }, [activeUser?.id, onPersistedStateChange, persistLocally, persistedUsers, storageKey]);

  useEffect(() => {
    let cancelled = false;

    if (
      !shouldFetchPlaidStatus({
        currentView,
        isDemoMode,
        sessionUser: sessionControls?.user || null,
      })
    ) {
      setPlaidStatus({
        configured: false,
        environment: "development",
        notes: [],
      });
      return () => {
        cancelled = true;
      };
    }

    getPlaidStatus({ user: sessionControls?.user || null })
      .then((status) => {
        if (!cancelled) setPlaidStatus(status);
      })
      .catch(() => {
        if (!cancelled) {
          setPlaidStatus({
            configured: false,
            environment: "development",
            notes: [],
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentView, isDemoMode, sessionControls?.user]);

  useEffect(() => {
    if (!plaidStatus.configured || plaidOAuthResumeAttemptedRef.current) return;

    const pendingLink = loadPendingPlaidLinkState();
    const receivedRedirectUri =
      plaidOAuthRedirectUri || (hasOAuthStateInUrl() ? window.location.href : null);
    if (!pendingLink?.linkToken || !receivedRedirectUri) return;

    plaidOAuthResumeAttemptedRef.current = true;
    setPlaidLinkToken(pendingLink.linkToken);
    setPlaidTargetUserId(pendingLink.targetUserId || activeUser.id);
    setPlaidTargetItemId(pendingLink.plaidItemId || null);
    setPlaidOAuthRedirectUri(receivedRedirectUri);
    setPlaidShouldOpen(true);
    setPlaidError("");
    clearOAuthStateFromUrl();
  }, [activeUser.id, plaidOAuthRedirectUri, plaidStatus.configured]);

  const applyPlaidSyncPayload = (userId, syncPayload) => {
    setUsers((currentUsers) =>
      currentUsers.map((user) =>
        user.id === userId ? mergePlaidSyncIntoUser(user, syncPayload) : user
      )
    );
  };

  const syncLinkedPlaidAccounts = useCallback(
    async (userId = activeUser.id, { silent = false, live = false } = {}) => {
      if (!userId || !plaidStatus.configured) return null;

      if (!silent) setPlaidError("");
      setIsPlaidSyncing(true);

      try {
        const payload = await syncPlaidUser(userId, { user: sessionControls?.user || null, live });
        applyPlaidSyncPayload(userId, payload);
        setPlaidError((currentError) =>
          silent && !isStalePlaidSyncError(currentError) ? currentError : ""
        );
        return payload;
      } catch (error) {
        if (!silent) {
          setPlaidError(error.message || "Unable to sync Plaid data right now.");
        }
        return null;
      } finally {
        setIsPlaidSyncing(false);
      }
    },
    [activeUser.id, plaidStatus.configured, sessionControls?.user]
  );

  useEffect(() => {
    if (!plaidStatus.configured || !activeUser?.id || plaidItems.length > 0) return;
    if (plaidRecoverySyncUserIdsRef.current.has(activeUser.id)) return;

    plaidRecoverySyncUserIdsRef.current.add(activeUser.id);
    const timeoutId = window.setTimeout(() => {
      void syncLinkedPlaidAccounts(activeUser.id, { silent: true });
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeUser?.id, plaidItems.length, plaidStatus.configured, syncLinkedPlaidAccounts]);

  // Plaid resync is on-demand only (the Accounts "Refresh" button) to avoid
  // billing on every login and on a recurring timer. The empty-state recovery
  // sync above still runs once when no accounts are loaded yet, and inbound
  // Plaid webhooks continue to refresh data when the bank reports changes.

  const resetPlaidLinkState = () => {
    setPlaidShouldOpen(false);
    setPlaidLinkToken(null);
    setPlaidTargetUserId(null);
    setPlaidTargetItemId(null);
    setPlaidOAuthRedirectUri(null);
    clearPendingPlaidLinkState();
    clearOAuthStateFromUrl();
  };

  const closePlaidConsentPrompt = () => {
    setPlaidConsentPrompt(null);
    setHasAcceptedPlaidConsent(false);
    setPlaidConsentError("");
  };

  const closeEmailVerificationPrompt = () => {
    setEmailVerificationPromptOpen(false);
  };

  const requiresEmailVerificationForPlaid =
    !isDemoMode && sessionControls && sessionControls.isEmailVerified === false;

  const { open: openPlaidLink, ready: isPlaidReady } = usePlaidLink({
    token: plaidLinkToken,
    receivedRedirectUri: plaidOAuthRedirectUri || undefined,
    onSuccess: async (publicToken, metadata) => {
      const targetUserId = plaidTargetUserId || activeUser.id;
      const isRepairFlow = Boolean(plaidTargetItemId);
      const plaidAccounts = (metadata?.accounts || []).map((account) => ({
        id: account.id,
        name: account.name,
        subtype: account.subtype,
        type: account.type,
      }));
      const plaidLogFields = {
        mode: isRepairFlow ? "update" : "connect",
        institutionId: metadata?.institution?.institution_id,
        institutionName: metadata?.institution?.name,
        linkSessionId: metadata?.link_session_id,
        requestId: metadata?.request_id,
        accountIds: plaidAccounts.map((account) => account.id).filter(Boolean),
      };

      logPlaidClientEvent("link_success", plaidLogFields);
      setPlaidError("");
      setIsPlaidSyncing(true);

      try {
        const payload = await exchangePlaidPublicToken(
          {
            workspaceUserId: targetUserId,
            publicToken,
            plaidItemId: plaidTargetItemId,
            linkMetadata: {
              institution: metadata?.institution
                ? {
                    institution_id: metadata.institution.institution_id,
                    name: metadata.institution.name,
                  }
                : null,
              accounts: plaidAccounts,
              link_session_id: metadata?.link_session_id || null,
              request_id: metadata?.request_id || null,
            },
          },
          { user: sessionControls?.user || null }
        );
        applyPlaidSyncPayload(targetUserId, payload);
        if (targetUserId === activeUser.id && !isRepairFlow) {
          setActiveTab(APP_TABS.TRANSACTIONS);
        }
      } catch (error) {
        logPlaidClientEvent(
          "exchange_public_token_failed",
          {
            ...plaidLogFields,
            code: error.code,
            message: error.message,
          },
          "warn"
        );
        setPlaidError(error.message || "Unable to connect the Plaid item.");
      } finally {
        setIsPlaidSyncing(false);
        resetPlaidLinkState();
      }
    },
    onExit: (error, metadata) => {
      logPlaidClientEvent(
        error ? "link_exit_error" : "link_exit",
        {
          institutionId: metadata?.institution?.institution_id,
          institutionName: metadata?.institution?.name,
          linkSessionId: metadata?.link_session_id,
          requestId: metadata?.request_id,
          status: metadata?.status,
          errorCode: error?.error_code,
          errorMessage: error?.error_message,
        },
        error ? "warn" : "info"
      );
      resetPlaidLinkState();
    },
  });

  useEffect(() => {
    if (plaidShouldOpen && isPlaidReady) {
      const timeoutId = window.setTimeout(() => {
        openPlaidLink();
      }, 0);

      return () => {
        window.clearTimeout(timeoutId);
      };
    }
  }, [plaidShouldOpen, isPlaidReady, openPlaidLink]);

  const dynamicMetrics = [
    {
      icon: METRIC_ICONS.trueCash,
      title: "TRUE CASH",
      value: money(trueCash),
      infoText:
        "True Cash is spendable cash: liquid cash minus credit card debt minus committed reserves. It can be negative if you have committed more than you hold.",
      ...buildTrackedTrueCashMeta(trackedMetricSnapshots, trueCash, true),
      ...(isReservesOvercommitted
        ? {
            change: "Overcommitted",
            changeColor: "#ff355d",
            changeIcon: "!",
          }
        : {}),
      onClick: () => setActiveTab(APP_TABS.ADD_ACCOUNTS),
    },
    {
      icon: METRIC_ICONS.liquidCash,
      title: "LIQUID CASH",
      value: money(liquidCash),
      infoText:
        "Liquid Cash (gross) is the money physically in your checking, savings, and manual cash accounts, before reserves are set aside.",
      ...buildTrackedMetricMeta(trackedMetricSnapshots, "liquidCash", liquidCash, true),
      onClick: () => setActiveTab(APP_TABS.ADD_ACCOUNTS),
    },
    {
      icon: METRIC_ICONS.creditCardDebt,
      title: "CREDIT CARD DEBT",
      value: money(creditCardDebt),
      infoText: "Credit Card Debt is the total outstanding balance across all connected credit cards.",
      ...buildTrackedMetricMeta(trackedMetricSnapshots, "creditCardDebt", creditCardDebt, false),
      onClick: () => setActiveTab(APP_TABS.ADD_ACCOUNTS),
    },
    {
      icon: METRIC_ICONS.monthlyFlow,
      title: "CURRENT MONTH CASH FLOW",
      value: money(monthlyFlow),
      infoText: "Current Month Cash Flow is planned income minus planned spend for this month.",
      change: monthlyFlow >= 0 ? "Projected surplus" : "Projected deficit",
      changeColor: monthlyFlow >= 0 ? "#00f59b" : "#ff355d",
      changeIcon: monthlyFlow >= 0 ? "↑" : "↓",
      subLabel: `${currentMonth} plan`,
      onClick: () => setActiveTab(APP_TABS.BUDGET_COMMAND_CENTER),
    },
    {
      icon: METRIC_ICONS.reserves,
      title: "RESERVES",
      value: money(reservesBalance),
      infoText:
        "Reserves is committed cash — the total of every reserve category balance. It still sits in your bank but is removed from spendable True Cash.",
      subLabel: isReservesOvercommitted ? "Overcommitted vs. cash" : "Committed cash",
      ...(isReservesOvercommitted
        ? { change: "Exceeds available cash", changeColor: "#ff355d", changeIcon: "!" }
        : {}),
      onClick: () => setActiveTab(APP_TABS.ADD_ACCOUNTS),
    },
  ];

  useEffect(() => {
    const liveMetalsAccounts = accounts.filter(
      (account) =>
        account.type === "Precious Metals" &&
        account.valuationSource === "Live Spot" &&
        account.metalType !== "Custom" &&
        isPreciousMetalsPriceStale(account.lastValuedAt)
    );

    if (liveMetalsAccounts.length === 0) return;

    let cancelled = false;
    fetchPreciousMetalsSpotPrices()
      .then((quotes) => {
        if (cancelled) return;
        if (Object.keys(quotes).length === 0) {
          setPriceFeedNotice(
            "metals",
            "Precious metals spot prices could not be refreshed. Metal values may be out of date."
          );
          return;
        }
        setPriceFeedNotice("metals", "");

        setUsers((currentUsers) =>
          currentUsers.map((user) => {
            if (user.id !== activeUser.id) return user;

            let changed = false;
            const nextAccounts = user.accounts.map((account) => {
              if (
                account.type !== "Precious Metals" ||
                account.valuationSource !== "Live Spot" ||
                account.metalType === "Custom"
              ) {
                return account;
              }

              const quote = quotes[account.metalType];
              if (!quote) return account;

              const pricePerUnit = normalizePreciousMetalsPricePerUnit(
                quote.pricePerTroyOunce,
                account.metalUnit
              );
              const nextBalance = roundCurrency((Number(account.quantity) || 0) * pricePerUnit);
              if (
                account.pricePerUnit === pricePerUnit &&
                account.balance === nextBalance &&
                account.lastValuedAt === quote.updatedAt
              ) {
                return account;
              }

              changed = true;
              return {
                ...account,
                pricePerUnit,
                balance: nextBalance,
                lastValuedAt: quote.updatedAt,
              };
            });

            return changed ? { ...user, accounts: nextAccounts } : user;
          })
        );
      })
      .catch(() => {
        if (cancelled) return;
        setPriceFeedNotice(
          "metals",
          "Precious metals spot prices could not be refreshed. Metal values may be out of date."
        );
      });

    return () => {
      cancelled = true;
    };
  }, [accounts, activeUser.id, isDemoMode]);

  useEffect(() => {
    if (isDemoMode) return;

    const staleCryptoAccounts = accounts.filter(
      (account) =>
        account.type === "Crypto" &&
        account.cryptoAssetId &&
        isCryptoPriceStale(account.lastPriceUpdatedAt)
    );

    if (staleCryptoAccounts.length === 0) return;

    let cancelled = false;
    const uniqueAssetIds = [
      ...new Set(staleCryptoAccounts.map((account) => account.cryptoAssetId)),
    ];

    fetchCryptoQuotes(uniqueAssetIds)
      .then((quotes) => {
        if (cancelled) return;
        if (Object.keys(quotes).length === 0) {
          setPriceFeedNotice(
            "crypto",
            "Crypto prices could not be refreshed from CoinGecko. Crypto values may be out of date."
          );
          return;
        }
        setPriceFeedNotice("crypto", "");

        setUsers((currentUsers) =>
          currentUsers.map((user) => {
            if (user.id !== activeUser.id) return user;

            let changed = false;
            const nextAccounts = user.accounts.map((account) => {
              if (account.type !== "Crypto" || !account.cryptoAssetId) return account;

              const quote = quotes[account.cryptoAssetId];
              if (!quote) return account;

              const nextPriceUsd = normalizeCryptoPrice(quote.priceUsd);
              const nextBalance = calculateCryptoBalance(account.quantity, nextPriceUsd);
              const nextUpdatedAt = quote.lastUpdatedAt;

              if (
                account.lastPriceUsd === nextPriceUsd &&
                account.balance === nextBalance &&
                account.lastPriceUpdatedAt === nextUpdatedAt
              ) {
                return account;
              }

              changed = true;
              return {
                ...account,
                lastPriceUsd: nextPriceUsd,
                lastPriceUpdatedAt: nextUpdatedAt,
                balance: nextBalance,
                priceSource: CRYPTO_PRICE_SOURCE,
              };
            });

            return changed ? { ...user, accounts: nextAccounts } : user;
          })
        );
      })
      .catch(() => {
        if (cancelled) return;
        setPriceFeedNotice(
          "crypto",
          "Crypto prices could not be refreshed from CoinGecko. Crypto values may be out of date."
        );
      });

    return () => {
      cancelled = true;
    };
  }, [accounts, activeUser.id, isDemoMode]);

  const startPlaidLinkFlow = async ({ plaidItemId = null } = {}) => {
    if (!activeUser?.id) return;

    if (!plaidStatus.configured) {
      setPlaidError("Plaid is not configured yet. Live account linking is unavailable.");
      return;
    }

    setPlaidError("");
    setIsPlaidSyncing(true);
    logPlaidClientEvent("link_token_requested", {
      mode: plaidItemId ? "update" : "connect",
      plaidItemId,
      workspaceUserId: activeUser.id,
    });

    try {
      const { linkToken } = await createPlaidLinkToken(
        {
          workspaceUserId: activeUser.id,
          plaidItemId,
        },
        { user: sessionControls?.user || null }
      );
      setPlaidLinkToken(linkToken);
      setPlaidTargetUserId(activeUser.id);
      setPlaidTargetItemId(plaidItemId);
      setPlaidOAuthRedirectUri(null);
      savePendingPlaidLinkState({
        linkToken,
        targetUserId: activeUser.id,
        plaidItemId,
      });
      setPlaidShouldOpen(true);
      logPlaidClientEvent("link_token_created", {
        mode: plaidItemId ? "update" : "connect",
        plaidItemId,
        workspaceUserId: activeUser.id,
      });
    } catch (error) {
      logPlaidClientEvent(
        "link_token_failed",
        {
          mode: plaidItemId ? "update" : "connect",
          plaidItemId,
          workspaceUserId: activeUser.id,
          code: error.code,
          message: error.message,
        },
        "warn"
      );
      if (
        typeof error?.message === "string" &&
        error.message.toLowerCase().includes("email verification is required")
      ) {
        setEmailVerificationPromptOpen(true);
        return;
      }
      setPlaidError(
        error.message ||
          (plaidItemId
            ? "Unable to start the Plaid repair flow."
            : "Unable to start the Plaid Link flow.")
      );
    } finally {
      setIsPlaidSyncing(false);
    }
  };

  const requestPlaidLinkConsent = ({ plaidItemId = null } = {}) => {
    if (isDemoMode) {
      setPlaidError(
        "Bank connections are disabled in demo mode. Create an account to link your own accounts."
      );
      return;
    }
    if (requiresEmailVerificationForPlaid) {
      setEmailVerificationPromptOpen(true);
      return;
    }
    setPlaidConsentPrompt({ plaidItemId });
    setHasAcceptedPlaidConsent(false);
    setPlaidConsentError("");
    setPlaidError("");
  };

  const connectPlaidAccount = () => {
    if (isDemoMode) {
      setPlaidError(
        "Bank connections are disabled in demo mode. Create an account to link your own accounts."
      );
      return;
    }
    requestPlaidLinkConsent();
  };

  const repairPlaidItem = (plaidItemId) => {
    if (!plaidItemId) return;
    requestPlaidLinkConsent({ plaidItemId });
  };

  const confirmPlaidConsent = async () => {
    if (!plaidConsentPrompt) return;
    if (!hasAcceptedPlaidConsent) {
      setPlaidConsentError(
        "Confirm the Plaid disclosure before continuing to connected-account access."
      );
      return;
    }

    const request = plaidConsentPrompt;
    closePlaidConsentPrompt();
    await startPlaidLinkFlow({ plaidItemId: request.plaidItemId || null });
  };

  const addManualAccount = (accountInput) => {
    const currentTimestamp = getCurrentTimestamp();
    setAccounts((current) => [
      ...current,
      createManualAccount(accountInput, current.length, { timestamp: currentTimestamp }),
    ]);
    openAccountTransactions(accountInput.name);
  };

  const renameAccount = (accountId, nickname) => {
    if (!accountId) return;
    setAccounts((current) =>
      current.map((account) =>
        account.id === accountId
          ? { ...account, nickname: typeof nickname === "string" && nickname.trim() ? nickname.trim() : null }
          : account
      )
    );
  };

  const updateManualAccount = (accountId, accountInput) => {
    if (!accountId || !activeUser?.id) return;

    setUsers((currentUsers) =>
      currentUsers.map((user) =>
        user.id === activeUser.id
          ? updateManualAccountInUser(user, accountId, accountInput, {
              timestamp: getCurrentTimestamp(),
            })
          : user
      )
    );
  };

  const selectedTransactions = selectedAccount
    ? categorizedTransactions.filter((tx) => tx.account === selectedAccount)
    : [];

  const visibleTransactions = selectedAccount ? selectedTransactions : categorizedTransactions;

  const openAccountTransactions = (accountName) => {
    setSelectedAccount(accountName);
    setActiveTab(APP_TABS.TRANSACTIONS);
  };

  const addManualTransaction = (transaction) => {
    const targetAccountName = transaction.account.trim();
    const targetAccount = accounts.find((account) => account.name === targetAccountName);
    const amount = roundCurrency(transaction.amount);

    if (!targetAccount || !Number.isFinite(amount) || amount === 0) return false;
    if (!accountSupportsManualTransactions(targetAccount)) return false;

    setTransactions((current) => [
      {
        ...transaction,
        account: targetAccountName,
        amount,
        id: `manual-tx-${getCurrentTimestamp()}-${current.length + 1}`,
        source: "manual",
        categorySource: transaction.category ? "manual" : undefined,
        categoryConfidence: transaction.category ? 100 : undefined,
        needsReview: transaction.category ? false : undefined,
      },
      ...current,
    ]);
    setAccounts((current) =>
      current.map((account) =>
        account.name === targetAccountName
          ? { ...account, balance: roundCurrency(account.balance + amount) }
          : account
      )
    );
    return true;
  };

  const deleteManualTransaction = (transactionId) => {
    const transactionToDelete = transactions.find(
      (transaction) => transaction.id === transactionId && transaction.source === "manual"
    );

    if (!transactionToDelete) return;

    setTransactions((current) =>
      current.filter(
        (transaction) => transaction.id !== transactionId || transaction.source !== "manual"
      )
    );
    setAccounts((current) =>
      current.map((account) =>
        // Never delta a Plaid-linked balance: it is owned by the bank sync.
        account.name === transactionToDelete.account && !isPlaidLinkedAccount(account)
          ? {
              ...account,
              balance: roundCurrency(account.balance - transactionToDelete.amount),
            }
          : account
      )
    );
  };

  const updateManualTransaction = (transactionId, updates) => {
    const transactionToUpdate = transactions.find(
      (transaction) => transaction.id === transactionId && transaction.source === "manual"
    );
    if (!transactionToUpdate) return false;

    const nextAccountName = String(updates.account ?? transactionToUpdate.account).trim();
    const nextAccount = accounts.find((account) => account.name === nextAccountName);
    const nextAmount = roundCurrency(updates.amount ?? transactionToUpdate.amount);
    const nextMerchant = String(updates.merchant ?? transactionToUpdate.merchant).trim();
    const nextDate = String(updates.date ?? transactionToUpdate.date).trim();

    if (!nextAccount || !accountSupportsManualTransactions(nextAccount)) return false;
    if (!Number.isFinite(nextAmount) || nextAmount === 0) return false;
    if (!nextMerchant || !nextDate) return false;

    const categoryProvided =
      updates.category !== undefined && updates.category !== null && String(updates.category).trim() !== "";
    const nextCategory = categoryProvided ? String(updates.category).trim() : transactionToUpdate.category;

    setTransactions((current) =>
      current.map((transaction) =>
        transaction.id === transactionId && transaction.source === "manual"
          ? {
              ...transaction,
              date: nextDate,
              merchant: nextMerchant,
              account: nextAccountName,
              amount: nextAmount,
              category: nextCategory,
              categorySource: nextCategory ? "manual" : transaction.categorySource,
              categoryConfidence: nextCategory ? 100 : transaction.categoryConfidence,
              needsReview: nextCategory ? false : transaction.needsReview,
            }
          : transaction
      )
    );

    setAccounts((current) =>
      current.map((account) => {
        // Never delta a Plaid-linked balance: it is owned by the bank sync.
        if (isPlaidLinkedAccount(account)) return account;
        let balanceDelta = 0;
        if (account.name === transactionToUpdate.account) {
          balanceDelta -= transactionToUpdate.amount;
        }
        if (account.name === nextAccountName) {
          balanceDelta += nextAmount;
        }
        if (balanceDelta === 0) return account;
        return {
          ...account,
          balance: roundCurrency(account.balance + balanceDelta),
        };
      })
    );

    return true;
  };

  const updatePlaidTransactionDateNickname = (transactionId, nicknameDate) => {
    const transactionToUpdate = transactions.find(
      (transaction) => transaction.id === transactionId && transaction.source === "plaid"
    );
    if (!transactionToUpdate) return false;

    const nicknameDateText =
      nicknameDate === null || nicknameDate === undefined ? "" : String(nicknameDate).trim();
    if (nicknameDateText) {
      const parsedNicknameDate = new Date(nicknameDateText);
      if (Number.isNaN(parsedNicknameDate.getTime())) return false;
    }

    if (!nicknameDateText) {
      setPlaidTransactionOverrides((current) =>
        upsertPlaidDateNicknameOverride(current, transactionToUpdate, null)
      );
    } else {
      setPlaidTransactionOverrides((current) =>
        upsertPlaidDateNicknameOverride(current, transactionToUpdate, nicknameDateText)
      );
    }

    setTransactions((current) =>
      current.map((transaction) => {
        if (transaction.id !== transactionId || transaction.source !== "plaid") return transaction;
        const postedDate = transaction.plaidPostedDate || transaction.date;

        if (!nicknameDateText) {
          return {
            ...transaction,
            date: postedDate,
            dateNickname: undefined,
            dateNicknameUpdatedAt: undefined,
          };
        }

        return {
          ...transaction,
          date: nicknameDateText,
          dateNickname: nicknameDateText,
          plaidPostedDate: postedDate,
          dateNicknameUpdatedAt: getCurrentTimestamp(),
        };
      })
    );

    return true;
  };

  const addRecurringSubscriptionFromTransaction = (transaction, options = {}) => {
    const draft = buildRecurringSubscriptionFromTransaction(transaction, options);
    if (!draft) {
      return { added: false, reason: "Only spend transactions can be tracked as recurring." };
    }

    const normalizedDraftName = normalizeRecurringMatchToken(draft.name);
    const normalizedDraftAccount = normalizeRecurringMatchToken(draft.account);
    let wasAdded = false;

    setSubscriptions((currentSubscriptions) => {
      const subscriptionList = Array.isArray(currentSubscriptions) ? currentSubscriptions : [];
      const alreadyExists = subscriptionList.some(
        (subscription) =>
          normalizeRecurringMatchToken(subscription.name) === normalizedDraftName &&
          normalizeRecurringMatchToken(subscription.account) === normalizedDraftAccount &&
          subscription.status !== "Cancelled"
      );
      if (alreadyExists) return subscriptionList;

      wasAdded = true;
      const nextSubscription = {
        ...draft,
        id: `sub-custom-${Date.now()}-${subscriptionList.length + 1}`,
      };
      return [...subscriptionList, nextSubscription];
    });

    if (!wasAdded) {
      return { added: false, reason: "That recurring expense is already being tracked." };
    }

    if (options?.suggestionKey) {
      setRecurringPreferences((currentPreferences) =>
        acceptRecurringSuggestionKey(currentPreferences, options.suggestionKey)
      );
    }

    return { added: true };
  };

  const updateTransactionCategory = (transactionToUpdate, nextCategory) => {
    if (!transactionToUpdate) return;

    setMerchantCategoryRules((current) =>
      buildMerchantCategoryRules(current, transactionToUpdate.merchant, nextCategory)
    );

    if (transactionToUpdate.source === "plaid") {
      setPlaidTransactionOverrides((current) =>
        upsertPlaidCategoryOverride(current, transactionToUpdate, nextCategory)
      );
    }

    setTransactions((current) => {
      if (transactionToUpdate.id) {
        return current.map((tx) =>
          tx.id === transactionToUpdate.id
            ? {
                ...tx,
                category: nextCategory,
                categorySource: "user",
                categoryConfidence: 100,
                needsReview: false,
              }
            : tx
        );
      }

      const existingIndex = current.findIndex(
        (tx) =>
          tx.date === transactionToUpdate.date &&
          tx.merchant === transactionToUpdate.merchant &&
          tx.account === transactionToUpdate.account &&
          tx.amount === transactionToUpdate.amount
      );

      if (existingIndex >= 0) {
        return current.map((tx, index) =>
          index === existingIndex
            ? {
                ...tx,
                category: nextCategory,
                categorySource: "user",
                categoryConfidence: 100,
                needsReview: false,
              }
            : tx
        );
      }

      return current;
    });
  };

  const startEditingUser = (userId) => {
    const targetUser = users.find((user) => user.id === userId);
    const targetIndex = users.findIndex((user) => user.id === userId);
    if (!targetUser) return;

    setActiveUserId(userId);
    setEditingUserId(userId);
    setDraftUserName(getDisplayUserName(targetUser, targetIndex >= 0 ? targetIndex : 0));
  };

  const saveUserName = (userId) => {
    const targetIndex = users.findIndex((user) => user.id === userId);
    if (targetIndex < 0) {
      setEditingUserId(null);
      setDraftUserName("");
      return;
    }

    const nextName = draftUserName.trim() || `User ${targetIndex + 1}`;
    setUsers((currentUsers) =>
      currentUsers.map((user, index) =>
        user.id === userId ? { ...user, name: nextName || `User ${index + 1}` } : user
      )
    );
    setEditingUserId(null);
    setDraftUserName("");
  };

  const cancelUserRename = () => {
    setEditingUserId(null);
    setDraftUserName("");
  };

  const addUserProfile = () => {
    const nextNumber = users.length + 1;
    const newUser = createEmptyUserProfile({
      name: `User ${nextNumber}`,
    });

    setUsers((currentUsers) => [...currentUsers, newUser]);
    setActiveUserId(newUser.id);
    setEditingUserId(newUser.id);
    setDraftUserName(newUser.name);
  };
  const deleteUserProfile = async (userId) => {
    const targetIndex = users.findIndex((user) => user.id === userId);
    if (targetIndex < 0) return;
    if (users.length <= 1) {
      throw new Error("At least one user profile must remain in the workspace.");
    }

    const targetUser = users[targetIndex];
    if ((targetUser.plaidItems || []).length > 0) {
      await deletePlaidUser(userId, { user: sessionControls?.user || null });
    }

    const nextUsers = users.filter((user) => user.id !== userId);
    const fallbackUser =
      nextUsers[targetIndex] || nextUsers[targetIndex - 1] || nextUsers[0] || EMPTY_USER_STATE;

    setUsers(nextUsers);
    setActiveUserId((currentUserId) => {
      if (currentUserId === userId || !nextUsers.some((user) => user.id === currentUserId)) {
        return fallbackUser.id;
      }
      return currentUserId;
    });

    if (editingUserId === userId) {
      setEditingUserId(null);
      setDraftUserName("");
    }

    if (plaidTargetUserId === userId) {
      setPlaidShouldOpen(false);
      setPlaidLinkToken(null);
      setPlaidTargetUserId(null);
    }

    if (activeUserId === userId) {
      setPlaidError("");
    }
  };
  const deleteAccount = async (accountToDelete) => {
    if (!accountToDelete?.id || !activeUser?.id) return;

    if (accountToDelete.plaidItemId) {
      await deletePlaidItem(
        {
          itemId: accountToDelete.plaidItemId,
          workspaceUserId: activeUser.id,
        },
        { user: sessionControls?.user || null }
      );
      setUsers((currentUsers) =>
        currentUsers.map((user) =>
          user.id === activeUser.id ? removePlaidItemFromUser(user, accountToDelete.plaidItemId) : user
        )
      );
      if (selectedAccount === accountToDelete.name) {
        setSelectedAccount(null);
      }
      return;
    }

    setUsers((currentUsers) =>
      currentUsers.map((user) =>
        user.id === activeUser.id ? removeManualAccountFromUser(user, accountToDelete) : user
      )
    );
    if (selectedAccount === accountToDelete.name) {
      setSelectedAccount(null);
    }
  };
  const plaidIntegration = {
    configured: plaidStatus.configured,
    environment: plaidStatus.environment,
    notes: plaidStatus.notes || [],
    isSyncing: isPlaidSyncing,
    error: plaidError,
    lastSyncAt: lastPlaidSyncAt,
    connectedItemCount: plaidItems.length,
    items: plaidItems,
    onRefresh: () => syncLinkedPlaidAccounts(activeUser?.id, { live: true }),
  };
  const householdProfilesProps = {
    users,
    activeUserId,
    editingUserId,
    draftUserName,
    setDraftUserName,
    onSelectUser: (userId) => {
      setActiveUserId(userId);
      if (editingUserId && editingUserId !== userId) {
        cancelUserRename();
      }
    },
    onStartEditingUser: startEditingUser,
    onSaveUserName: saveUserName,
    onCancelUserRename: cancelUserRename,
    onAddUser: addUserProfile,
    onOpenGuide: openGuide,
    onDeleteUser: deleteUserProfile,
  };
  const handleEnterApp = (payload = {}) => {
    if (payload?.mode === "create-account") {
      const newUser = createEmptyUserProfile({
        name: payload.primaryUserName || "User 1",
      });
      setUsers([newUser]);
      setActiveUserId(newUser.id);
      setEditingUserId(null);
      setDraftUserName("");
      setPlaidError("");
    }

    setCurrentView("app");
  };

  const appUIScale = useViewportUIScale();

  if (currentView === "landing") {
    return (
      <LandingPage enterApp={handleEnterApp} onEnterDemo={onEnterDemo} onBackToOs={onBackToOs} />
    );
  }

  const handleBackHome = () => {
    if (isDemoMode && typeof onExitDemo === "function") {
      onExitDemo();
      setIsMobileNavOpen(false);
      return;
    }
    if (sessionControls?.onSignOut) {
      void sessionControls.onSignOut();
      setIsMobileNavOpen(false);
      return;
    }
    setCurrentView("landing");
    setIsMobileNavOpen(false);
  };

  // Freedom OS is the platform home: authenticated sessions land on the module
  // hub (CEO Agents / Freedom Financial). Demo and signed-out sessions keep the
  // in-shell signed-out card below.
  if (activeTab === APP_TABS.FREEDOM_OS && freedomOsAuthUser) {
    const inCeoAgents = freedomOsModule === FREEDOM_OS_MODULE_IDS.CEO_AGENTS;
    return (
      <FreedomOsDeck
        sessionControls={sessionControls}
        isAdmin={isPlatformAdmin}
        moduleLabel={inCeoAgents ? "Module 01 · CEO Agents" : "Select a module"}
        onBackToModules={inCeoAgents ? () => setFreedomOsModule(null) : null}
        onOpenAdminUsage={() => setActiveTab(APP_TABS.ADMIN_USAGE)}
      >
        <ViewErrorBoundary
          key={inCeoAgents ? "ceo-agents" : "module-hub"}
          viewName={APP_TABS.FREEDOM_OS}
        >
          {inCeoAgents ? (
            <FreedomOsHome
              user={freedomOsAuthUser}
              onOpenFinanceTool={() => setActiveTab(APP_TABS.DASHBOARD)}
            />
          ) : (
            <FreedomOsModuleHub onSelectModule={handleSelectFreedomOsModule} />
          )}
        </ViewErrorBoundary>
      </FreedomOsDeck>
    );
  }

  return (
    <div className="app-page" style={styles.page}>
      <div className="app-shell" style={styles.shell}>
        <AppSidebar
          className="app-sidebar--desktop"
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onBackHome={handleBackHome}
          sessionControls={sessionControls}
          onboardingProgress={onboardingProgress}
          onOpenSetupStep={openOnboardingStep}
          onSkipSetup={skipOnboarding}
          isAdmin={isPlatformAdmin}
        />

        <div className={`mobile-nav-backdrop${isMobileNavOpen ? " is-open" : ""}`} onClick={() => setIsMobileNavOpen(false)} />
        <div className={`mobile-nav-drawer${isMobileNavOpen ? " is-open" : ""}`}>
          <AppSidebar
            className="app-sidebar--mobile"
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            onBackHome={handleBackHome}
            sessionControls={sessionControls}
            onboardingProgress={onboardingProgress}
            onOpenSetupStep={openOnboardingStep}
            onSkipSetup={skipOnboarding}
            isAdmin={isPlatformAdmin}
            onNavigate={() => setIsMobileNavOpen(false)}
          />
        </div>

        <main
          className="app-main"
          style={{
            ...styles.main,
            ...(appUIScale !== 1 ? { ["--app-ui-scale"]: appUIScale } : {}),
          }}
          data-scaled={appUIScale !== 1 ? "true" : undefined}
        >
          <div className="mobile-topbar">
            <button
              type="button"
              className="mobile-menu-button"
              onClick={() => setIsMobileNavOpen(true)}
              aria-label="Open navigation"
            >
              ☰
            </button>
            <div>
              <div className="mobile-topbar-eyebrow">Forward Freedom</div>
              <div className="mobile-topbar-title">{activeTab}</div>
            </div>
            <button
              type="button"
              className="mobile-menu-button"
              onClick={openGuide}
              aria-label="Open guide assistant"
              style={{ marginLeft: "auto" }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 2.8L13.95 8.05 19.2 10 13.95 11.95 12 17.2 10.05 11.95 4.8 10 10.05 8.05 12 2.8Z"
                  fill="currentColor"
                  opacity="0.98"
                />
                <path
                  d="M18.2 15.2L19.05 17.45 21.3 18.3 19.05 19.15 18.2 21.4 17.35 19.15 15.1 18.3 17.35 17.45 18.2 15.2Z"
                  fill="currentColor"
                  opacity="0.82"
                />
              </svg>
            </button>
          </div>
          <div
            style={{
              marginBottom: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 14,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {onboardingProgress.currentStep &&
              (!onboardingProgress.isActive || onboardingProgress.onboarding.skippedAt) ? (
                <button
                  type="button"
                  onClick={startOnboarding}
                  style={{
                    borderRadius: 10,
                    border: "1px solid rgba(0,216,255,.22)",
                    background: "rgba(0,136,255,.08)",
                    color: "#eef6ff",
                    padding: "10px 13px",
                    cursor: "pointer",
                    fontWeight: 800,
                  }}
                >
                  Resume setup
                </button>
              ) : null}
            </div>
          </div>
          {isDemoMode ? (
            <div
              style={{
                marginBottom: 18,
                border: "1px solid rgba(0,216,255,.28)",
                borderRadius: 12,
                background: "linear-gradient(90deg, rgba(0,119,255,.16), rgba(0,216,255,.08))",
                padding: "14px 18px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              <div>
                <div
                  style={{
                    color: "#8feaff",
                    fontSize: 11,
                    fontWeight: 900,
                    letterSpacing: 1.1,
                    textTransform: "uppercase",
                    marginBottom: 6,
                  }}
                >
                  Demo Mode
                </div>
                <div style={{ color: "#eef6ff", fontSize: 15, lineHeight: 1.5 }}>
                  You are exploring sample data in a sandbox. Changes are not saved.
                </div>
              </div>
              {typeof onExitDemo === "function" ? (
                <button
                  type="button"
                  onClick={onExitDemo}
                  style={{
                    border: "1px solid rgba(0,216,255,.35)",
                    borderRadius: 8,
                    background: "rgba(0,136,255,.12)",
                    color: "#eef6ff",
                    padding: "10px 14px",
                    cursor: "pointer",
                    fontWeight: 800,
                    whiteSpace: "nowrap",
                  }}
                >
                  Exit Demo
                </button>
              ) : null}
            </div>
          ) : null}
          {priceFeedNotices.crypto || priceFeedNotices.metals ? (
            <div
              role="alert"
              style={{
                marginBottom: 18,
                border: "1px solid rgba(255,166,0,.32)",
                borderRadius: 12,
                background: "linear-gradient(90deg, rgba(61,34,0,.42), rgba(11,18,35,.9))",
                padding: "12px 16px",
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 14,
              }}
            >
              <div style={{ display: "grid", gap: 4 }}>
                <div style={{ color: "#ffd38a", fontSize: 12, fontWeight: 800, letterSpacing: 0.4 }}>
                  Live pricing unavailable
                </div>
                {[priceFeedNotices.crypto, priceFeedNotices.metals]
                  .filter(Boolean)
                  .map((notice) => (
                    <div key={notice} style={{ color: "#e8d9c2", fontSize: 13, lineHeight: 1.5 }}>
                      {notice}
                    </div>
                  ))}
              </div>
              <button
                type="button"
                onClick={() => setPriceFeedNotices({ crypto: "", metals: "" })}
                aria-label="Dismiss pricing notice"
                style={{
                  border: "1px solid rgba(255,211,138,.35)",
                  borderRadius: 8,
                  background: "transparent",
                  color: "#ffd38a",
                  padding: "4px 10px",
                  cursor: "pointer",
                  fontWeight: 800,
                  flexShrink: 0,
                }}
              >
                Dismiss
              </button>
            </div>
          ) : null}
          <SetupStepBanner
            progress={onboardingProgress}
            activeTab={activeTab}
            onOpenStep={openOnboardingStep}
            onSkip={skipOnboarding}
          />
          {/* Per-view isolation: a crash in one tab renders an inline fallback
              here instead of unmounting the whole app. key={activeTab} resets
              the boundary whenever the user switches views. */}
          <ViewErrorBoundary key={activeTab} viewName={activeTab}>
          {activeTab === APP_TABS.FREEDOM_OS ? (
            // Authenticated sessions render the full-screen deck above; only
            // demo / signed-out sessions reach this in-shell card.
            <FreedomOsSignedOutCard />
          ) : activeTab === APP_TABS.ADMIN_USAGE ? (
            isPlatformAdmin ? (
              <AdminUsagePanel user={freedomOsAuthUser} />
            ) : (
              <ModulePlaceholder
                activeTab={activeTab}
                householdProfilesProps={householdProfilesProps}
              />
            )
          ) : activeTab === APP_TABS.DASHBOARD ? (
            <DashboardView
              activeRange={activeRange}
              setActiveRange={setActiveRange}
              setActiveTab={setActiveTab}
              sessionControls={sessionControls}
              trueCash={trueCash}
              transactions={categorizedTransactions}
              subscriptions={subscriptions}
              incomeStreams={incomeStreams}
              budgetRows={budgetRows}
              dynamicMetrics={dynamicMetrics}
              dynamicAllocations={dynamicAllocations}
              metricSnapshots={trackedMetricSnapshots}
              householdProfilesProps={householdProfilesProps}
              planningAnchor={getPlanningAnchorForYear(currentPlanYear)}
              currentMonthSnapshot={currentMonthSpendSnapshot}
            />
          ) : activeTab === APP_TABS.OPERATIONS_BOARD ? (
            <OperationsBoard
              subscriptions={subscriptions}
              transactions={categorizedTransactions}
              trueCash={trueCash}
              householdProfilesProps={householdProfilesProps}
              currentPlanYear={currentPlanYear}
              availablePlanningYears={availablePlanningYears}
              getBudgetRowsForYear={getBudgetRowsForYear}
              getIncomeStreamsForYear={getIncomeStreamsForYear}
              ensurePlanningYear={ensurePlanningYear}
              plansByYear={plansByYear}
              currentPlanBaseData={baseCurrentPlanData}
              getPlanningAnchorForYear={getPlanningAnchorForYear}
              setPlanningAnchorForYear={setPlanningAnchorForYear}
              isDemoMode={isDemoMode}
            />
          ) : activeTab === APP_TABS.INCOME_HUB ? (
            <IncomeHub
              transactions={categorizedTransactions}
              householdProfilesProps={householdProfilesProps}
              currentPlanYear={currentPlanYear}
              availablePlanningYears={availablePlanningYears}
              getBudgetRowsForYear={getBudgetRowsForYear}
              getIncomeStreamsForYear={getIncomeStreamsForYear}
              setIncomeStreamsForYear={setIncomeStreamsForYear}
              ensurePlanningYear={ensurePlanningYear}
            />
          ) : activeTab === APP_TABS.BUDGET_COMMAND_CENTER ? (
            <BudgetCommandCenter
              transactions={categorizedTransactions}
              budgetRows={budgetRows}
              setBudgetRows={setBudgetRows}
              householdProfilesProps={householdProfilesProps}
              currentPlanYear={currentPlanYear}
              availablePlanningYears={availablePlanningYears}
              getBudgetRowsForYear={getBudgetRowsForYear}
              getIncomeStreamsForYear={getIncomeStreamsForYear}
              setBudgetRowsForYear={setBudgetRowsForYear}
              ensurePlanningYear={ensurePlanningYear}
            />
          ) : activeTab === APP_TABS.ADD_ACCOUNTS ? (
            <AccountsView
              accounts={syncedAccounts}
              reservesAccount={{
                balance: reservesBalance,
                grossCash: liquidCash,
                overcommitted: isReservesOvercommitted,
                funds: reserveReadiness.reserves.map((reserve) => ({
                  id: reserve.id,
                  name: reserve.name,
                  balance: reserve.balance,
                  target: reserve.target,
                  readinessPercent: reserve.readinessPercent,
                  status: reserve.status,
                })),
              }}
              addManualAccount={addManualAccount}
              connectPlaidAccount={connectPlaidAccount}
              repairPlaidItem={repairPlaidItem}
              deleteAccount={deleteAccount}
              openAccountTransactions={openAccountTransactions}
              updateManualAccount={updateManualAccount}
              renameAccount={renameAccount}
              householdProfilesProps={householdProfilesProps}
              plaidIntegration={plaidIntegration}
              subscriptions={subscriptions}
              transactions={categorizedTransactions}
              pendingManualEditAccountId={pendingManualEditAccountId}
              onPendingManualEditAccountConsumed={() => setPendingManualEditAccountId(null)}
            />
          ) : activeTab === APP_TABS.TRANSACTIONS ? (
            <TransactionsView
              accounts={syncedAccounts}
              budgetRows={budgetRows}
              currentMonthSnapshot={currentMonthSpendSnapshot}
              selectedAccount={selectedAccount}
              visibleTransactions={visibleTransactions}
              setActiveTab={setActiveTab}
              setSelectedAccount={setSelectedAccount}
              connectPlaidAccount={connectPlaidAccount}
              addManualTransaction={addManualTransaction}
              deleteManualTransaction={deleteManualTransaction}
              updateManualTransaction={updateManualTransaction}
              updatePlaidTransactionDateNickname={updatePlaidTransactionDateNickname}
              addRecurringSubscriptionFromTransaction={addRecurringSubscriptionFromTransaction}
              updateTransactionCategory={updateTransactionCategory}
              householdProfilesProps={householdProfilesProps}
              plaidIntegration={plaidIntegration}
              deleteAccount={deleteAccount}
              subscriptions={subscriptions}
              transactions={categorizedTransactions}
              onNavigateToEditManualAccount={(accountId) => {
                setPendingManualEditAccountId(accountId);
                setActiveTab(APP_TABS.ADD_ACCOUNTS);
              }}
            />
          ) : activeTab === APP_TABS.FORECAST_LAB ? (
            <ForecastLab
              transactions={categorizedTransactions}
              budgetRows={budgetRows}
              householdProfilesProps={householdProfilesProps}
            />
          ) : activeTab === APP_TABS.RECURRING_SUBSCRIPTIONS ? (
            <RecurringSubscriptions
              accounts={syncedAccounts}
              subscriptions={subscriptions}
              setSubscriptions={setSubscriptions}
              removeSubscription={removeSubscription}
              householdProfilesProps={householdProfilesProps}
            />
          ) : activeTab === APP_TABS.OBJECTIVES ? (
            <ObjectivesBoard
              objectives={objectives}
              setObjectives={setObjectives}
              transactions={categorizedTransactions}
              subscriptions={subscriptions}
              trueCash={trueCash}
              totalNetWorth={totalNetWorth}
              currentMonthSnapshot={currentMonthSpendSnapshot}
              monthlyFlow={monthlyFlow}
              metricSnapshots={trackedMetricSnapshots}
              currentMonthIncome={currentMonthIncome}
              householdProfilesProps={householdProfilesProps}
            />
          ) : (
            <ModulePlaceholder
              activeTab={activeTab}
              householdProfilesProps={householdProfilesProps}
            />
          )}
          </ViewErrorBoundary>
        </main>
      </div>

      <SetupWelcomeModal
        progress={onboardingProgress}
        onStart={startOnboarding}
        onSkip={skipOnboarding}
      />
      <WorkspaceGuideAssistant
        open={isGuideOpen}
        onClose={closeGuide}
        activeTab={activeTab}
        onboardingProgress={onboardingProgress}
        accounts={syncedAccounts}
        incomeStreams={incomeStreams}
        budgetRows={budgetRows}
        transactions={categorizedTransactions}
        plaidIntegration={plaidIntegration}
        onNavigateToTab={(tab) => {
          setActiveTab(tab);
          setIsMobileNavOpen(false);
        }}
      />
      {emailVerificationPromptOpen ? (
        <div
          onClick={(event) => {
            if (event.target === event.currentTarget) closeEmailVerificationPrompt();
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(1,8,18,.78)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            style={{
              width: "min(560px, 100%)",
              borderRadius: 18,
              border: "1px solid rgba(0,174,255,.24)",
              background: "linear-gradient(180deg, rgba(5,19,37,.98), rgba(3,12,24,.98))",
              boxShadow: "0 0 50px rgba(0,136,255,.22)",
              padding: 24,
              display: "grid",
              gap: 16,
            }}
          >
            <div>
              <div
                style={{
                  color: "#8feaff",
                  textTransform: "uppercase",
                  letterSpacing: 1.2,
                  fontSize: 12,
                  fontWeight: 900,
                }}
              >
                Email verification required
              </div>
              <div style={{ color: "white", fontSize: 26, fontWeight: 900, marginTop: 10 }}>
                Verify your email before connecting Plaid
              </div>
              <div style={{ color: "#c6d7ea", lineHeight: 1.7, marginTop: 10 }}>
                For security, bank linking is only available after your email address is verified.
                If you just created your account, check your inbox and spam folder for the
                verification email we sent during sign-up.
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={closeEmailVerificationPrompt}
                style={{
                  background: "rgba(2,16,34,.62)",
                  border: "1px solid rgba(125,220,255,.24)",
                  borderRadius: 10,
                  color: "white",
                  padding: "11px 15px",
                  cursor: "pointer",
                  fontWeight: 800,
                }}
              >
                Close
              </button>
              {typeof sessionControls?.onResendVerification === "function" ? (
                <button
                  type="button"
                  disabled={sessionControls?.isBusy}
                  onClick={() => {
                    void sessionControls.onResendVerification();
                  }}
                  style={{
                    background: "linear-gradient(90deg,#0077ff,#00aaff)",
                    border: "1px solid rgba(125,220,255,.45)",
                    borderRadius: 10,
                    color: "white",
                    padding: "11px 15px",
                    cursor: sessionControls?.isBusy ? "wait" : "pointer",
                    fontWeight: 800,
                  }}
                >
                  {sessionControls?.isBusy ? "Sending..." : "Resend verification email"}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {plaidConsentPrompt ? (
        <div
          onClick={(event) => {
            if (event.target === event.currentTarget) closePlaidConsentPrompt();
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(1,8,18,.78)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            style={{
              width: "min(560px, 100%)",
              borderRadius: 18,
              border: "1px solid rgba(0,174,255,.24)",
              background: "linear-gradient(180deg, rgba(5,19,37,.98), rgba(3,12,24,.98))",
              boxShadow: "0 0 50px rgba(0,136,255,.22)",
              padding: 24,
              display: "grid",
              gap: 16,
            }}
          >
            <div>
              <div
                style={{
                  color: "#8feaff",
                  textTransform: "uppercase",
                  letterSpacing: 1.2,
                  fontSize: 12,
                  fontWeight: 900,
                }}
              >
                Plaid connected-account consent
              </div>
              <div style={{ color: "white", fontSize: 26, fontWeight: 900, marginTop: 10 }}>
                {plaidConsentPrompt.plaidItemId ? "Repair institution access" : "Connect a financial institution"}
              </div>
              <div style={{ color: "#c6d7ea", lineHeight: 1.7, marginTop: 10 }}>
                Forward Freedom uses Plaid Link to access permitted balance, liability, and
                transaction data from your selected institution. Bank-login credentials are handled
                by Plaid, and the app stores server-side access tokens only in encrypted form.
              </div>
            </div>

            <label
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                color: "#dce8f6",
                fontSize: 13,
                lineHeight: 1.6,
              }}
            >
              <input
                type="checkbox"
                checked={hasAcceptedPlaidConsent}
                onChange={(event) => {
                  setHasAcceptedPlaidConsent(event.target.checked);
                  if (plaidConsentError) setPlaidConsentError("");
                }}
                style={{ marginTop: 3 }}
              />
              <span>
                I authorize Plaid and Forward Freedom Financial to access and refresh my permitted
                financial account data for this workspace, and I have reviewed the{" "}
                <button
                  type="button"
                  onClick={() => setActiveLegalDocument("terms")}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#8feaff",
                    cursor: "pointer",
                    padding: 0,
                    fontWeight: 800,
                  }}
                >
                  Terms of Service
                </button>{" "}
                and{" "}
                <button
                  type="button"
                  onClick={() => setActiveLegalDocument("privacy")}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#8feaff",
                    cursor: "pointer",
                    padding: 0,
                    fontWeight: 800,
                  }}
                >
                  Privacy Policy
                </button>
                .
              </span>
            </label>

            {plaidConsentError ? (
              <div
                style={{
                  borderRadius: 12,
                  border: "1px solid rgba(255,93,122,.24)",
                  background: "rgba(255,36,77,.08)",
                  color: "#ffd9df",
                  padding: "12px 14px",
                  lineHeight: 1.5,
                }}
              >
                {plaidConsentError}
              </div>
            ) : null}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                type="button"
                onClick={closePlaidConsentPrompt}
                style={{
                  background: "rgba(2,16,34,.62)",
                  border: "1px solid rgba(125,220,255,.24)",
                  borderRadius: 10,
                  color: "white",
                  padding: "11px 15px",
                  cursor: "pointer",
                  fontWeight: 800,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void confirmPlaidConsent();
                }}
                style={{
                  background: "linear-gradient(90deg,#0077ff,#00aaff)",
                  border: "1px solid rgba(125,220,255,.45)",
                  borderRadius: 10,
                  color: "white",
                  padding: "11px 15px",
                  cursor: "pointer",
                  fontWeight: 800,
                }}
              >
                Continue to Plaid
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <LegalModal
        activeDocument={activeLegalDocument}
        closeDocument={() => setActiveLegalDocument(null)}
      />
    </div>
  );
}

export default ForwardFreedomDashboard;
