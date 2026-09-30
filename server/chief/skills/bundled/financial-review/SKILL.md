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
4. Produce findings grounded only in the two results: connection attention counts, category movement, plan labels, and stored metric fields.

Validation: every finding cites which result it came from. Do not invent merchants, account names, institution names, budget dollar amounts, or income dollar amounts. Those fields are not in the tool results.

Approval: both tools are reads. Do not claim an account, plan, or payment was changed.

This procedure does not grant finance:read. If a tool is denied, say so.
