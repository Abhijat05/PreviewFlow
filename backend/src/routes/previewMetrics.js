import express from "express";
import { prisma } from "../db.js";
import { requireSubscription } from "../middleware/subscription.js";

const router = express.Router();

/**
 * GET /api/previews/:previewId/metrics?range=1h|24h
 */
router.get(
  "/:previewId/metrics",
  requireSubscription,
  async (req, res) => {
    try {
      const { previewId } = req.params;
      const { range = "1h" } = req.query;

      const userId = req.sub.userId;

      // Validate preview belongs to user
      const preview = await prisma.preview.findFirst({
        where: {
          id: previewId,
          project: { userId }
        }
      });

      if (!preview) {
        return res.status(404).json({ error: "Preview not found" });
      }

      // Determine time range
      let since;
      const now = new Date();

      if (range === "24h") {
        since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      } else {
        // default 1h
        since = new Date(now.getTime() - 60 * 60 * 1000);
      }

      const metrics = await prisma.previewMetric.findMany({
        where: {
          previewId,
          createdAt: { gte: since }
        },
        orderBy: { createdAt: "asc" }
      });

      // Convert BigInt safely
      const formatted = metrics.map((m) => ({
        cpu: m.cpu,
        memory: Number(m.memory),
        networkRx: m.networkRx ? Number(m.networkRx) : 0,
        networkTx: m.networkTx ? Number(m.networkTx) : 0,
        createdAt: m.createdAt
      }));

      res.json({
        previewId,
        range,
        count: formatted.length,
        metrics: formatted
      });

    } catch (err) {
      console.error("metrics fetch error", err);
      res.status(500).json({ error: "Failed to fetch metrics" });
    }
  }
);

export default router;