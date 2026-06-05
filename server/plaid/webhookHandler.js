import { syncPlaidWorkspaceForWebhookItem } from "./handlers.js";
import { getPrismaClient, isDatabaseConfigured } from "../db/prisma.js";
import { logPlaidServerEvent } from "./logging.js";
import { readRawRequestBody, verifyPlaidWebhookRequest } from "./webhookVerification.js";

const ITEM_ATTENTION_CODES = new Set(["ERROR", "PENDING_EXPIRATION", "USER_PERMISSION_REVOKED"]);
const TRANSACTION_SYNC_CODES = new Set(["SYNC_UPDATES_AVAILABLE"]);

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

    let syncResult = null;

    if (itemId && webhookType === "ITEM" && ITEM_ATTENTION_CODES.has(webhookCode)) {
      await markPlaidItemAttention(itemId, `Plaid item webhook: ${webhookType}.${webhookCode}`);
    }

    if (itemId && webhookType === "TRANSACTIONS" && TRANSACTION_SYNC_CODES.has(webhookCode)) {
      try {
        syncResult = await syncPlaidWorkspaceForWebhookItem(itemId);
        logPlaidServerEvent("info", "webhook_sync_complete", {
          webhookType,
          webhookCode,
          itemId,
          ...syncResult,
        });
      } catch (error) {
        logPlaidServerEvent("warn", "webhook_sync_failed", {
          webhookType,
          webhookCode,
          itemId,
          message: error?.message || "Unable to sync Plaid data for this webhook.",
        });
      }
    }

    return response.status(200).json({
      received: true,
      syncTriggered: Boolean(syncResult?.synced),
      syncResult,
    });
  } catch (error) {
    logPlaidServerEvent("warn", "webhook_processing_failed", {
      message: error?.message || "Unknown webhook processing error.",
    });
    return response.status(500).json(buildErrorResponse("Unable to process Plaid webhook.", 500));
  }
}
