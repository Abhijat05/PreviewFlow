import express from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.get("/projects", requireAuth, async (req, res) => {
  try {
    const projects = await prisma.project.findMany({
      where: { userId: req.auth.userId },
      include: {
        previews: {
          orderBy: { prNumber: "desc" },
        },
      },
    });

    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to load projects" });
  }
});

export default router;
