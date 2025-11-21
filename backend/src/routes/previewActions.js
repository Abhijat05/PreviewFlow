// backend/src/routes/previewActions.js
import express from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../db.js";
import { cloneRepo } from "../services/repoService.js";
import { buildPreview, removeContainer } from "../services/dockerService.js";
import { getIO } from "../socket.js";
import fs from "fs";

const router = express.Router();

// simple auth middleware (expects Authorization: Bearer <jwt>)
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/**
 * POST /api/preview/:id/rebuild
 * Rebuilds the preview (stops old container, builds again)
 */
router.post("/preview/:id/rebuild", auth, async (req, res) => {
  try {
    const preview = await prisma.preview.findUnique({
      where: { id: req.params.id },
      include: { project: true }
    });
    if (!preview) return res.status(404).json({ error: "Preview not found" });
    if (preview.project.userId !== req.user.userId) return res.status(403).json({ error: "Not allowed" });

    // Stop previous container
    if (preview.containerName) {
      await removeContainer(preview.containerName);
    }

    // Immediately mark building and emit
    await prisma.preview.update({
      where: { id: preview.id },
      data: { status: "building", url: null, buildStartedAt: new Date(), buildCompletedAt: null }
    });

    getIO().emit("preview-status-update", { previewId: preview.id, projectId: preview.projectId, prNumber: preview.prNumber, status: "building", url: null });

    // Clone repo and build
    const repoPath = await cloneRepo({ repoOwner: preview.project.repoOwner, repoName: preview.project.repoName });

    try {
      const url = await buildPreview({ project: preview.project, previewId: preview.id, repoPath, prNumber: preview.prNumber });

      // cleanup
      try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch (e) {}

      // Emit full preview update (read DB in handler)
      // use prHandlers.handlePROpenOrSync flow would also emit; but we emit final snapshot here
      const updated = await prisma.preview.findUnique({ where: { id: preview.id } });
      getIO().emit("preview-status-update", {
        previewId: updated.id,
        projectId: updated.projectId,
        prNumber: updated.prNumber,
        status: updated.status,
        url: updated.url,
        buildStartedAt: updated.buildStartedAt,
        buildCompletedAt: updated.buildCompletedAt,
        containerName: updated.containerName
      });

      return res.json({ ok: true, url });
    } catch (err) {
      // Build failed: ensure DB status=error and emit
      await prisma.preview.update({ where: { id: preview.id }, data: { status: "error", buildCompletedAt: new Date(), url: null, containerName: null } });

      const updated = await prisma.preview.findUnique({ where: { id: preview.id } });
      getIO().emit("preview-status-update", {
        previewId: updated.id,
        projectId: updated.projectId,
        prNumber: updated.prNumber,
        status: updated.status,
        url: updated.url,
        buildStartedAt: updated.buildStartedAt,
        buildCompletedAt: updated.buildCompletedAt,
        containerName: updated.containerName
      });

      try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch (e) {}

      return res.status(500).json({ ok: false, error: "Build failed" });
    }
  } catch (err) {
    console.error("rebuild error:", err);
    return res.status(500).json({ error: "Unexpected error" });
  }
});

/**
 * POST /api/preview/:id/delete
 * Delete preview (stop container + update DB + emit)
 */
router.post("/preview/:id/delete", auth, async (req, res) => {
  try {
    const preview = await prisma.preview.findUnique({
      where: { id: req.params.id },
      include: { project: true }
    });
    if (!preview) return res.status(404).json({ error: "Preview not found" });
    if (preview.project.userId !== req.user.userId) return res.status(403).json({ error: "Not allowed" });

    if (preview.containerName) {
      await removeContainer(preview.containerName);
    }

    await prisma.preview.update({ where: { id: preview.id }, data: { status: "deleted", url: null, containerName: null, buildCompletedAt: new Date() } });

    const updated = await prisma.preview.findUnique({ where: { id: preview.id } });
    getIO().emit("preview-status-update", {
      previewId: updated.id,
      projectId: updated.projectId,
      prNumber: updated.prNumber,
      status: updated.status,
      url: updated.url,
      buildStartedAt: updated.buildStartedAt,
      buildCompletedAt: updated.buildCompletedAt,
      containerName: updated.containerName
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("delete preview error:", err);
    return res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
