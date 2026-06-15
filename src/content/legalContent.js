export const LEGAL_CONTENT = {
  terms: {
    title: "Terms of Service",
    updated: "May 2026",
    sections: [
      {
        heading: "Platform use",
        body: "Forward Freedom Financial provides planning tools, dashboards, and workflow features to help households organize financial information. The platform supports planning and recordkeeping, but it does not replace legal, tax, accounting, or investment advice.",
      },
      {
        heading: "Account responsibility",
        body: "Users are responsible for maintaining accurate information, reviewing synced financial data, and securing access to their device, authentication credentials, and workspace. You agree not to misuse the platform, interfere with service operations, or attempt unauthorized access.",
      },
      {
        heading: "Third-party financial connections",
        body: "Some services depend on third-party providers such as Plaid. By linking an institution, you authorize Forward Freedom Financial and its service providers to access, process, and refresh permitted account and transaction data needed to operate connected-account features.",
      },
      {
        heading: "Service availability",
        body: "Features, integrations, and data providers may change over time. Availability may vary by institution, geography, account type, provider uptime, or regulatory requirements.",
      },
    ],
  },
  privacy: {
    title: "Privacy Policy",
    updated: "May 2026",
    sections: [
      {
        heading: "Information collected",
        body: "The platform stores planning data you enter, such as budgets, income streams, manual transactions, and profile information. If you enable connected accounts, institutions may also provide account, balance, liability, and transaction data through Plaid.",
      },
      {
        heading: "How data is used",
        body: "Your data is used to power dashboards, planning workflows, categorizations, connected-account syncing, forecasting, and budgeting features. User corrections may improve categorization behavior within that same workspace.",
      },
      {
        heading: "Data sharing and storage",
        body: "Forward Freedom Financial limits sharing to what is necessary to operate the service and approved integrations. Bank-login credentials are handled by Plaid Link, and linked-account access tokens are stored only on the server with encryption. The client application does not receive raw access tokens.",
      },
      {
        heading: "Retention and deletion",
        body: "Connected-account metadata and normalized financial records are retained only as needed to operate the service and satisfy user requests. When a linked institution is disconnected, Forward Freedom Financial removes the local Plaid item data and requests item removal from Plaid where supported.",
      },
    ],
  },
  security: {
    eyebrow: "Security",
    title: "Your Financial Security Comes First",
    intro: [
      "Forward Freedom Financial was built to help individuals and families gain clarity, confidence, and control over their finances. Protecting your information is one of our highest priorities.",
      "We understand that connecting financial accounts requires trust. That's why we've designed the platform to minimize data exposure and use secure, industry-standard technologies to protect your information.",
    ],
    sections: [
      {
        heading: "🔒 Secure Bank Connections Powered by Plaid",
        body: "Forward Freedom Financial uses Plaid to securely connect your financial accounts.\n\nPlaid is one of the most trusted financial connectivity platforms in the world and is used by thousands of banks, financial institutions, and financial technology companies.\n\nYour banking credentials are never provided to or stored by Forward Freedom Financial.\n\nWhen connecting an account, your login information is entered through Plaid's secure connection process, not through Forward Freedom Financial.",
      },
      {
        heading: "🏦 How Your Financial Data Is Used",
        body: "To provide budgeting, forecasting, cash flow analysis, financial planning, and account monitoring tools, the platform securely processes information such as:",
        bullets: [
          "Account balances",
          "Transaction history",
          "Account names and account types",
          "Liability information (when available)",
          "Investment information (when available)",
        ],
        footer:
          "This information is used exclusively to generate the dashboards, forecasts, reports, and financial insights available within your account.\n\nForward Freedom Financial does not monitor, review, or analyze individual user transactions for advertising, marketing, or sales purposes.\n\nYour financial information is used to operate the platform and deliver the services you request.",
      },
      {
        heading: "🚫 What Forward Freedom Financial Cannot Do",
        body: "Forward Freedom Financial cannot:",
        bullets: [
          "Move money from your accounts",
          "Transfer funds between accounts",
          "Send payments on your behalf",
          "Change account settings",
          "Modify account ownership",
          "Open or close accounts",
          "View or store your bank username or password",
          "Access your online banking credentials",
        ],
        footer:
          "Connected accounts are used solely to provide budgeting, forecasting, financial planning, and account monitoring tools.\n\nYour connection is read-only and is designed to give you visibility into your finances—not control over your accounts.",
      },
      {
        heading: "🔐 Encryption & Security Controls",
        body: "We use industry-standard security practices designed to protect your information.\n\nSecurity measures include:",
        bullets: [
          "Encrypted data transmission",
          "Secure authentication systems",
          "Protected infrastructure",
          "Access controls",
          "Ongoing monitoring and security improvements",
        ],
        footer:
          "While no online system can guarantee absolute security, we are committed to implementing reasonable safeguards designed to protect user information.",
      },
      {
        heading: "🛡 Privacy Commitment",
        body: "Your financial information belongs to you.\n\nForward Freedom Financial does not sell personal financial information, create advertising profiles, or use your financial data for marketing purposes.\n\nBank connections are powered by Plaid. Your banking credentials are never stored by Forward Freedom Financial, and the platform cannot move money, transfer funds, or initiate transactions on your behalf.\n\nYour financial data is used to operate the platform and deliver the services you request.\n\nWe are committed to protecting your privacy and handling your information responsibly.",
      },
      {
        heading: "👤 Control Over Your Information",
        body: "You remain in control of your connected accounts and information.\n\nYou may:",
        bullets: [
          "Disconnect financial accounts",
          "Remove connected institutions",
          "Delete your account",
          "Stop using account synchronization services",
        ],
        footer: "At any time.",
      },
    ],
  },
};
