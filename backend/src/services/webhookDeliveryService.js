// backend/src/services/webhookDeliveryService.js
import { prisma as defaultPrisma } from "../db.js";

/**
 * Records an incoming webhook delivery from GitHub.
 */
export async function recordDelivery({
  deliveryId,
  eventType,
  action = null,
  projectId = null,
  prNumber = null,
  commitSha = null,
  client = defaultPrisma
}) {
  if (!deliveryId) {
    throw new Error("deliveryId is required to record webhook delivery");
  }
  if (!eventType) {
    throw new Error("eventType is required to record webhook delivery");
  }

  return client.webhookDelivery.create({
    data: {
      deliveryId,
      eventType,
      action,
      projectId,
      prNumber: typeof prNumber === "number" ? prNumber : null,
      commitSha: commitSha ? String(commitSha).trim() : null,
      status: "RECEIVED"
    }
  });
}

/**
 * Checks if a webhook deliveryId has already been recorded in the database.
 */
export async function isDuplicateDelivery(deliveryId, { client = defaultPrisma } = {}) {
  if (!deliveryId) return false;

  const existing = await client.webhookDelivery.findUnique({
    where: { deliveryId }
  });

  return Boolean(existing);
}

/**
 * Marks a recorded webhook delivery as PROCESSED, FAILED, or IGNORED.
 */
export async function markDeliveryProcessed(
  deliveryId,
  { status = "PROCESSED", errorMessage = null, client = defaultPrisma } = {}
) {
  if (!deliveryId) return null;

  return client.webhookDelivery.update({
    where: { deliveryId },
    data: {
      status,
      processedAt: new Date(),
      errorMessage
    }
  });
}

/**
 * Retrieves a webhook delivery record by deliveryId.
 */
export async function getDeliveryById(deliveryId, { client = defaultPrisma } = {}) {
  if (!deliveryId) return null;

  return client.webhookDelivery.findUnique({
    where: { deliveryId }
  });
}
