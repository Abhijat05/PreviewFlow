// backend/src/routes/auditLogs.js
import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { queryAuditLogs } from "../services/auditService.js";
import { logger } from "../utils/logger.js";

const router = express.Router();

export async function handleGetAuditLogs(req, res) {
  try {
    const actorUserId = req.auth?.userId;
    if (!actorUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { action, resourceType, limit, offset } = req.query || {};
    const logs = await queryAuditLogs({
      actorUserId,
      action: typeof action === "string" && action.trim() ? action.trim() : null,
      resourceType: typeof resourceType === "string" && resourceType.trim() ? resourceType.trim() : null,
      limit,
      offset
    });

    return res.json({ logs });
  } catch (err) {
    logger.error("Failed to load audit logs", { err });
    return res.status(500).json({ error: "failed_to_load_audit_logs" });
  }
}

router.get("/audit-logs", requireAuth, handleGetAuditLogs);

export default router;
