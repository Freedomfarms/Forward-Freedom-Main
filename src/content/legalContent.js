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
};
