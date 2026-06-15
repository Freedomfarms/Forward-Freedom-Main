import { APP_TABS } from "../data/constants.jsx";
import { parseMoney } from "./format.js";

export const ONBOARDING_STEP_IDS = {
  ACCOUNTS: "accounts",
  INCOME: "income",
  BUDGET: "budget",
  TRANSACTIONS: "transactions",
};

export const ONBOARDING_STEPS = [
  {
    id: ONBOARDING_STEP_IDS.ACCOUNTS,
    label: "Add accounts",
    tab: APP_TABS.ADD_ACCOUNTS,
    title: "Connect or add your first accounts",
    description:
      "Start with checking, savings, debt, or investments so the workspace has a real financial source of truth.",
    cta: "Open Accounts",
  },
  {
    id: ONBOARDING_STEP_IDS.INCOME,
    label: "Set income",
    tab: APP_TABS.INCOME_HUB,
    title: "Define monthly income streams",
    description:
      "Add recurring income so your month view, cash flow, and planning modules can anchor to expected inflow.",
    cta: "Open Income Hub",
  },
  {
    id: ONBOARDING_STEP_IDS.BUDGET,
    label: "Set budget",
    tab: APP_TABS.BUDGET_COMMAND_CENTER,
    title: "Build the monthly spending plan",
    description:
      "Assign category budgets so spending, remaining cash, and budget pressure become meaningful.",
    cta: "Open Budget Strategy Lab",
  },
  {
    id: ONBOARDING_STEP_IDS.TRANSACTIONS,
    label: "Review transactions",
    tab: APP_TABS.TRANSACTIONS,
    title: "Review and clean up transactions",
    description:
      "Check recent activity, confirm categories, and use the transaction feed as the final quality pass before Command Center.",
    cta: "Open Transactions",
  },
];

function createStepCompletionMap(completedAt = null) {
  return Object.fromEntries(
    ONBOARDING_STEPS.map((step) => [step.id, { completedAt: completedAt || null }])
  );
}

function hasAccounts(user) {
  return Array.isArray(user?.accounts) && user.accounts.length > 0;
}

function hasPlaidItems(user) {
  return Array.isArray(user?.plaidItems) && user.plaidItems.length > 0;
}

function hasIncome(user) {
  return (user?.incomeStreams || []).some((stream) => parseMoney(stream?.amount) > 0);
}

function hasBudget(user) {
  return (user?.budgetRows || []).some((row) => Number(row?.budget) > 0);
}

function hasTransactions(user) {
  return Array.isArray(user?.transactions) && user.transactions.length > 0;
}

export function hasMeaningfulWorkspaceData(user) {
  return hasAccounts(user) || hasPlaidItems(user) || hasIncome(user) || hasTransactions(user);
}

export function createOnboardingState({ completed = false } = {}) {
  const completedAt = completed ? new Date().toISOString() : null;
  return {
    welcomeDismissedAt: completed ? completedAt : null,
    skippedAt: null,
    completedAt,
    steps: createStepCompletionMap(completedAt),
  };
}

export function createCompletedOnboardingState(date = new Date().toISOString()) {
  return {
    welcomeDismissedAt: date,
    skippedAt: null,
    completedAt: date,
    steps: createStepCompletionMap(date),
  };
}

export function normalizeOnboardingState(rawOnboarding, { user = null, useSeedData = false } = {}) {
  const fallback =
    useSeedData || hasMeaningfulWorkspaceData(user)
      ? createCompletedOnboardingState()
      : createOnboardingState();
  const rawSteps =
    rawOnboarding?.steps && typeof rawOnboarding.steps === "object" ? rawOnboarding.steps : {};

  return {
    welcomeDismissedAt:
      typeof rawOnboarding?.welcomeDismissedAt === "string"
        ? rawOnboarding.welcomeDismissedAt
        : fallback.welcomeDismissedAt,
    skippedAt: typeof rawOnboarding?.skippedAt === "string" ? rawOnboarding.skippedAt : null,
    completedAt:
      typeof rawOnboarding?.completedAt === "string"
        ? rawOnboarding.completedAt
        : fallback.completedAt,
    steps: Object.fromEntries(
      ONBOARDING_STEPS.map((step) => [
        step.id,
        {
          completedAt:
            typeof rawSteps?.[step.id]?.completedAt === "string"
              ? rawSteps[step.id].completedAt
              : fallback.steps[step.id].completedAt,
        },
      ])
    ),
  };
}

export function getFirstOnboardingTab() {
  return ONBOARDING_STEPS[0].tab;
}

export function evaluateOnboardingProgress(user, activeTab) {
  const onboarding = normalizeOnboardingState(user?.onboarding, { user, useSeedData: false });
  const steps = ONBOARDING_STEPS.map((step) => {
    const storedCompletedAt = onboarding.steps?.[step.id]?.completedAt || null;
    let derivedComplete = false;

    if (step.id === ONBOARDING_STEP_IDS.ACCOUNTS) {
      derivedComplete = hasAccounts(user) || hasPlaidItems(user);
    } else if (step.id === ONBOARDING_STEP_IDS.INCOME) {
      derivedComplete = hasIncome(user);
    } else if (step.id === ONBOARDING_STEP_IDS.BUDGET) {
      derivedComplete =
        storedCompletedAt !== null ||
        (activeTab === APP_TABS.BUDGET_COMMAND_CENTER &&
          (hasAccounts(user) || hasPlaidItems(user)) &&
          hasIncome(user) &&
          hasBudget(user));
    } else if (step.id === ONBOARDING_STEP_IDS.TRANSACTIONS) {
      derivedComplete =
        storedCompletedAt !== null ||
        (activeTab === APP_TABS.TRANSACTIONS &&
          (hasAccounts(user) || hasPlaidItems(user)) &&
          hasIncome(user) &&
          hasBudget(user));
    }

    return {
      ...step,
      completed: Boolean(storedCompletedAt || derivedComplete),
      completedAt: storedCompletedAt,
      derivedComplete,
      isActiveTab: activeTab === step.tab,
    };
  });

  const completedCount = steps.filter((step) => step.completed).length;
  const currentStep = steps.find((step) => !step.completed) || null;
  const isComplete = completedCount === steps.length;
  const isActive = !onboarding.skippedAt && !isComplete;

  return {
    onboarding,
    steps,
    currentStep,
    completedCount,
    totalSteps: steps.length,
    isComplete,
    isActive,
  };
}
