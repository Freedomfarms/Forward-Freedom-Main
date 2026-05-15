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

export const APP_STATE_STORAGE_KEY = "fff-app-state-v1";
export const LEGACY_METRIC_SNAPSHOT_STORAGE_KEY = "fff-dashboard-metric-snapshots-v1";
const DEFAULT_ACTIVE_RANGE = "ALL";

function cloneSeed(value) {
  return JSON.parse(JSON.stringify(value));
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

function buildUserState({
  id = generateUserProfileId(),
  name = "User 1",
  selectedAccount = null,
  useSeedData = true,
} = {}) {
  return {
    id,
    name,
    selectedAccount,
    accounts: useSeedData
      ? cloneSeed(initialAccounts).map((account, index) => normalizeAccount(account, index))
      : [],
    transactions: useSeedData ? cloneSeed(mockTransactions) : [],
    budgetRows: cloneSeed(initialBudgetCategories),
    incomeStreams: useSeedData ? cloneSeed(incomeStreamSeed) : [],
    projectionAdjustments: {},
    subscriptions: useSeedData ? cloneSeed(initialSubscriptions) : [],
    plaidItems: [],
    lastPlaidSyncAt: null,
    merchantCategoryRules: {},
    activeTab: APP_TABS.DASHBOARD,
    activeRange: DEFAULT_ACTIVE_RANGE,
    metricSnapshots: {},
  };
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
    activeTab:
      typeof rawUser?.activeTab === "string" && APP_TAB_VALUES.includes(rawUser.activeTab)
        ? rawUser.activeTab
        : defaults.activeTab,
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

export function loadPersistedAppState() {
  const defaults = buildDefaultAppState();
  if (typeof window === "undefined") return defaults;

  try {
    const stored = window.localStorage.getItem(APP_STATE_STORAGE_KEY);
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

export function persistAppState(state) {
  if (typeof window === "undefined") return;

  const payload = {
    users: state.users,
    activeUserId: state.activeUserId,
  };

  window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(payload));
}
