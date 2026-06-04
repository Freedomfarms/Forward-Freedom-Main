import { getPrismaClient, isDatabaseConfigured } from "../db/prisma.js";
import { logPlaidServerEvent } from "./logging.js";
import { readRawRequestBody, verifyPlaidWebhookRequest } from "./webhookVerification.js";

function buildErrorResponse(message, status = 400) {
  return {
    error: true,
    message,
    status,
  };
}

async function markPlaidItemAttention(itemId, message) {
  if (!isDatabaseConfigured()) {
    return;
  }

  const prisma = getPrismaClient();
  if (!prisma || !itemId) {
    return;
  }

  await prisma.plaidItem.updateMany({
    where: { itemId },
    data: {
      status: "REQUIRES_ATTENTION",
      lastSyncError: message,
    },
  });
}

export async function handlePlaidWebhook(request, response) {
  try {
    const rawBody = await readRawRequestBody(request);
    const verified = await verifyPlaidWebhookRequest(request, rawBody);
    if (!verified) {
      return response.status(401).json(buildErrorResponse("Unable to verify Plaid webhook.", 401));
    }

    const payload = rawBody ? JSON.parse(rawBody) : {};
    const webhookType = payload.webhook_type || "UNKNOWN";
    const webhookCode = payload.webhook_code || "UNKNOWN";
    const itemId = payload.item_id || null;

    logPlaidServerEvent("info", "webhook_received", {
      webhookType,
      webhookCode,
      itemId,
    });

    if (itemId && webhookType === "ITEM" && ["ERROR", "PENDING_EXPIRATION", "USER_PERMISSION_REVOKED"].includes(webhookCode)) {
      await markPlaidItemAttention(
        itemId,
        `Plaid item webhook: ${webhookType}.${webhookCode}`
      );
    }

    return response.status(200).json({ received: true });
  } catch (error) {
    logPlaidServerEvent("warn", "webhook_processing_failed", {
      message: error?.message || "Unknown webhook processing error.",
    });
    return response.status(500).json(buildErrorResponse("Unable to process Plaid webhook.", 500));
  }
}
