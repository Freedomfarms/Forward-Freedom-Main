import { Resend } from "resend";
import { getFirebaseAdminAuth, isFirebaseAdminConfigured } from "../auth/firebaseAdmin.js";
import { withUserContext } from "../db/prisma.js";
import { decrypt, encrypt } from "../security/envelope.js";
import { AgentError } from "./errors.js";

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
      return { email: record.email, verified: false, reason: "the account email is not verified" };
    }
    return { email: record.email, verified: true, reason: null };
  } catch {
    return { email: null, verified: false, reason: "the account email could not be looked up" };
  }
}

async function deliverToAddress({ email, subject, body }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: EMAIL_FROM,
    to: [email],
    subject,
    text: body,
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
export async function sendAgentReportEmail({ userId, subject, body }) {
  if (!process.env.RESEND_API_KEY) {
    return { sent: false, status: "email skipped (email service is not configured)" };
  }
  const { email, verified, reason } = await getVerifiedAccountEmail(userId);
  if (!verified) {
    return { sent: false, status: `email skipped (${reason})` };
  }
  try {
    await deliverToAddress({ email, subject, body });
    return { sent: true, status: "email sent to your verified account address" };
  } catch (error) {
    return { sent: false, status: `email delivery failed (${error?.message || "unknown error"})` };
  }
}

/**
 * Like sendAgentReportEmail but throws typed AgentErrors for API endpoints
 * (the "Email me this run" button) where the user needs an actionable answer.
 */
export async function sendAgentReportEmailOrThrow({ userId, subject, body }) {
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
      `Emails can only go to your verified account address, and ${reason}. Verify your email from your account settings, then try again.`,
      "EMAIL_NOT_VERIFIED",
      403
    );
  }
  try {
    await deliverToAddress({ email, subject, body });
  } catch (error) {
    throw new AgentError(
      `Email delivery failed (${error?.message || "unknown error"}). Try again shortly.`,
      "EMAIL_DELIVERY_FAILED",
      502
    );
  }
  return { sent: true, status: "email sent to your verified account address" };
}

/**
 * True when a chat message is asking the agent to email its report/draft.
 * Deliberately conservative: requires an email verb-with-object phrasing so
 * questions that merely mention email do not trigger a send.
 */
export function isEmailReportRequest(message) {
  const text = String(message || "").toLowerCase();
  if (!/\be-?mail/.test(text)) return false;
  return (
    /\b(e-?mail|mail|send)\s+(me|the|this|that|it|a|my|over|your)\b/.test(text) ||
    /\bto my e-?mail\b/.test(text)
  );
}

export function buildRunEmailContent({ agentName, agentType, run, output }) {
  const subject = `${agentName || "Your agent"} — ${
    agentType === "reminders" ? "reminder" : "report"
  } from Freedom OS`;
  const startedAt = run?.startedAt ? new Date(run.startedAt).toUTCString() : null;
  const lines = [
    `Here is the latest output from "${agentName || "your agent"}"${startedAt ? ` (run started ${startedAt})` : ""}.`,
    "",
  ];
  if (run?.summary) {
    lines.push("Summary:", run.summary, "");
  }
  lines.push("Report:", output || run?.summary || "(no stored output)");
  lines.push(
    "",
    "—",
    "Sent by Freedom OS to your verified account email at your request. Agents can only email you, never anyone else."
  );
  return { subject, body: lines.join("\n") };
}

/**
 * Chat-path handler: the user asked a sub-agent (in chat) to email its
 * report/draft. Picks the referenced run (or the latest completed one),
 * emails it to the verified account address, and writes both chat rows so
 * the exchange is part of the durable thread. Returns { reply, messageId }.
 */
export async function emailRunReportFromChat({ userId, agentConfigId, message, relatedRunId = null }) {
  const context = await withUserContext(userId, async (tx) => {
    const agentConfig = await tx.agentConfig.findFirst({
      where: { id: agentConfigId, userId },
    });
    if (!agentConfig) {
      throw new AgentError("Agent not found.", "AGENT_NOT_FOUND", 404);
    }

    await tx.agentChatMessage.create({
      data: {
        userId,
        agentConfigId: agentConfig.id,
        role: "USER",
        contentCiphertext: encrypt(String(message)),
        relatedRunId: relatedRunId || null,
      },
    });

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

  let reply;
  if (!run) {
    reply =
      'There is no completed run to email yet. Use "Run now" (or wait for the schedule), then ask me again.';
  } else {
    let output = null;
    if (run.outputCiphertext) {
      try {
        output = decrypt(run.outputCiphertext);
      } catch {
        output = null;
      }
    }
    const { subject, body } = buildRunEmailContent({
      agentName: agentConfig.name,
      agentType: agentConfig.agentType,
      run,
      output,
    });
    const result = await sendAgentReportEmail({ userId, subject, body });
    reply = result.sent
      ? "Done — I've emailed that report to your verified account address."
      : `I couldn't email it: ${result.status}. The full report is still available here in Freedom OS.`;
  }

  const replyMessage = await withUserContext(userId, (tx) =>
    tx.agentChatMessage.create({
      data: {
        userId,
        agentConfigId: agentConfig.id,
        role: "AGENT",
        contentCiphertext: encrypt(reply),
        relatedRunId: run?.id || null,
      },
    })
  );

  return { reply, messageId: replyMessage.id };
}
