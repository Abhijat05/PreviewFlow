// backend/src/routes/projects.js
import express from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../db.js";

const router = express.Router();

// Get all projects + previews for logged-in user
router.get("/", async (req, res) => {
  try {
    const auth = req.headers.authorization?.split(" ")[1];
    if (!auth) return res.status(401).json({ error: "Missing token" });

    const { userId } = jwt.verify(auth, process.env.JWT_SECRET);

    const projects = await prisma.project.findMany({
      where: { userId },
      include: { previews: true }
    });

    res.json(projects);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load projects" });
  }
});

export default router;
