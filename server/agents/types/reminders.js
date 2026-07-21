import { withUserContext } from "../../db/prisma.js";
import { isEmailDeliveryEnabled, sendAgentReportEmail } from "../emailDelivery.js";

// ─────────────────────────────────────────────────────────────────────────────
// Reminders agent: delivery needs no LLM call. It writes an IN_APP
// Notification row and, when the agent's toolAccess enables email, sends the
// reminder via the shared email delivery module — exclusively to the
// account's own VERIFIED email address. The recipient is structurally
// hardcoded to that address; there is no parameter through which any other
// destination can be supplied.
// ─────────────────────────────────────────────────────────────────────────────

export { isEmailDeliveryEnabled };

function buildReminderContent(config) {
  const title = `Reminder from ${config.name || "your reminders agent"}`;
  const body =
    String(config.instructions || "").trim() ||
    String(config.definitionOfDone || "").trim() ||
    "Your reminder is due.";
  return { title, body };
}

export async function runRemindersAgent({ userId, config }) {
  const { title, body } = buildReminderContent(config);

  await withUserContext(userId, (tx) =>
    tx.notification.create({
      data: { userId, agentConfigId: config.id, title, body, channel: "IN_APP" },
    })
  );

  let emailStatus = null;
  let emailSent = false;
  if (isEmailDeliveryEnabled(config.toolAccess)) {
    const result = await sendAgentReportEmail({ userId, subject: title, body });
    emailStatus = result.status;
    emailSent = result.sent;
    if (result.sent) {
      await withUserContext(userId, (tx) =>
        tx.notification.create({
          data: { userId, agentConfigId: config.id, title, body, channel: "EMAIL" },
        })
      );
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
        "Created a self-notification from the agent's own configuration; read only the account's verified email address for delivery.",
      notifications: { channels: emailSent ? ["IN_APP", "EMAIL"] : ["IN_APP"] },
    },
  };
}
