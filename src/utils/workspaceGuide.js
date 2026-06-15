import { APP_TABS, UNCATEGORIZED_CATEGORY } from "../data/constants.jsx";

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function includesAny(text, fragments) {
  return fragments.some((fragment) => text.includes(fragment));
}

function buildAction(label, tab) {
  return { label, tab };
}

export function buildWorkspaceGuideContext({
  activeTab,
  onboardingProgress,
  accounts = [],
  incomeStreams = [],
  budgetRows = [],
  transactions = [],
  plaidIntegration = null,
}) {
  const uncategorizedTransactions = transactions.filter(
    (transaction) => normalizeText(transaction?.category) === normalizeText(UNCATEGORIZED_CATEGORY)
  ).length;

  return {
    activeTab,
    onboardingProgress,
    accountCount: accounts.length,
    incomeStreamCount: incomeStreams.length,
    budgetedRowCount: budgetRows.filter((row) => Number(row?.budget) > 0).length,
    transactionCount: transactions.length,
    uncategorizedTransactions,
    plaidConnectedItemCount: plaidIntegration?.connectedItemCount || 0,
  };
}

function buildNextStepReply(context) {
  const currentStep = context.onboardingProgress?.currentStep;
  if (!currentStep) {
    return {
      text:
        "Your setup flow is complete. If you want to improve the workspace, review Transactions for cleanup or Command Center for the top-level snapshot.",
      actions: [
        buildAction("Open Transactions", APP_TABS.TRANSACTIONS),
        buildAction("Open Command Center", APP_TABS.DASHBOARD),
      ],
    };
  }

  return {
    text: `Your next best step is ${currentStep.label.toLowerCase()}. ${currentStep.description}`,
    actions: [buildAction(currentStep.cta, currentStep.tab)],
  };
}

export function buildWorkspaceGuideWelcome(context) {
  const nextStep = buildNextStepReply(context);
  return {
    text: `I can help you navigate Forward Freedom, explain features, and point you to the right screen. You are currently on ${context.activeTab}. ${nextStep.text}`,
    actions: nextStep.actions,
  };
}

export function buildWorkspaceGuideSuggestions(context) {
  const suggestions = ["What should I do next?", "How do I connect a bank?", "Why is a transaction uncategorized?"];

  if (context.activeTab !== APP_TABS.INCOME_HUB) {
    suggestions.push("Where do I set income?");
  }
  if (context.activeTab !== APP_TABS.BUDGET_COMMAND_CENTER) {
    suggestions.push("Where do I set the budget?");
  }
  return suggestions.slice(0, 4);
}

export function resolveWorkspaceGuideReply(question, context) {
  const text = normalizeText(question);

  if (!text) {
    return buildWorkspaceGuideWelcome(context);
  }

  if (
    includesAny(text, [
      "what should i invest",
      "best investment",
      "pay off first",
      "debt snowball",
      "debt avalanche",
      "how much should i save",
      "what budget percentage",
      "financial advice",
      "should i invest",
      "should i save",
      "should i pay off",
      "which debt should i pay",
      "what should i buy",
    ])
  ) {
    return {
      text:
        "I can help with product navigation and explain how Forward Freedom works, but I can’t give financial advice or recommend decisions like what to invest in, how much to save, or which debt to pay first. If you want, I can show you the page where you track the numbers involved.",
      actions: [
        buildAction("Open Command Center", APP_TABS.DASHBOARD),
        buildAction("Open Operations Board", APP_TABS.OPERATIONS_BOARD),
      ],
    };
  }

  if (
    includesAny(text, [
      "what next",
      "where should i start",
      "how do i start",
      "where do i begin",
      "start setup",
      "next step",
      "onboarding",
      "tutorial",
    ])
  ) {
    return buildNextStepReply(context);
  }

  if (includesAny(text, ["bank", "plaid", "connect account", "link account", "add account"])) {
    return {
      text:
        "Use Accounts to connect a bank with Plaid or add assets and debts manually. That’s the best first step because the rest of the workspace depends on your account data.",
      actions: [buildAction("Open Accounts", APP_TABS.ADD_ACCOUNTS)],
    };
  }

  if (includesAny(text, ["income", "paycheck", "salary", "deposit", "revenue"])) {
    return {
      text:
        "Income Hub is where you define monthly income streams and compare planned inflow against what has actually arrived.",
      actions: [buildAction("Open Income Hub", APP_TABS.INCOME_HUB)],
    };
  }

  if (includesAny(text, ["budget", "spending plan", "category budget", "overspent"])) {
    return {
      text:
        "Budget Strategy Lab is where you assign monthly budgets, spot overspending, and see projected cash flow by category.",
      actions: [buildAction("Open Budget Strategy Lab", APP_TABS.BUDGET_COMMAND_CENTER)],
    };
  }

  if (
    includesAny(text, [
      "transaction",
      "merchant",
      "uncategorized",
      "category",
      "ai guess",
      "plaid category",
      "user confirmed",
      "manual category",
      "learned merchant",
    ])
  ) {
    const uncategorizedNote =
      context.uncategorizedTransactions > 0
        ? ` Right now you have ${context.uncategorizedTransactions} uncategorized transaction${context.uncategorizedTransactions === 1 ? "" : "s"} to review.`
        : "";
    return {
      text:
        "Transactions is the cleanup feed. That’s where you review merchants, confirm or change categories, and improve what the workspace learns over time." +
        uncategorizedNote,
      actions: [buildAction("Open Transactions", APP_TABS.TRANSACTIONS)],
    };
  }

  if (includesAny(text, ["dashboard", "command center", "overview", "true cash", "summary"])) {
    return {
      text:
        "Command Center is the top-level snapshot once your setup is in place. Use it for the overview after accounts, income, budget, and transactions are in decent shape.",
      actions: [buildAction("Open Command Center", APP_TABS.DASHBOARD)],
    };
  }

  if (includesAny(text, ["forecast", "spending intelligence", "future", "projection"])) {
    return {
      text:
        "Spending Intelligence helps you inspect spending patterns and forward-looking behavior once transactions and budgets are established.",
      actions: [buildAction("Open Spending Intelligence", APP_TABS.FORECAST_LAB)],
    };
  }

  if (includesAny(text, ["operation", "plan", "scenario"])) {
    return {
      text:
        "Operations Board is the planning and scenario space. It’s best used after your core setup data is in place.",
      actions: [buildAction("Open Operations Board", APP_TABS.OPERATIONS_BOARD)],
    };
  }

  if (includesAny(text, ["subscription", "recurring"])) {
    return {
      text:
        "Recurring Subscriptions is where you review and manage repeating bills and subscriptions detected from the transaction stream.",
      actions: [buildAction("Open Recurring Subscriptions", APP_TABS.RECURRING_SUBSCRIPTIONS)],
    };
  }

  if (includesAny(text, ["goal", "objective"])) {
    return {
      text:
        "Objectives is where you track progress targets after your cash flow and account data are reasonably complete.",
      actions: [buildAction("Open Objectives", APP_TABS.OBJECTIVES)],
    };
  }

  return {
    text:
      "I can help you navigate the workspace, explain a module, or point you to the next setup step. Ask about accounts, income, budget, transactions, dashboard, or what to do next.",
    actions: [
      buildAction("Open Accounts", APP_TABS.ADD_ACCOUNTS),
      buildAction("Open Transactions", APP_TABS.TRANSACTIONS),
    ],
  };
}
