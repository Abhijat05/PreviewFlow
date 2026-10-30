import express from "express";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = req.auth.user;
    return res.json({
      tier: user.tier,
      id: user.id,
      githubId: user.githubId,
      username: user.username,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to load user" });
  }
});

export default router;
