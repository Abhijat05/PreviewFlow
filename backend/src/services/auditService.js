// backend/src/services/auditService.js
import { prisma as defaultPrisma } from "../db.js";
import { getLogContext, logger, redactValue } from "../utils/logger.js";
import { recordAuditMetric } from "./metricsService.js";

/**
 * Extracts normalized client IP from an Express request safely.
 */
export function extractClientIp(req) {
  if (!req) return null;
  return req.ip || req.socket?.remoteAddress || null;
}

/**
 * Persists a security or lifecycle audit trail event into AuditLog with automatic secret redaction
 * and requestId correlation. Fails gracefully without interrupting primary request flows.
 */
export async function recordAuditEvent(
  {
    actorUserId = null,
    actorType = "USER",
    action,
    resourceType = null,
    resourceId = null,
    status = "SUCCESS",
    ipAddress = null,
    requestId = null,
    metadata = null
  },
  { client = defaultPrisma } = {}
) {
  if (!action || typeof action !== "string") {
    return null;
  }

  const ctx = getLogContext();
  const resolvedRequestId = requestId || ctx.requestId || null;
  const resolvedActorUserId = actorUserId ?? ctx.userId ?? null;
  const safeMetadata = metadata ? redactValue(metadata) : null;

  recordAuditMetric({ action, status });

  logger.info("Audit event recorded", {
    eventType: "audit_event",
    action,
    actorUserId: resolvedActorUserId,
    actorType,
    resourceType,
    resourceId,
    auditStatus: status,
    requestId: resolvedRequestId
  });

  if (typeof client?.auditLog?.create !== "function") {
    return null;
  }

  try {
    return await client.auditLog.create({
      data: {
        actorUserId: resolvedActorUserId,
        actorType,
        action,
        resourceType,
        resourceId,
        status,
        ipAddress,
        requestId: resolvedRequestId,
        metadata: safeMetadata
      }
    });
  } catch (err) {
    if (err?.code === "P2021" || err?.message?.includes("does not exist")) {
      logger.warn("AuditLog table unavailable; skipping audit persistence", { action });
      return null;
    }
    logger.warn("Failed to persist AuditLog entry", { action, err });
    return null;
  }
}

/**
 * Convenience wrapper recording an HTTP-originated audit event with IP and requestId extracted.
 */
export function recordHttpAudit(req, params, options) {
  return recordAuditEvent(
    {
      ipAddress: extractClientIp(req),
      requestId: req?.requestId || null,
      ...params
    },
    options
  );
}

/**
 * Queries paginated audit trail records scoped to a specific tenant user.
 */
export async function queryAuditLogs(
  { actorUserId, action = null, resourceType = null, limit = 50, offset = 0 },
  { client = defaultPrisma } = {}
) {
  if (!actorUserId) return [];

  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100);
  const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);

  const where = {
    actorUserId,
    ...(action ? { action } : {}),
    ...(resourceType ? { resourceType } : {})
  };

  return client.auditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: safeLimit,
    skip: safeOffset
  });
}
