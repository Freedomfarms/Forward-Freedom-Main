---
name: financial-review
description: Review this user's finances and report what needs attention. Use when they ask for a financial review or what needs their attention.
requires_tools:
  - finance_summary
  - workspace_plan_summary
required_capabilities:
  - finance:read
---

Use this procedure when the user asks to review their finances or what needs attention.

Required inputs are the current user. Neither tool takes arguments.

Sequence:

1. Call finance_summary.
2. Call workspace_plan_summary.
3. If either call fails, report that failure. Do not fill the gap from memory or from an earlier session.
4. Produce findings grounded only in the two results. finance_summary.dashboard is the Freedom Financial position: spendable trueCash, liquid cash, credit card debt, reserves, gross True Cash, net worth, allocation, current-month budget and category spend, and the yearly outlook. The rest of finance_summary is six-month category movement and connection counts. workspace_plan_summary is labels, counts, and stored metric fields.

Validation: every finding cites which result it came from. Do not invent merchants, account names, institution names, credentials, or figures that are absent from the results. Use budget and income dollar amounts only when finance_summary.dashboard includes them.

Approval: both tools are reads. Do not claim an account, plan, or payment was changed.

This procedure does not grant finance:read. If a tool is denied, say so.
