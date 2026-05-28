import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { APP_TABS, budgetMonths } from "./data/constants.jsx";
import { styles } from "./styles.js";
import { getBudgetPeriodAtOffset, getCurrentTimestamp } from "./utils/date.js";
import { money, parseMoney } from "./utils/format.js";
import {
  accountSupportsTransactions,
  calculateRealEstateEquity,
  normalizeAccount,
} from "./utils/accounts.js";
import { createManualAccount, updateManualAccountInUser } from "./utils/manualAccounts.js";
import {
  createEmptyUserProfile,
  loadPersistedAppState,
  persistAppState,
} from "./utils/appState.js";
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
  createPlaidLinkToken,
  deletePlaidItem,
  deletePlaidUser,
  exchangePlaidPublicToken,
  getPlaidStatus,
  syncPlaidUser,
} from "./utils/plaid.js";
import { logPlaidClientEvent } from "./utils/plaidLogging.js";
import { buildPlaidNicknameMap, normalizePlaidNicknameMap } from "./utils/plaidNicknames.js";
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
import { BudgetCommandCenter } from "./components/BudgetCommandCenter.jsx";
import { DashboardView } from "./components/DashboardView.jsx";
import { ForecastLab } from "./components/ForecastLab.jsx";
import { IncomeHub } from "./components/IncomeHub.jsx";
import { LandingPage } from "./components/LandingPage.jsx";
import { AppSidebar, ModulePlaceholder } from "./components/Layout.jsx";
import { OperationsBoard } from "./components/OperationsBoard.jsx";
import { RecurringSubscriptions } from "./components/RecurringSubscriptions.jsx";
import { TransactionsView } from "./components/TransactionsView.jsx";
import { LegalModal } from "./components/LegalDocuments.jsx";

function roundCurrency(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function normalizeCryptoPrice(value) {
  return Number((Number(value) || 0).toFixed(8));
}

const LIQUID_ACCOUNT_TYPES = new Set(["Checking", "Savings", "Manual Cash"]);
const CRYPTO_PRICE_SOURCE = "CoinGecko";
const THIRTY_DAY_WINDOW = 30;
const SNAPSHOT_RETENTION_DAYS = 400;
const EMPTY_USER_STATE = Object.freeze({
  id: null,
  name: "",
  selectedAccount: null,
  accounts: [],
  transactions: [],
  budgetRows: [],
  incomeStreams: [],
  projectionAdjustments: {},
  subscriptions: [],
  plaidItems: [],
  plaidNicknames: {},
  lastPlaidSyncAt: null,
  merchantCategoryRules: {},
  activeTab: APP_TABS.DASHBOARD,
  activeRange: "ALL",
  metricSnapshots: {},
});

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
      return (
        key <= thresholdKey &&
        snap &&
        typeof snap.liquidCash === "number" &&
        typeof snap.creditCardDebt === "number"
      );
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
  const previousValue = roundCurrency(
    Number(previousSnapshot.liquidCash) - Number(previousSnapshot.creditCardDebt)
  );
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

function buildTodayMetricSnapshot(liquidCash, creditCardDebt, totalNetWorth) {
  return {
    liquidCash: roundCurrency(liquidCash),
    creditCardDebt: roundCurrency(creditCardDebt),
    totalNetWorth: roundCurrency(totalNetWorth),
  };
}

function ensureTodayMetricSnapshot(metricSnapshots, nextSnapshot) {
  const todayKey = getLocalDateKey();
  const existing = metricSnapshots[todayKey];

  if (
    existing &&
    existing.liquidCash === nextSnapshot.liquidCash &&
    existing.creditCardDebt === nextSnapshot.creditCardDebt &&
    existing.totalNetWorth === nextSnapshot.totalNetWorth
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
  const syncedAccounts = (syncPayload.accounts || []).map((account, index) => {
    const normalizedAccount = normalizeAccount(account, index);
    const existingNickname = existingPlaidNicknamesByKey.get(
      normalizedAccount.plaidAccountId || normalizedAccount.id
    );

    return existingNickname
      ? {
          ...normalizedAccount,
          nickname: existingNickname,
        }
      : normalizedAccount;
  });
  const existingPlaidTransactions = new Map(
    user.transactions
      .filter((transaction) => transaction.source === "plaid")
      .map((transaction) => [transaction.id, transaction])
  );
  const syncedTransactions = (syncPayload.transactions || []).map((transaction) => {
    const existing = existingPlaidTransactions.get(transaction.id);
    if (!existing) return transaction;

    if (existing.categorySource === "user" || existing.categorySource === "manual") {
      return {
        ...transaction,
        category: existing.category,
        categorySource: existing.categorySource,
        categoryConfidence: existing.categoryConfidence,
        needsReview: existing.needsReview,
      };
    }

    return transaction;
  });
  const retainedAccounts = user.accounts.filter((account) => {
    if (account.syncSource === "Plaid" || account.plaidAccountId) return false;
    if (shouldReplaceDemoSyncedData && account.status === "Synced") return false;
    return true;
  });
  const retainedTransactions = user.transactions.filter((transaction) => {
    if (transaction.source === "plaid") return false;
    if (shouldReplaceDemoSyncedData && transaction.source !== "manual") return false;
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
  persistLocally = true,
} = {}) {
  const [initialAppState] = useState(() => initialAppStateOverride || loadPersistedAppState(storageKey));
  const [currentView, setCurrentView] = useState(initialView);
  const [users, setUsers] = useState(initialAppState.users);
  const [activeUserId, setActiveUserId] = useState(initialAppState.activeUserId);
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
  const [activeLegalDocument, setActiveLegalDocument] = useState(null);
  const [plaidError, setPlaidError] = useState("");
  const [isPlaidSyncing, setIsPlaidSyncing] = useState(false);
  const activeUser = users.find((user) => user.id === activeUserId) || users[0] || EMPTY_USER_STATE;
  const accounts = activeUser.accounts;
  const transactions = activeUser.transactions;
  const selectedAccount = activeUser.selectedAccount;
  const budgetRows = activeUser.budgetRows;
  const incomeStreams = activeUser.incomeStreams;
  const projectionAdjustments = activeUser.projectionAdjustments;
  const subscriptions = activeUser.subscriptions;
  const plaidItems = activeUser.plaidItems;
  const lastPlaidSyncAt = activeUser.lastPlaidSyncAt;
  const merchantCategoryRules = activeUser.merchantCategoryRules || {};
  const activeTab = activeUser.activeTab;
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
  const setProjectionAdjustments = (valueOrUpdater) =>
    setActiveUserField("projectionAdjustments", valueOrUpdater);
  const setSubscriptions = (valueOrUpdater) => setActiveUserField("subscriptions", valueOrUpdater);
  const setMerchantCategoryRules = (valueOrUpdater) =>
    setActiveUserField("merchantCategoryRules", valueOrUpdater);
  const setActiveTab = (valueOrUpdater) => setActiveUserField("activeTab", valueOrUpdater);
  const setActiveRange = (valueOrUpdater) => setActiveUserField("activeRange", valueOrUpdater);
  const syncedAccounts = syncDerivedAccountValues(accounts);
  const categorizedTransactions = categorizeTransactions(transactions, {
    budgetRows,
    merchantCategoryRules,
  });

  const liquidCash = syncedAccounts
    .filter((account) => LIQUID_ACCOUNT_TYPES.has(account.type))
    .reduce((sum, account) => sum + account.balance, 0);

  const creditCardDebt = Math.abs(
    syncedAccounts
      .filter((account) => account.type === "Credit Card")
      .reduce((sum, account) => sum + account.balance, 0)
  );

  const trueCash = liquidCash - creditCardDebt;

  const investmentTotal = syncedAccounts
    .filter((account) => account.type === "Investment")
    .reduce((sum, account) => sum + account.balance, 0);

  const cryptoTotal = syncedAccounts
    .filter((account) => account.type === "Crypto")
    .reduce((sum, account) => sum + account.balance, 0);

  const preciousMetalsTotal = syncedAccounts
    .filter((account) => account.type === "Precious Metals")
    .reduce((sum, account) => sum + account.balance, 0);

  const realEstateTotal = syncedAccounts
    .filter((account) => account.type === "Real Estate")
    .reduce((sum, account) => sum + account.balance, 0);

  const retirementTotal = syncedAccounts
    .filter((account) => account.type === "Retirement")
    .reduce((sum, account) => sum + account.balance, 0);

  const currentMonth = currentBudgetPeriod.month;
  const currentMonthSpendSnapshot = buildMonthlySpendSnapshot(categorizedTransactions, budgetRows, {
    month: currentBudgetPeriod.month,
    year: currentBudgetPeriod.year,
  });
  const currentMonthIncome = incomeStreams
    .filter((s) => (s.months || budgetMonths).includes(currentMonth))
    .reduce((sum, s) => sum + parseMoney(s.amount), 0);
  const currentMonthBudget = budgetRows
    .filter((r) => (r.months || budgetMonths).includes(currentMonth))
    .reduce((sum, r) => sum + Number(r.budget || 0), 0);
  const monthlyFlow = currentMonthIncome - currentMonthBudget;
  const currentYearPlanState = activeUser.plansByYear?.[String(currentPlanYear)];
  const baseCurrentPlanData = buildPlanYearData({
    budgetRows: activeUser.budgetRows,
    incomeStreams: activeUser.incomeStreams,
    projectionAdjustments: activeUser.projectionAdjustments,
    startingMonth: currentMonth,
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

  const totalNetWorth = Math.max(
    trueCash +
      investmentTotal +
      cryptoTotal +
      preciousMetalsTotal +
      realEstateTotal +
      retirementTotal,
    1
  );
  const pct = (v) => `${((v / totalNetWorth) * 100).toFixed(1)}%`;
  const trackedMetricSnapshots = ensureTodayMetricSnapshot(
    metricSnapshots,
    buildTodayMetricSnapshot(liquidCash, creditCardDebt, totalNetWorth)
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
  const getProjectionAdjustmentsForYear = (targetYear) =>
    targetYear === currentPlanYear
      ? projectionAdjustments
      : ensurePlanYearData(plansByYear, targetYear, baseCurrentPlanData)[String(targetYear)]
          ?.projectionAdjustments || {};
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
  const setProjectionAdjustmentsForYear = (targetYear, valueOrUpdater) => {
    if (targetYear === currentPlanYear) {
      setProjectionAdjustments(valueOrUpdater);
      return;
    }

    setActiveUserField("plansByYear", (currentPlansByYear) => {
      const nextPlansByYear = ensurePlanYearData(
        currentPlansByYear,
        targetYear,
        baseCurrentPlanData
      );
      const yearKey = String(targetYear);
      const currentValue = nextPlansByYear[yearKey]?.projectionAdjustments || {};
      const nextValue =
        typeof valueOrUpdater === "function" ? valueOrUpdater(currentValue) : valueOrUpdater;

      return {
        ...nextPlansByYear,
        [yearKey]: {
          ...nextPlansByYear[yearKey],
          projectionAdjustments: nextValue,
        },
      };
    });
  };
  const setPlanningAnchorForYear = (targetYear, nextAnchor) => {
    const liveStartingMonth = getBudgetPeriodAtOffset(0).month;
    setActiveUserField("plansByYear", (currentPlansByYear) => {
      const nextPlansByYear = ensurePlanYearData(
        currentPlansByYear,
        targetYear,
        baseCurrentPlanData
      );
      const yearKey = String(targetYear);
      const currentPlan = nextPlansByYear[yearKey] || buildPlanYearData(baseCurrentPlanData);

      return {
        ...nextPlansByYear,
        [yearKey]: {
          ...currentPlan,
          ...nextAnchor,
          startingMonth: liveStartingMonth,
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
          plansByYear: {
            ...plansByYear,
            [String(currentPlanYear)]: buildPlanYearData({
              budgetRows,
              incomeStreams,
              projectionAdjustments,
              startingMonth: baseCurrentPlanData.startingMonth,
              startingTrueCash: baseCurrentPlanData.startingTrueCash,
            }),
          },
          metricSnapshots: trackedMetricSnapshots,
        }
      : {
          ...user,
          name: getDisplayUserName(user, index),
        }
  );

  const dynamicAllocations = [
    {
      name: "True Cash",
      amount: money(trueCash),
      percent: pct(trueCash),
      color: "#8b34ff",
      valueNumber: trueCash,
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
      persistAppState(nextPersistedState, storageKey);
    }
    if (typeof onPersistedStateChange === "function") {
      onPersistedStateChange(nextPersistedState);
    }
  }, [activeUser?.id, onPersistedStateChange, persistLocally, persistedUsers, storageKey]);

  useEffect(() => {
    let cancelled = false;

    getPlaidStatus()
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
  }, []);

  const applyPlaidSyncPayload = (userId, syncPayload) => {
    setUsers((currentUsers) =>
      currentUsers.map((user) =>
        user.id === userId ? mergePlaidSyncIntoUser(user, syncPayload) : user
      )
    );
  };

  const syncLinkedPlaidAccounts = useCallback(
    async (userId = activeUser.id, { silent = false } = {}) => {
      if (!userId || !plaidStatus.configured) return null;

      if (!silent) setPlaidError("");
      setIsPlaidSyncing(true);

      try {
        const payload = await syncPlaidUser(userId);
        applyPlaidSyncPayload(userId, payload);
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
    [activeUser.id, plaidStatus.configured]
  );

  useEffect(() => {
    if (!plaidStatus.configured || !activeUser?.id || plaidItems.length === 0) return;

    const timeoutId = window.setTimeout(() => {
      syncLinkedPlaidAccounts(activeUser.id, { silent: true });
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeUser?.id, plaidItems.length, plaidStatus.configured, syncLinkedPlaidAccounts]);

  useEffect(() => {
    if (!plaidStatus.configured || !activeUser?.id || plaidItems.length === 0) return;

    const intervalId = window.setInterval(
      () => {
        void syncLinkedPlaidAccounts(activeUser.id, { silent: true });
      },
      30 * 60 * 1000
    );

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeUser?.id, plaidItems.length, plaidStatus.configured, syncLinkedPlaidAccounts]);

  const resetPlaidLinkState = () => {
    setPlaidShouldOpen(false);
    setPlaidLinkToken(null);
    setPlaidTargetUserId(null);
    setPlaidTargetItemId(null);
  };

  const closePlaidConsentPrompt = () => {
    setPlaidConsentPrompt(null);
    setHasAcceptedPlaidConsent(false);
    setPlaidConsentError("");
  };

  const { open: openPlaidLink, ready: isPlaidReady } = usePlaidLink({
    token: plaidLinkToken,
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
        const payload = await exchangePlaidPublicToken({
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
        });
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
      icon: "▧",
      title: "TRUE CASH",
      value: money(trueCash),
      ...buildTrackedTrueCashMeta(trackedMetricSnapshots, trueCash, true),
      onClick: () => setActiveTab(APP_TABS.ADD_ACCOUNTS),
    },
    {
      icon: "▱",
      title: "LIQUID CASH",
      value: money(liquidCash),
      ...buildTrackedMetricMeta(trackedMetricSnapshots, "liquidCash", liquidCash, true),
      onClick: () => setActiveTab(APP_TABS.ADD_ACCOUNTS),
    },
    {
      icon: "▭",
      title: "CREDIT CARD DEBT",
      value: money(creditCardDebt),
      ...buildTrackedMetricMeta(trackedMetricSnapshots, "creditCardDebt", creditCardDebt, false),
      onClick: () => setActiveTab(APP_TABS.ADD_ACCOUNTS),
    },
    {
      icon: "⌁",
      title: "CURRENT MONTH CASH FLOW",
      value: money(monthlyFlow),
      change: monthlyFlow >= 0 ? "Projected surplus" : "Projected deficit",
      changeColor: monthlyFlow >= 0 ? "#00f59b" : "#ff355d",
      changeIcon: monthlyFlow >= 0 ? "↑" : "↓",
      subLabel: `${currentMonth} plan`,
      onClick: () => setActiveTab(APP_TABS.BUDGET_COMMAND_CENTER),
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
        if (cancelled || Object.keys(quotes).length === 0) return;

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
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [accounts, activeUser.id]);

  useEffect(() => {
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
        if (cancelled || Object.keys(quotes).length === 0) return;

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
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [accounts, activeUser.id]);

  const startPlaidLinkFlow = async ({ plaidItemId = null } = {}) => {
    if (!activeUser?.id) return;

    if (!plaidStatus.configured) {
      setPlaidError(
        "Plaid is not configured yet. Add PLAID_CLIENT_ID and PLAID_SECRET to enable live account linking."
      );
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
      const { linkToken } = await createPlaidLinkToken({
        workspaceUserId: activeUser.id,
        userName: getDisplayUserName(
          activeUser,
          users.findIndex((user) => user.id === activeUser.id)
        ),
        plaidItemId,
      });
      setPlaidLinkToken(linkToken);
      setPlaidTargetUserId(activeUser.id);
      setPlaidTargetItemId(plaidItemId);
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
    setPlaidConsentPrompt({ plaidItemId });
    setHasAcceptedPlaidConsent(false);
    setPlaidConsentError("");
    setPlaidError("");
  };

  const connectPlaidAccount = () => {
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
    if (!accountSupportsTransactions(targetAccount)) return false;

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
        account.name === transactionToDelete.account
          ? {
              ...account,
              balance: roundCurrency(account.balance - transactionToDelete.amount),
            }
          : account
      )
    );
  };

  const updateTransactionCategory = (transactionToUpdate, nextCategory) => {
    if (!transactionToUpdate) return;

    setMerchantCategoryRules((current) =>
      buildMerchantCategoryRules(current, transactionToUpdate.merchant, nextCategory)
    );

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
      await deletePlaidUser(userId);
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
      await deletePlaidItem({
        itemId: accountToDelete.plaidItemId,
        workspaceUserId: activeUser.id,
      });
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

  if (currentView === "landing") {
    return <LandingPage enterApp={handleEnterApp} />;
  }

  return (
    <div style={styles.page}>
      <div style={styles.shell}>
        <AppSidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onBackHome={() => setCurrentView("landing")}
          sessionControls={sessionControls}
        />

        <main style={styles.main}>
          {activeTab === APP_TABS.DASHBOARD ? (
            <DashboardView
              activeRange={activeRange}
              setActiveRange={setActiveRange}
              setActiveTab={setActiveTab}
              trueCash={trueCash}
              transactions={categorizedTransactions}
              subscriptions={subscriptions}
              incomeStreams={incomeStreams}
              budgetRows={budgetRows}
              projectionAdjustments={projectionAdjustments}
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
              getProjectionAdjustmentsForYear={getProjectionAdjustmentsForYear}
              setProjectionAdjustmentsForYear={setProjectionAdjustmentsForYear}
              ensurePlanningYear={ensurePlanningYear}
              plansByYear={plansByYear}
              currentPlanBaseData={baseCurrentPlanData}
              getPlanningAnchorForYear={getPlanningAnchorForYear}
              setPlanningAnchorForYear={setPlanningAnchorForYear}
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
              householdProfilesProps={householdProfilesProps}
            />
          ) : (
            <ModulePlaceholder
              activeTab={activeTab}
              householdProfilesProps={householdProfilesProps}
            />
          )}
        </main>
      </div>

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
