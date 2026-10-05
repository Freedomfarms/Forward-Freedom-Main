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
3. If a call fails, or position or activity is unavailable, report that part. Use whichever side is available. Do not fill the gap from memory or from an earlier session.
4. Produce findings grounded only in the results. finance_summary.position is the current position: accounts, holdings, loans, liquidCash, trueCash, creditCardDebt, totalDebt, netWorth, and allocation. finance_summary.activity is six-month category movement. workspace_plan_summary is labels, counts, and stored metric fields. Investment accounts do not include security-level holdings.

Validation: every finding cites which result it came from. Do not invent merchants, institution names, credentials, security lots, or figures that are absent from the results. Use budget and income dollar amounts only when finance_summary.position includes them.

Approval: both tools are reads. Do not claim an account, plan, or payment was changed.

This procedure does not grant finance:read. If a tool is denied, say so.
