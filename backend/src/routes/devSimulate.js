import express from "express";
import { prisma } from "../db.js";
import { handlePROpenOrSync, handlePRClosed } from "../services/prHandlers.js";

const router = express.Router();

const VALID_ACTIONS = ["open", "sync", "close", "reopen"];

router.post("/dev/sim-pr", async (req, res) => {
  // Defense-in-depth: strictly disallow in production
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "dev_endpoints_disabled_in_production" });
  }

  try {
    const { projectId, prNumber, action = "open" } = req.body || {};

    if (!projectId || typeof projectId !== "string" || !projectId.trim()) {
      return res.status(400).json({ error: "valid_projectId_required" });
    }

    const parsedPrNumber = Number(prNumber);
    if (!Number.isInteger(parsedPrNumber) || parsedPrNumber <= 0) {
      return res.status(400).json({ error: "valid_prNumber_required" });
    }

    if (!VALID_ACTIONS.includes(action)) {
      return res.status(400).json({
        error: "invalid_action",
        allowed: VALID_ACTIONS
      });
    }

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return res.status(404).json({ error: "project not found" });
    }

    if (action === "close") {
      await handlePRClosed({ project, prNumber: parsedPrNumber });
    } else {
      await handlePROpenOrSync({ project, prNumber: parsedPrNumber });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("dev/sim-pr error:", err);
    return res.status(500).json({ error: "simulation_failed", message: err.message });
  }
});

export default router;
