// backend/src/routes/previewActions.js
import express from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../db.js";
import { cloneRepo } from "../services/repoService.js";
import { buildPreview, removeContainer } from "../services/dockerService.js";
import { getIO } from "../socket.js";
import fs from "fs";

const router = express.Router();

// AUTH
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/**
 * -------------------------------------------------------
 *  REBUILD PREVIEW
 * -------------------------------------------------------
 */
router.post("/preview/:id/rebuild", auth, async (req, res) => {
  try {
    const preview = await prisma.preview.findUnique({
      where: { id: req.params.id },
      include: { project: true }
    });

    if (!preview) return res.status(404).json({ error: "Preview not found" });
    if (preview.project.userId !== req.user.userId)
      return res.status(403).json({ error: "Not allowed" });

    // Stop container if running
    if (preview.containerName) {
      await removeContainer(preview.containerName);
    }

    // STEP 1 — Immediately set status to building
    await prisma.preview.update({
      where: { id: preview.id },
      data: {
        status: "building",
        url: null,
        buildStartedAt: new Date(),
        buildCompletedAt: null
      }
    });

    // Emit LIVE update
    getIO().emit("preview-status-update", {
      projectId: preview.projectId,
      prNumber: preview.prNumber,
      status: "building"
    });

    // STEP 2 — Clone repo
    const repoPath = await cloneRepo({
      repoOwner: preview.project.repoOwner,
      repoName: preview.project.repoName
    });

    // STEP 3 — Try build
    let url = null;

    try {
      url = await buildPreview({
        project: preview.project,
        previewId: preview.id,
        repoPath,
        prNumber: preview.prNumber
      });
    } catch (err) {
      // BUILD FAILED — Update DB and emit error
      await prisma.preview.update({
        where: { id: preview.id },
        data: {
          status: "error",
          buildCompletedAt: new Date()
        }
      });

      getIO().emit("preview-status-update", {
        projectId: preview.projectId,
        prNumber: preview.prNumber,
        status: "error"
      });

      fs.rmSync(repoPath, { recursive: true, force: true });

      return res.json({ ok: false, error: "Build failed" });
    }

    // STEP 4 — Success
    fs.rmSync(repoPath, { recursive: true, force: true });

    return res.json({ ok: true, url });
  } catch (err) {
    return res.status(500).json({ error: "Unexpected error" });
  }
});

/**
 * -------------------------------------------------------
 *  DELETE PREVIEW
 * -------------------------------------------------------
 */
router.post("/preview/:id/delete", auth, async (req, res) => {
  try {
    const preview = await prisma.preview.findUnique({
      where: { id: req.params.id },
      include: { project: true }
    });

    if (!preview) return res.status(404).json({ error: "Preview not found" });
    if (preview.project.userId !== req.user.userId)
      return res.status(403).json({ error: "Not allowed" });

    if (preview.containerName) {
      await removeContainer(preview.containerName);
    }

    await prisma.preview.update({
      where: { id: preview.id },
      data: { status: "deleted", url: null }
    });

    getIO().emit("preview-status-update", {
      projectId: preview.projectId,
      prNumber: preview.prNumber,
      status: "deleted",
      url: null
    });

    res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
