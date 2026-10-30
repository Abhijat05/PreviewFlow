import express from "express";
import axios from "axios";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.get("/repos", requireAuth, async (req, res) => {
  try {
    const accessToken = req.auth?.accessToken;
    if (!accessToken) {
      return res.status(401).json({ error: "Missing GitHub access token" });
    }

    const response = await axios.get("https://api.github.com/user/repos", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    res.json(
      response.data.map((repo) => ({
        name: repo.name,
        owner: repo.owner.login,
        fullName: repo.full_name,
      }))
    );
  } catch (err) {
    const status = err.response?.status || 500;
    return res
      .status(status)
      .json({ error: err.response?.data?.message || err.message || "Failed to fetch repositories" });
  }
});

export default router;
