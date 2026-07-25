import { withUserContext } from "../db/prisma.js";
import { decrypt, encrypt } from "../security/envelope.js";
import { touchConversation } from "./conversations.js";

// ─────────────────────────────────────────────────────────────────────────────
// After an async CEO-delegated run finishes: post the result into the same CEO
// conversation and create an in-app Notification. Best-effort — never throws
// into the run path.
// ─────────────────────────────────────────────────────────────────────────────

function clampBody(text, max = 1800) {
  const value = String(text || "").trim();
  if (!value) return "(no report body)";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export async function notifyCeoDelegatedRunComplete({
  userId,
  ceoAgentConfigId,
  conversationId,
  agentName,
  run,
}) {
  if (!userId || !ceoAgentConfigId || !conversationId || !run?.id) return;

  let output = null;
  if (run.outputCiphertext) {
    try {
      output = decrypt(run.outputCiphertext);
    } catch {
      output = null;
    }
  }

  const status = run.status || "UNKNOWN";
  const summary = String(run.summary || "").trim();
  const name = agentName || run.agentType || "agent";

  let chatBody;
  if (status === "SUCCEEDED") {
    chatBody = [
      `Results from ${name}:`,
      summary || null,
      output ? clampBody(output) : null,
    ]
      .filter(Boolean)
      .join("\n\n");
  } else if (status === "SKIPPED") {
    chatBody = `${name} did not run (${run.error || "skipped"}).`;
  } else {
    chatBody = `${name} failed${run.error ? `: ${run.error}` : "."}`;
  }

  const notifTitle =
    status === "SUCCEEDED" ? `${name} finished` : `${name} did not complete`;
  const notifBody = summary || chatBody.slice(0, 280);

  try {
    await withUserContext(userId, async (tx) => {
      await tx.agentChatMessage.create({
        data: {
          userId,
          conversationId,
          ceoAgentConfigId,
          agentConfigId: null,
          role: "AGENT",
          contentCiphertext: encrypt(chatBody),
          relatedRunId: run.id,
        },
      });
      await touchConversation(tx, conversationId);
      await tx.notification.create({
        data: {
          userId,
          agentConfigId: run.agentConfigId ?? null,
          title: notifTitle,
          body: notifBody,
          channel: "IN_APP",
        },
      });
    });
  } catch (error) {
    console.warn(
      "[runCompletion] Failed to notify CEO conversation:",
      error?.message || error
    );
  }
}
