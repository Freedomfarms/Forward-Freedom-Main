import { Resend } from "resend";

import { withUserContext } from "../../db/prisma.js";

// ─────────────────────────────────────────────────────────────────────────────
// Reminders agent: delivery needs no LLM call. It writes an IN_APP
// Notification row and, when the agent's toolAccess enables email, sends the
// reminder via Resend — exclusively to the account's own email address from
// the User row. The recipient is structurally hardcoded to that address;
// there is no parameter through which any other destination can be supplied.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_FROM =
  process.env.RESEND_FROM_EMAIL || "Freedom OS <notifications@forwardfreedomfinancial.com>";

export function isEmailDeliveryEnabled(toolAccess) {
  if (Array.isArray(toolAccess)) return toolAccess.includes("email");
  if (toolAccess && typeof toolAccess === "object") return toolAccess.email === true;
  return false;
}

function buildReminderContent(config) {
  const title = `Reminder from ${config.name || "your reminders agent"}`;
  const body =
    String(config.instructions || "").trim() ||
    String(config.definitionOfDone || "").trim() ||
    "Your reminder is due.";
  return { title, body };
}

// Sends to the user's own address ONLY (never a caller-supplied address).
async function sendSelfEmail({ userEmail, title, body }) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: EMAIL_FROM,
    to: [userEmail],
    subject: title,
    text: body,
  });
  if (error) {
    throw new Error(error.message || "Email delivery failed.");
  }
}

export async function runRemindersAgent({ userId, config }) {
  const { title, body } = buildReminderContent(config);

  const user = await withUserContext(userId, async (tx) => {
    await tx.notification.create({
      data: { userId, agentConfigId: config.id, title, body, channel: "IN_APP" },
    });
    return tx.user.findUnique({ where: { id: userId }, select: { email: true } });
  });

  let emailStatus = null;
  let emailSent = false;
  if (isEmailDeliveryEnabled(config.toolAccess)) {
    if (!process.env.RESEND_API_KEY) {
      // Degrade cleanly: the in-app notification was delivered; email is
      // skipped with an explanation instead of crashing the run.
      emailStatus = "email skipped (email service is not configured)";
    } else if (!user?.email) {
      emailStatus = "email skipped (no email address on the account)";
    } else {
      try {
        await sendSelfEmail({ userEmail: user.email, title, body });
        await withUserContext(userId, (tx) =>
          tx.notification.create({
            data: { userId, agentConfigId: config.id, title, body, channel: "EMAIL" },
          })
        );
        emailStatus = "email sent to your account address";
        emailSent = true;
      } catch (error) {
        emailStatus = `email delivery failed (${error?.message || "unknown error"})`;
      }
    }
  }

  const summary = emailStatus
    ? `Reminder delivered in-app; ${emailStatus}.`
    : "Reminder delivered in-app.";

  return {
    summary,
    output: `${summary}\n\nTitle: ${title}\nBody: ${body}`,
    usage: null,
    model: null,
    dataAccessed: {
      description:
        "Created a self-notification from the agent's own configuration; read only the account's email address for delivery.",
      notifications: { channels: emailSent ? ["IN_APP", "EMAIL"] : ["IN_APP"] },
    },
  };
}
