import {
  APP_TAB_VALUES,
  APP_TABS,
  incomeStreamSeed,
  initialBudgetCategories,
  initialSubscriptions,
} from "../data/constants.jsx";
import { normalizeAccount } from "./accounts.js";
import { getCurrentBudgetPeriod } from "./date.js";
import {
  createOnboardingState,
  getFirstOnboardingTab,
  normalizeOnboardingState,
} from "./onboarding.js";
import { buildPlanYearData, normalizePlansByYear } from "./planning.js";
import { buildSeedObjectives, normalizeObjectives } from "./objectives.js";
import { normalizeRecurringPreferences } from "./recurringSuggestions.js";
import {
  HOUSEHOLD_DEMO_PLAN_ANCHOR,
  buildHouseholdDemoDataset,
} from "../data/householdDemoSeed.js";

export const APP_STATE_STORAGE_KEY = "fff-app-state-v1";
export const LEGACY_METRIC_SNAPSHOT_STORAGE_KEY = "fff-dashboard-metric-snapshots-v1";
const APP_STATE_STORAGE_RECORD_KIND = "forward-freedom-app-state";
const APP_STATE_STORAGE_RECORD_VERSION = 2;
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

function buildUserState({
  id = generateUserProfileId(),
  name = "User 1",
  selectedAccount = null,
  useSeedData = true,
} = {}) {
  const currentYear = getCurrentBudgetPeriod().year;
  const demoDataset = useSeedData ? buildHouseholdDemoDataset(currentYear) : null;
  const currentPlanData = buildPlanYearData({
    budgetRows: cloneSeed(initialBudgetCategories),
    incomeStreams: useSeedData ? cloneSeed(incomeStreamSeed) : [],
    startingMonth: useSeedData
      ? HOUSEHOLD_DEMO_PLAN_ANCHOR.startingMonth
      : getCurrentBudgetPeriod().month,
    startingTrueCash: useSeedData
      ? HOUSEHOLD_DEMO_PLAN_ANCHOR.startingTrueCash
      : 0,
  });

  return {
    id,
    name,
    createdAt: useSeedData
      ? `${currentYear}-01-01T12:00:00.000Z`
      : new Date().toISOString(),
    selectedAccount,
    accounts: useSeedData
      ? cloneSeed(demoDataset.accounts).map((account, index) => normalizeAccount(account, index))
      : [],
    transactions: useSeedData ? cloneSeed(demoDataset.transactions) : [],
    budgetRows: cloneSeed(currentPlanData.budgetRows),
    incomeStreams: cloneSeed(currentPlanData.incomeStreams),
    objectives: buildSeedObjectives(),
    plansByYear: {
      [String(currentYear)]: buildPlanYearData(currentPlanData),
    },
    subscriptions: useSeedData ? cloneSeed(initialSubscriptions) : [],
    recurringPreferences: normalizeRecurringPreferences(null),
    plaidItems: [],
    plaidNicknames: {},
    plaidTransactionOverrides: {},
    lastPlaidSyncAt: null,
    merchantCategoryRules: {},
    onboarding: createOnboardingState({ completed: useSeedData }),
    activeTab: useSeedData ? APP_TABS.DASHBOARD : getFirstOnboardingTab(),
    activeRange: DEFAULT_ACTIVE_RANGE,
    metricSnapshots: useSeedData ? demoDataset.metricSnapshots : {},
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
    createdAt:
      typeof rawUser?.createdAt === "string" && !Number.isNaN(new Date(rawUser.createdAt).getTime())
        ? rawUser.createdAt
        : defaults.createdAt,
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
    objectives: normalizeObjectives(rawUser?.objectives, defaults.objectives),
    plansByYear: normalizePlansByYear(rawUser?.plansByYear, {
      budgetRows: Array.isArray(rawUser?.budgetRows) ? rawUser.budgetRows : defaults.budgetRows,
      incomeStreams: Array.isArray(rawUser?.incomeStreams)
        ? rawUser.incomeStreams
        : defaults.incomeStreams,
    }),
    subscriptions: Array.isArray(rawUser?.subscriptions)
      ? rawUser.subscriptions
      : defaults.subscriptions,
    recurringPreferences: normalizeRecurringPreferences(rawUser?.recurringPreferences),
    plaidItems: Array.isArray(rawUser?.plaidItems) ? rawUser.plaidItems : defaults.plaidItems,
    plaidNicknames:
      rawUser?.plaidNicknames && typeof rawUser.plaidNicknames === "object"
        ? rawUser.plaidNicknames
        : defaults.plaidNicknames,
    plaidTransactionOverrides:
      rawUser?.plaidTransactionOverrides && typeof rawUser.plaidTransactionOverrides === "object"
        ? rawUser.plaidTransactionOverrides
        : defaults.plaidTransactionOverrides,
    lastPlaidSyncAt:
      typeof rawUser?.lastPlaidSyncAt === "string"
        ? rawUser.lastPlaidSyncAt
        : defaults.lastPlaidSyncAt,
    merchantCategoryRules:
      rawUser?.merchantCategoryRules && typeof rawUser.merchantCategoryRules === "object"
        ? rawUser.merchantCategoryRules
        : defaults.merchantCategoryRules,
    onboarding: normalizeOnboardingState(rawUser?.onboarding, {
      user: {
        ...defaults,
        ...rawUser,
      },
      useSeedData,
    }),
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

export function createEmptyAppState({ primaryUserName = "User 1" } = {}) {
  const defaultUser = buildUserState({
    id: "user-profile-1",
    name: primaryUserName,
    useSeedData: false,
  });

  return {
    users: [defaultUser],
    activeUserId: defaultUser.id,
  };
}

export function createDemoAppState() {
  const demoUser = buildUserState({
    id: "demo-user-profile",
    name: "Demo Household",
    useSeedData: true,
  });

  return {
    users: [demoUser],
    activeUserId: demoUser.id,
  };
}

function buildDefaultAppStateRecord(defaults, { includeLegacyMetricSnapshots = true } = {}) {
  const defaultUser = {
    ...defaults.users[0],
    metricSnapshots: includeLegacyMetricSnapshots
      ? readLegacyMetricSnapshots()
      : defaults.users[0].metricSnapshots,
  };

  return {
    state: {
      users: [defaultUser],
      activeUserId: defaultUser.id,
    },
    hasPersistedState: false,
    persistedAt: null,
    mode: "default",
  };
}

function normalizePersistedAppState(
  rawState,
  { includeLegacyMetricSnapshots = true, useSeedData = true } = {}
) {
  if (Array.isArray(rawState?.users) && rawState.users.length > 0) {
    const users = rawState.users.map((user, index) =>
      normalizeUserState(user, `User ${index + 1}`, useSeedData)
    );
    const activeUserId = users.some((user) => user.id === rawState?.activeUserId)
      ? rawState.activeUserId
      : users[0].id;

    return { users, activeUserId };
  }

  const legacyUser = normalizeUserState(
    {
      ...rawState,
      id: "user-profile-1",
      name: "User 1",
      metricSnapshots:
        rawState?.metricSnapshots && typeof rawState.metricSnapshots === "object"
          ? rawState.metricSnapshots
          : includeLegacyMetricSnapshots
            ? readLegacyMetricSnapshots()
            : {},
    },
    "User 1",
    useSeedData
  );

  return {
    users: [legacyUser],
    activeUserId: legacyUser.id,
  };
}

function unwrapPersistedAppState(parsed) {
  if (
    parsed?.kind === APP_STATE_STORAGE_RECORD_KIND &&
    parsed?.version === APP_STATE_STORAGE_RECORD_VERSION &&
    parsed?.state &&
    typeof parsed.state === "object"
  ) {
    return {
      rawState: parsed.state,
      persistedAt: typeof parsed.persistedAt === "string" ? parsed.persistedAt : null,
      mode: typeof parsed.mode === "string" ? parsed.mode : "cache",
    };
  }

  return {
    rawState: parsed,
    persistedAt: null,
    mode: "legacy",
  };
}

export function createEmptyUserProfile({ name = "User", id } = {}) {
  return buildUserState({
    id: id || generateUserProfileId(),
    name,
    useSeedData: false,
  });
}

export function loadPersistedAppStateRecord(storageKey = APP_STATE_STORAGE_KEY, options = {}) {
  const {
    fallbackToDefaultStorageKey = true,
    includeLegacyMetricSnapshots = true,
    useSeedData = true,
  } = options;
  const defaults = useSeedData ? buildDefaultAppState() : createEmptyAppState();
  if (typeof window === "undefined") {
    return {
      state: defaults,
      hasPersistedState: false,
      persistedAt: null,
      mode: "ssr",
    };
  }

  try {
    const stored =
      window.localStorage.getItem(storageKey) ||
      (fallbackToDefaultStorageKey && storageKey !== APP_STATE_STORAGE_KEY
        ? window.localStorage.getItem(APP_STATE_STORAGE_KEY)
        : null);
    if (!stored) {
      return buildDefaultAppStateRecord(defaults, { includeLegacyMetricSnapshots });
    }

    const parsed = JSON.parse(stored);
    const unwrapped = unwrapPersistedAppState(parsed);

    return {
      state: normalizePersistedAppState(unwrapped.rawState, {
        includeLegacyMetricSnapshots,
        useSeedData,
      }),
      hasPersistedState: true,
      persistedAt: unwrapped.persistedAt,
      mode: unwrapped.mode,
    };
  } catch {
    return buildDefaultAppStateRecord(defaults, { includeLegacyMetricSnapshots });
  }
}

export function loadPersistedAppState(storageKey = APP_STATE_STORAGE_KEY) {
  return loadPersistedAppStateRecord(storageKey).state;
}

export function clearPersistedAppState(storageKey = APP_STATE_STORAGE_KEY) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(storageKey);
    window.localStorage.removeItem(LEGACY_METRIC_SNAPSHOT_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (e.g. blocked third-party storage); there is
    // nothing to clear in that case.
  }
}

export function persistAppState(state, storageKey = APP_STATE_STORAGE_KEY, options = {}) {
  if (typeof window === "undefined") return;

  const payload = {
    kind: APP_STATE_STORAGE_RECORD_KIND,
    version: APP_STATE_STORAGE_RECORD_VERSION,
    mode: typeof options.mode === "string" ? options.mode : "local",
    cacheState: typeof options.cacheState === "string" ? options.cacheState : null,
    persistedAt:
      typeof options.persistedAt === "string" ? options.persistedAt : new Date().toISOString(),
    state: {
      users: state.users,
      activeUserId: state.activeUserId,
    },
  };

  window.localStorage.setItem(storageKey, JSON.stringify(payload));
}
