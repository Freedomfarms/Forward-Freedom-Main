import { Resend } from "resend";
import { getFirebaseAdminAuth, isFirebaseAdminConfigured } from "../auth/firebaseAdmin.js";
import { withUserContext } from "../db/prisma.js";
import { decrypt, encrypt } from "../security/envelope.js";
import { AgentError } from "./errors.js";
import { resolveConversationForWrite, touchConversation } from "./conversations.js";
import { applySnippetTitleIfNeeded } from "./conversationTitle.js";
import {
  buildEmailHtml,
  formatRunDate,
  markdownToPlainText,
  renderInlineMarkdownToEmailHtml,
  renderMarkdownToEmailHtml,
} from "./emailTemplate.js";
import { AGENT_REQUEST_KINDS, classifyAgentRequest } from "./executionContract.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared email delivery for sub-agent reports (finance, research, reminders).
//
// Safety contract:
//   • The recipient is ALWAYS the account's own email address, looked up
//     server-side from Firebase — there is no parameter through which any
//     other destination can be supplied.
//   • Nothing is ever sent unless that address is VERIFIED (fail closed:
//     if verification cannot be confirmed, no email goes out).
//   • Email delivery is best-effort — a failed send never fails a run.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_FROM =
  process.env.RESEND_FROM_EMAIL || "Freedom OS <notifications@forwardfreedomfinancial.com>";

/** Agent types whose run output may be emailed to the user. */
export const EMAIL_CAPABLE_AGENT_TYPES = Object.freeze(["finance", "research", "reminders"]);

export function isEmailCapableAgentType(agentType) {
  return EMAIL_CAPABLE_AGENT_TYPES.includes(agentType);
}

export function isEmailDeliveryEnabled(toolAccess) {
  if (Array.isArray(toolAccess)) return toolAccess.includes("email");
  if (toolAccess && typeof toolAccess === "object") return toolAccess.email === true;
  return false;
}

/**
 * Looks up the account's email address and its verified status from Firebase.
 * Fail closed: any lookup problem reports the address as not verified.
 */
export async function getVerifiedAccountEmail(userId) {
  if (!isFirebaseAdminConfigured()) {
    return { email: null, verified: false, reason: "the auth service is not configured" };
  }
  const adminAuth = getFirebaseAdminAuth();
  if (!adminAuth) {
    return { email: null, verified: false, reason: "the auth service is unavailable" };
  }
  try {
    const record = await adminAuth.getUser(userId);
    if (!record?.email) {
      return { email: null, verified: false, reason: "no email address is on the account" };
    }
    if (!record.emailVerified) {
      return { email: record.email, verified: false, reason: "account_email_unverified" };
    }
    return { email: record.email, verified: true, reason: null };
  } catch {
    return { email: null, verified: false, reason: "the account email could not be looked up" };
  }
}

/** Masks an address for user-facing status (never show the full mailbox in UI). */
export function maskEmailAddress(email) {
  const value = String(email || "").trim();
  const at = value.indexOf("@");
  if (at < 1) return "your account email";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}

function describeUnverifiedStatus(email, reason) {
  if (reason === "account_email_unverified") {
    const masked = maskEmailAddress(email);
    return (
      `verify your account email first (${masked}). ` +
      "Agents can only email your verified account address — never the site address or anyone else"
    );
  }
  if (reason === "no email address is on the account") {
    return (
      "add and verify an email on your account first. " +
      "Agents can only email your verified account address — never the site address or anyone else"
    );
  }
  return (
    `${reason}. Agents can only email your verified account address — never the site address or anyone else`
  );
}

/**
 * Resend's "domain is not verified" means the FROM / sending domain is not set
 * up — not that we tried to email the site address as the recipient.
 */
export function describeEmailDeliveryFailure(errorMessage, recipientEmail) {
  const msg = String(errorMessage || "unknown error");
  const masked = maskEmailAddress(recipientEmail);
  if (/domain is not verified|verify your domain|resend\.com\/domains/i.test(msg)) {
    return (
      `could not send to ${masked}: Freedom OS's sending domain is not verified in Resend yet ` +
      `(server setup — the recipient is still your account email, not the site address)`
    );
  }
  return `email delivery failed to ${masked} (${msg})`;
}

async function deliverToAddress({ email, subject, body, html }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: EMAIL_FROM,
    to: [email],
    subject,
    text: body,
    ...(html ? { html } : {}),
  });
  if (error) {
    throw new Error(error.message || "Email delivery failed.");
  }
}

/**
 * Sends an agent report/summary to the user's own VERIFIED account email.
 * Never throws — returns { sent, status } so callers can record the outcome
 * without ever failing the run that produced the report.
 */
export async function sendAgentReportEmail({ userId, subject, body, html = null }) {
  if (!process.env.RESEND_API_KEY) {
    return { sent: false, status: "email skipped (email service is not configured)" };
  }
  const { email, verified, reason } = await getVerifiedAccountEmail(userId);
  if (!verified) {
    return { sent: false, status: `email skipped (${describeUnverifiedStatus(email, reason)})` };
  }
  try {
    await deliverToAddress({ email, subject, body, html });
    return {
      sent: true,
      status: `email sent to your verified account address (${maskEmailAddress(email)})`,
    };
  } catch (error) {
    return {
      sent: false,
      status: describeEmailDeliveryFailure(error?.message, email),
    };
  }
}

/**
 * Like sendAgentReportEmail but throws typed AgentErrors for API endpoints
 * (the "Email me this run" button) where the user needs an actionable answer.
 */
export async function sendAgentReportEmailOrThrow({ userId, subject, body, html = null }) {
  if (!process.env.RESEND_API_KEY) {
    throw new AgentError(
      "Email delivery is not configured on the server yet.",
      "EMAIL_SERVICE_UNAVAILABLE",
      503
    );
  }
  const { email, verified, reason } = await getVerifiedAccountEmail(userId);
  if (!verified) {
    throw new AgentError(
      `${describeUnverifiedStatus(email, reason)}. Verify first, then try again.`,
      "EMAIL_NOT_VERIFIED",
      403
    );
  }
  try {
    await deliverToAddress({ email, subject, body, html });
  } catch (error) {
    throw new AgentError(
      `${describeEmailDeliveryFailure(error?.message, email)}. Try again shortly.`,
      "EMAIL_DELIVERY_FAILED",
      502
    );
  }
  return {
    sent: true,
    status: `email sent to your verified account address (${maskEmailAddress(email)})`,
  };
}

/**
 * True when a chat message is asking the agent to email its report/draft.
 * Deliberately conservative: requires an email verb-with-object phrasing so
 * questions that merely mention email do not trigger a send.
 * Status questions ("Did you email this?") are never send requests.
 */
export function isEmailReportRequest(message) {
  const text = String(message || "").toLowerCase();
  if (!/\be-?mail/.test(text)) return false;
  // Settings toggles ("enable email", "turn off email") are not send requests.
  if (/\b(enable|disable|turn on|turn off|stop)\b.{0,40}\be-?mail/.test(text)) {
    return false;
  }
  // Intent ≠ execution: status/info questions must not short-circuit into a send.
  const kind = classifyAgentRequest(message);
  if (
    kind === AGENT_REQUEST_KINDS.STATUS_QUESTION ||
    kind === AGENT_REQUEST_KINDS.INFORMATION_REQUEST
  ) {
    return false;
  }
  return (
    /\b(e-?mail|mail|send)\s+(me|the|this|that|it|a|my|over|your)\b/.test(text) ||
    /\bsend\s+(an?\s+)?e-?mail\b/.test(text) ||
    /\be-?mail\s+(me|it|this|that|the|a|my)\b/.test(text) ||
    /\bto my e-?mail\b/.test(text)
  );
}

/**
 * Builds the subject, HTML body, and plain-text fallback for a run's report
 * email. The report (agent output) is treated as markdown: rendered and
 * sanitized into the executive HTML template, and stripped of markdown
 * syntax for the text fallback.
 */
export function buildRunEmailContent({ agentName, agentType, run, output }) {
  const title = agentName || "Your agent";
  const runDate = formatRunDate(run?.startedAt ? new Date(run.startedAt) : new Date());
  const subject = `${title} — ${runDate}`;
  const reportMarkdown = output || run?.summary || "(no stored output)";
  const summaryText = run?.summary ? String(run.summary) : null;

  const html = buildEmailHtml({
    agentType,
    title,
    runDate,
    bodyHtml: renderMarkdownToEmailHtml(reportMarkdown),
    summaryHtml: summaryText ? renderInlineMarkdownToEmailHtml(summaryText) : null,
  });

  const lines = [`${title} — ${runDate}`, ""];
  if (summaryText) {
    lines.push("Summary", markdownToPlainText(summaryText), "");
  }
  lines.push(markdownToPlainText(reportMarkdown));
  lines.push(
    "",
    "—",
    "Sent by Freedom OS to your verified account email at your request. Agents can only email you, never anyone else."
  );
  return { subject, body: lines.join("\n"), html };
}

/**
 * Picks the related or latest succeeded run for an agent and emails it to the
 * user's verified address. Does not touch chat history — callers decide how
 * to record the exchange. Returns { reply, run }.
 */
export async function deliverAgentRunReport({ userId, agentConfigId, relatedRunId = null }) {
  const context = await withUserContext(userId, async (tx) => {
    const agentConfig = await tx.agentConfig.findFirst({
      where: { id: agentConfigId, userId },
    });
    if (!agentConfig) {
      throw new AgentError("Agent not found.", "AGENT_NOT_FOUND", 404);
    }
    const run = relatedRunId
      ? await tx.agentRun.findFirst({
          where: { id: relatedRunId, userId, agentConfigId: agentConfig.id },
        })
      : await tx.agentRun.findFirst({
          where: { userId, agentConfigId: agentConfig.id, status: "SUCCEEDED" },
          orderBy: { startedAt: "desc" },
        });
    return { agentConfig, run };
  });

  const { agentConfig, run } = context;
  if (!run) {
    return {
      reply:
        'There is no completed run to email yet. Ask me to run now (or wait for the schedule), then ask me again.',
      run: null,
    };
  }

  let output = null;
  if (run.outputCiphertext) {
    try {
      output = decrypt(run.outputCiphertext);
    } catch {
      output = null;
    }
  }
  const { subject, body, html } = buildRunEmailContent({
    agentName: agentConfig.name,
    agentType: agentConfig.agentType,
    run,
    output,
  });
  const result = await sendAgentReportEmail({ userId, subject, body, html });
  return {
    reply: result.sent
      ? `Done — I've emailed that report to your verified account address.`
      : `I couldn't email it: ${result.status}. The full report is still available here in Freedom OS.`,
    run,
    sent: result.sent === true,
    emailStatus: result.status || null,
  };
}

/**
 * Chat-path handler: the user asked a sub-agent (in chat) to email its
 * report/draft. Persists both chat rows and emails the related/latest run.
 */
export async function emailRunReportFromChat({
  userId,
  agentConfigId,
  conversationId = null,
  message,
  relatedRunId = null,
}) {
  const prep = await withUserContext(userId, async (tx) => {
    const agentConfig = await tx.agentConfig.findFirst({
      where: { id: agentConfigId, userId },
    });
    if (!agentConfig) {
      throw new AgentError("Agent not found.", "AGENT_NOT_FOUND", 404);
    }

    const conversation = await resolveConversationForWrite(tx, {
      userId,
      agentConfigId: agentConfig.id,
      conversationId,
      allowSystem: false,
    });

    await tx.agentChatMessage.create({
      data: {
        userId,
        conversationId: conversation.id,
        agentConfigId: agentConfig.id,
        role: "USER",
        contentCiphertext: encrypt(String(message)),
        relatedRunId: relatedRunId || null,
      },
    });
    await touchConversation(tx, conversation.id);
    const conversationTitle = await applySnippetTitleIfNeeded(tx, {
      conversationId: conversation.id,
      messageText: String(message),
    });

    return {
      agentConfigId: agentConfig.id,
      conversationId: conversation.id,
      conversationTitle,
    };
  });

  const delivered = await deliverAgentRunReport({
    userId,
    agentConfigId: prep.agentConfigId,
    relatedRunId,
  });

  const replyMessage = await withUserContext(userId, async (tx) => {
    const created = await tx.agentChatMessage.create({
      data: {
        userId,
        conversationId: prep.conversationId,
        agentConfigId: prep.agentConfigId,
        role: "AGENT",
        contentCiphertext: encrypt(delivered.reply),
        relatedRunId: delivered.run?.id || null,
      },
    });
    await touchConversation(tx, prep.conversationId);
    return created;
  });

  return {
    reply: delivered.reply,
    messageId: replyMessage.id,
    conversationId: prep.conversationId,
    conversationTitle: prep.conversationTitle,
  };
}
