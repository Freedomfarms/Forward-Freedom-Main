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
    text: `I can help you navigate Forward Freedom, explain what each card, chart, and module means, and walk you through tasks like deleting a transaction. You are currently on ${context.activeTab}. ${nextStep.text}`,
    actions: nextStep.actions,
  };
}

export function buildWorkspaceGuideSuggestions(context) {
  const suggestions = [
    "What should I do next?",
    "What is True Cash?",
    "What does this chart show?",
    "How do I delete a transaction?",
  ];

  if (context.activeTab !== APP_TABS.INCOME_HUB) {
    suggestions.push("Where do I set income?");
  }
  return suggestions.slice(0, 4);
}

function buildChartReply(context) {
  switch (context.activeTab) {
    case APP_TABS.DASHBOARD:
      return {
        text:
          "The True Cash chart on Command Center trends your True Cash (liquid cash minus credit card debt) over time. Use the range buttons (1M, 3M, 6M, YTD, 1Y, ALL) to zoom, and hover any point to read its value and date. The lighter forward section is a projection, not actual history.",
        actions: [buildAction("Open Command Center", APP_TABS.DASHBOARD)],
      };
    case APP_TABS.OPERATIONS_BOARD:
      return {
        text:
          "Operations Board charts: the scorecards compare budget vs. actual spend and planned vs. actual income by month, and the Yearly Outlook lays out monthly income, budget, profit, adjustments, and True Cash (plus projected True Cash) across the whole year.",
        actions: [buildAction("Open Operations Board", APP_TABS.OPERATIONS_BOARD)],
      };
    case APP_TABS.FORECAST_LAB:
      return {
        text:
          "Spending Intelligence charts show each category's monthly spend against its budget, so you can spot trends and see where your money is going.",
        actions: [buildAction("Open Spending Intelligence", APP_TABS.FORECAST_LAB)],
      };
    default:
      return {
        text:
          "Most charts here trend a metric over time. The main ones are the True Cash chart (Command Center), the scorecards and Yearly Outlook (Operations Board), and per-category spend vs. budget (Spending Intelligence). Tell me which screen you're on and I'll explain its chart.",
        actions: [
          buildAction("Open Command Center", APP_TABS.DASHBOARD),
          buildAction("Open Spending Intelligence", APP_TABS.FORECAST_LAB),
        ],
      };
  }
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

  if (includesAny(text, ["true cash"])) {
    return {
      text:
        "True Cash is your real spendable position: Liquid Cash (checking, savings, and manual cash) minus credit card debt. It's the headline card on Command Center, and the True Cash chart trends it over time. Keep your account balances current in Accounts to keep it accurate.",
      actions: [
        buildAction("Open Command Center", APP_TABS.DASHBOARD),
        buildAction("Open Accounts", APP_TABS.ADD_ACCOUNTS),
      ],
    };
  }

  if (includesAny(text, ["liquid cash"])) {
    return {
      text:
        "Liquid Cash is the money you can spend right now — the combined balance of your checking, savings, and manual cash accounts. It does not subtract any debt. You manage the underlying accounts in Accounts.",
      actions: [buildAction("Open Accounts", APP_TABS.ADD_ACCOUNTS)],
    };
  }

  if (includesAny(text, ["credit card debt", "card debt", "card balance"])) {
    return {
      text:
        "Credit Card Debt is the total outstanding balance across all of your connected credit cards. True Cash subtracts this number from your Liquid Cash. Connect or update cards in Accounts.",
      actions: [buildAction("Open Accounts", APP_TABS.ADD_ACCOUNTS)],
    };
  }

  if (includesAny(text, ["cash flow"])) {
    return {
      text:
        "Current Month Cash Flow is this month's planned income minus planned spend. A positive number is a projected surplus; a negative number is a projected deficit. You shape it in Income Hub (income) and Budget Strategy Lab (spending).",
      actions: [
        buildAction("Open Budget Strategy Lab", APP_TABS.BUDGET_COMMAND_CENTER),
        buildAction("Open Income Hub", APP_TABS.INCOME_HUB),
      ],
    };
  }

  if (includesAny(text, ["net worth", "allocation", "asset mix"])) {
    return {
      text:
        "Net worth and allocation views summarize your total assets and how they're split across cash, investments, retirement, and real estate. They're driven by the balances you keep in Accounts.",
      actions: [buildAction("Open Accounts", APP_TABS.ADD_ACCOUNTS)],
    };
  }

  if (
    includesAny(text, ["transaction", "purchase", "charge", "expense"]) &&
    includesAny(text, ["delete", "remove", "erase", "get rid"])
  ) {
    return {
      text:
        "You can delete manual transactions only — bank-synced (Plaid) transactions can't be removed. In Transactions, click the manual transaction (or use its ••• menu → Edit transaction) to open Edit Manual Transaction, click Delete Transaction, then confirm in the dialog.",
      actions: [buildAction("Open Transactions", APP_TABS.TRANSACTIONS)],
    };
  }

  if (
    includesAny(text, ["account"]) &&
    includesAny(text, ["delete", "remove", "disconnect", "unlink"])
  ) {
    return {
      text:
        "To remove an account, open Accounts, select the account, and choose Delete account, then confirm. Removing an account also clears its synced transactions.",
      actions: [buildAction("Open Accounts", APP_TABS.ADD_ACCOUNTS)],
    };
  }

  if (
    includesAny(text, ["categor", "tag", "label"]) &&
    includesAny(text, ["how", "change", "set", "fix", "recategor", "edit", "assign"])
  ) {
    return {
      text:
        "To categorize a transaction, open Transactions and pick a category from the category control on the row (or open the editor). Confirming a category also teaches the workspace that merchant for next time, so similar transactions auto-fill.",
      actions: [buildAction("Open Transactions", APP_TABS.TRANSACTIONS)],
    };
  }

  if (
    includesAny(text, ["add transaction", "manual transaction", "log a", "record a transaction", "enter a transaction", "add a purchase"])
  ) {
    return {
      text:
        "To add a manual transaction, open Transactions and use the manual entry form to set the date, merchant, account, amount, and category.",
      actions: [buildAction("Open Transactions", APP_TABS.TRANSACTIONS)],
    };
  }

  if (includesAny(text, ["chart", "graph", "plot", "this show", "what does this"])) {
    return buildChartReply(context);
  }

  if (
    includesAny(text, ["card", "metric", "tile", "these numbers", "top numbers"]) &&
    !includesAny(text, ["add", "connect", "link"])
  ) {
    return {
      text:
        "The four Command Center cards are: True Cash (Liquid Cash minus credit card debt), Liquid Cash (spendable cash across checking, savings, and manual cash), Credit Card Debt (total balance across connected cards), and Current Month Cash Flow (planned income minus planned spend this month). Ask me about any one for more detail.",
      actions: [buildAction("Open Command Center", APP_TABS.DASHBOARD)],
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
      "I can explain any card or chart (like True Cash or the cash flow chart), walk you through tasks (like deleting a transaction or connecting a bank), or point you to the next setup step. Ask about a card, a chart, a module, or what to do next.",
    actions: [
      buildAction("Open Accounts", APP_TABS.ADD_ACCOUNTS),
      buildAction("Open Transactions", APP_TABS.TRANSACTIONS),
    ],
  };
}
