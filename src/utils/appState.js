import {
  APP_TAB_VALUES,
  APP_TABS,
  incomeStreamSeed,
  initialAccounts,
  initialBudgetCategories,
  initialSubscriptions,
  mockTransactions,
} from "../data/constants.jsx";
import { normalizeAccount } from "./accounts.js";
import { getCurrentBudgetPeriod } from "./date.js";
import { buildPlanYearData, normalizePlansByYear } from "./planning.js";

export const APP_STATE_STORAGE_KEY = "fff-app-state-v1";
export const LEGACY_METRIC_SNAPSHOT_STORAGE_KEY = "fff-dashboard-metric-snapshots-v1";
const DEFAULT_ACTIVE_RANGE = "ALL";
const LEGACY_APP_TABS = {
  Dashboard: APP_TABS.DASHBOARD,
  "Budget Command Center": APP_TABS.BUDGET_COMMAND_CENTER,
};

function cloneSeed(value) {
  return JSON.parse(JSON.stringify(value));
}

export function buildScopedAppStateStorageKey(scope = "") {
  const normalizedScope = String(scope || "").trim();
  return normalizedScope ? `${APP_STATE_STORAGE_KEY}:${normalizedScope}` : APP_STATE_STORAGE_KEY;
}

function readLegacyMetricSnapshots() {
  if (typeof window === "undefined") return {};

  try {
    const stored = window.localStorage.getItem(LEGACY_METRIC_SNAPSHOT_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function generateUserProfileId(index = 0) {
  return `user-profile-${Date.now()}-${index + 1}`;
}

function calculateSeedTrueCash() {
  if (!initialAccounts.length) return 0;

  const liquidCash = initialAccounts
    .filter((account) => ["Checking", "Savings", "Manual Cash"].includes(account.type))
    .reduce((sum, account) => sum + Number(account.balance || 0), 0);
  const creditCardDebt = Math.abs(
    initialAccounts
      .filter((account) => account.type === "Credit Card")
      .reduce((sum, account) => sum + Number(account.balance || 0), 0)
  );

  return liquidCash - creditCardDebt;
}

function buildUserState({
  id = generateUserProfileId(),
  name = "User 1",
  selectedAccount = null,
  useSeedData = true,
} = {}) {
  const currentYear = getCurrentBudgetPeriod().year;
  const currentPlanData = buildPlanYearData({
    budgetRows: cloneSeed(initialBudgetCategories),
    incomeStreams: useSeedData ? cloneSeed(incomeStreamSeed) : [],
    projectionAdjustments: {},
    startingMonth: getCurrentBudgetPeriod().month,
    startingTrueCash: useSeedData ? calculateSeedTrueCash() : 0,
  });

  return {
    id,
    name,
    selectedAccount,
    accounts: useSeedData
      ? cloneSeed(initialAccounts).map((account, index) => normalizeAccount(account, index))
      : [],
    transactions: useSeedData ? cloneSeed(mockTransactions) : [],
    budgetRows: cloneSeed(currentPlanData.budgetRows),
    incomeStreams: cloneSeed(currentPlanData.incomeStreams),
    projectionAdjustments: cloneSeed(currentPlanData.projectionAdjustments),
    plansByYear: {
      [String(currentYear)]: buildPlanYearData(currentPlanData),
    },
    subscriptions: useSeedData ? cloneSeed(initialSubscriptions) : [],
    plaidItems: [],
    lastPlaidSyncAt: null,
    merchantCategoryRules: {},
    activeTab: APP_TABS.DASHBOARD,
    activeRange: DEFAULT_ACTIVE_RANGE,
    metricSnapshots: {},
  };
}

function normalizeStoredActiveTab(activeTab) {
  if (typeof activeTab !== "string") return null;
  if (APP_TAB_VALUES.includes(activeTab)) return activeTab;
  return LEGACY_APP_TABS[activeTab] || null;
}

function normalizeUserState(rawUser, fallbackName, useSeedData = true) {
  const defaults = buildUserState({
    id: rawUser?.id || generateUserProfileId(),
    name: rawUser?.name || fallbackName,
    useSeedData,
  });

  return {
    ...defaults,
    name:
      typeof rawUser?.name === "string" && rawUser.name.trim() ? rawUser.name.trim() : fallbackName,
    selectedAccount: typeof rawUser?.selectedAccount === "string" ? rawUser.selectedAccount : null,
    accounts: Array.isArray(rawUser?.accounts)
      ? rawUser.accounts.map((account, index) => normalizeAccount(account, index))
      : defaults.accounts,
    transactions: Array.isArray(rawUser?.transactions)
      ? rawUser.transactions
      : defaults.transactions,
    budgetRows: Array.isArray(rawUser?.budgetRows) ? rawUser.budgetRows : defaults.budgetRows,
    incomeStreams: Array.isArray(rawUser?.incomeStreams)
      ? rawUser.incomeStreams
      : defaults.incomeStreams,
    projectionAdjustments:
      rawUser?.projectionAdjustments && typeof rawUser.projectionAdjustments === "object"
        ? rawUser.projectionAdjustments
        : defaults.projectionAdjustments,
    plansByYear: normalizePlansByYear(rawUser?.plansByYear, {
      budgetRows: Array.isArray(rawUser?.budgetRows) ? rawUser.budgetRows : defaults.budgetRows,
      incomeStreams: Array.isArray(rawUser?.incomeStreams)
        ? rawUser.incomeStreams
        : defaults.incomeStreams,
      projectionAdjustments:
        rawUser?.projectionAdjustments && typeof rawUser.projectionAdjustments === "object"
          ? rawUser.projectionAdjustments
          : defaults.projectionAdjustments,
    }),
    subscriptions: Array.isArray(rawUser?.subscriptions)
      ? rawUser.subscriptions
      : defaults.subscriptions,
    plaidItems: Array.isArray(rawUser?.plaidItems) ? rawUser.plaidItems : defaults.plaidItems,
    lastPlaidSyncAt:
      typeof rawUser?.lastPlaidSyncAt === "string"
        ? rawUser.lastPlaidSyncAt
        : defaults.lastPlaidSyncAt,
    merchantCategoryRules:
      rawUser?.merchantCategoryRules && typeof rawUser.merchantCategoryRules === "object"
        ? rawUser.merchantCategoryRules
        : defaults.merchantCategoryRules,
    activeTab: normalizeStoredActiveTab(rawUser?.activeTab) || defaults.activeTab,
    activeRange:
      typeof rawUser?.activeRange === "string" ? rawUser.activeRange : defaults.activeRange,
    metricSnapshots:
      rawUser?.metricSnapshots && typeof rawUser.metricSnapshots === "object"
        ? rawUser.metricSnapshots
        : defaults.metricSnapshots,
  };
}

function buildDefaultAppState() {
  const defaultUser = buildUserState({
    id: "user-profile-1",
    name: "User 1",
    useSeedData: true,
  });

  return {
    users: [defaultUser],
    activeUserId: defaultUser.id,
  };
}

export function createEmptyUserProfile({ name = "User", id } = {}) {
  return buildUserState({
    id: id || generateUserProfileId(),
    name,
    useSeedData: false,
  });
}

export function loadPersistedAppState(storageKey = APP_STATE_STORAGE_KEY) {
  const defaults = buildDefaultAppState();
  if (typeof window === "undefined") return defaults;

  try {
    const stored =
      window.localStorage.getItem(storageKey) ||
      (storageKey !== APP_STATE_STORAGE_KEY ? window.localStorage.getItem(APP_STATE_STORAGE_KEY) : null);
    if (!stored) {
      const defaultUser = {
        ...defaults.users[0],
        metricSnapshots: readLegacyMetricSnapshots(),
      };
      return {
        users: [defaultUser],
        activeUserId: defaultUser.id,
      };
    }

    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed?.users) && parsed.users.length > 0) {
      const users = parsed.users.map((user, index) =>
        normalizeUserState(user, `User ${index + 1}`, true)
      );
      const activeUserId = users.some((user) => user.id === parsed?.activeUserId)
        ? parsed.activeUserId
        : users[0].id;

      return { users, activeUserId };
    }

    const legacyUser = normalizeUserState(
      {
        ...parsed,
        id: "user-profile-1",
        name: "User 1",
        metricSnapshots:
          parsed?.metricSnapshots && typeof parsed.metricSnapshots === "object"
            ? parsed.metricSnapshots
            : readLegacyMetricSnapshots(),
      },
      "User 1",
      true
    );

    return {
      users: [legacyUser],
      activeUserId: legacyUser.id,
    };
  } catch {
    const defaultUser = {
      ...defaults.users[0],
      metricSnapshots: readLegacyMetricSnapshots(),
    };
    return { users: [defaultUser], activeUserId: defaultUser.id };
  }
}

export function persistAppState(state, storageKey = APP_STATE_STORAGE_KEY) {
  if (typeof window === "undefined") return;

  const payload = {
    users: state.users,
    activeUserId: state.activeUserId,
  };

  window.localStorage.setItem(storageKey, JSON.stringify(payload));
}
