import express from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.get("/preview/:id/logs", requireAuth, async (req, res) => {
  try {
    const preview = await prisma.preview.findUnique({
      where: { id: req.params.id },
      include: { project: true }
    });
    if (!preview) return res.status(404).json({ error: "Preview not found" });
    if (preview.project.userId !== req.auth.userId) return res.status(403).json({ error: "Forbidden" });

    res.json({ logs: preview.buildLogs || "" });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to load logs" });
  }
});

export default router;
