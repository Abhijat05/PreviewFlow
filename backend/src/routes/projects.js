import express from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// Get all projects + previews for logged-in user
router.get("/", requireAuth, async (req, res) => {
  try {
    const projects = await prisma.project.findMany({
      where: { userId: req.auth.userId },
      include: { previews: true },
    });

    res.json(projects);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load projects" });
  }
});

export default router;
