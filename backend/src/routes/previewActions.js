// backend/src/routes/previewActions.js
import express from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../db.js";
import { cloneRepo } from "../services/repoService.js";
import { buildPreview, removeContainer } from "../services/dockerService.js";
import { getIO } from "../socket.js";
import fs from "fs";
import { getTierLimits } from "../middleware/tierLimits.js";

const router = express.Router();

function emitScopedStatus(previewId, userId, payload) {
  try {
    getIO()
      .to(`preview:${previewId}`)
      .to(previewId)
      .to(`user:${userId}`)
      .emit("preview-status-update", payload);
  } catch (err) {
    // socket ignore
  }
}

/* ------------------------ AUTH ------------------------ */
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

/* ------------------------ HELPERS ------------------------ */
async function enforceBuildLimit(userId, tier) {
  const limits = getTierLimits(tier);

  const activeBuilds = await prisma.preview.count({
    where: {
      status: "building",
      project: { userId }
    }
  });

  if (activeBuilds >= limits.maxConcurrentBuilds) {
    return {
      allowed: false,
      message: `Tier ${tier} allows only ${limits.maxConcurrentBuilds} concurrent build(s).`
    };
  }

  return { allowed: true };
}

/* ----------------------------------------------------------
   POST /api/preview/:id/rebuild
   Fully rebuild preview WITH tier enforcement
----------------------------------------------------------- */
router.post("/preview/:id/rebuild", auth, async (req, res) => {
  try {
    const previewId = req.params.id;
    const userId = req.user.userId;
    const tier = req.user.tier;

    /* 1️⃣ Validate preview exists & belongs to user */
    const preview = await prisma.preview.findUnique({
      where: { id: previewId },
      include: { project: true }
    });

    if (!preview) return res.status(404).json({ error: "Preview not found" });
    if (preview.project.userId !== userId) {
      return res.status(403).json({ error: "Not allowed" });
    }

    /* 2️⃣ Enforce Tier Build Limits */
    const check = await enforceBuildLimit(userId, tier);
    if (!check.allowed) {
      return res.status(429).json({
        error: "build_limit_reached",
        message: check.message
      });
    }

    /* 3️⃣ Stop previous container if exists */
    if (preview.containerName) {
      await removeContainer(preview.containerName);
    }

    /* 4️⃣ Mark DB as building immediately */
    await prisma.preview.update({
      where: { id: previewId },
      data: {
        status: "building",
        url: null,
        buildStartedAt: new Date(),
        buildCompletedAt: null
      }
    });

    emitScopedStatus(preview.id, userId, {
      previewId: preview.id,
      projectId: preview.projectId,
      prNumber: preview.prNumber,
      status: "building",
      url: null
    });

    /* 5️⃣ Clone repo & Build */
    const repoPath = await cloneRepo({
      repoOwner: preview.project.repoOwner,
      repoName: preview.project.repoName
    });

    try {
      const url = await buildPreview({
        project: preview.project,
        previewId,
        repoPath,
        prNumber: preview.prNumber
      });

      // Cleanup
      try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch {}

      const updated = await prisma.preview.findUnique({
        where: { id: previewId }
      });

      emitScopedStatus(updated.id, userId, {
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
      /* 6️⃣ Build failed → Update DB + Emit error */
      await prisma.preview.update({
        where: { id: previewId },
        data: {
          status: "error",
          buildCompletedAt: new Date(),
          url: null,
          containerName: null
        }
      });

      const updated = await prisma.preview.findUnique({
        where: { id: previewId }
      });

      emitScopedStatus(updated.id, userId, {
        previewId: updated.id,
        projectId: updated.projectId,
        prNumber: updated.prNumber,
        status: updated.status,
        url: updated.url,
        buildStartedAt: updated.buildStartedAt,
        buildCompletedAt: updated.buildCompletedAt
      });

      try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch {}

      return res.status(500).json({ ok: false, error: "Build failed" });
    }

  } catch (err) {
    console.error("rebuild error:", err);
    return res.status(500).json({ error: "Unexpected error" });
  }
});

/* ----------------------------------------------------------
   POST /api/preview/:id/delete
   Delete preview with safe container removal
----------------------------------------------------------- */
router.post("/preview/:id/delete", auth, async (req, res) => {
  try {
    const previewId = req.params.id;
    const userId = req.user.userId;

    const preview = await prisma.preview.findUnique({
      where: { id: previewId },
      include: { project: true }
    });

    if (!preview) return res.status(404).json({ error: "Preview not found" });
    if (preview.project.userId !== userId) {
      return res.status(403).json({ error: "Not allowed" });
    }

    if (preview.containerName) {
      await removeContainer(preview.containerName);
    }

    await prisma.preview.update({
      where: { id: previewId },
      data: {
        status: "deleted",
        url: null,
        containerName: null,
        buildCompletedAt: new Date()
      }
    });

    const updated = await prisma.preview.findUnique({
      where: { id: previewId }
    });

    emitScopedStatus(updated.id, userId, {
      previewId: updated.id,
      projectId: updated.projectId,
      prNumber: updated.prNumber,
      status: updated.status,
      url: updated.url,
      buildStartedAt: updated.buildStartedAt,
      buildCompletedAt: updated.buildCompletedAt
    });

    return res.json({ ok: true });

  } catch (err) {
    console.error("delete preview error:", err);
    return res.status(500).json({ error: "Delete failed" });
  }
});

export default router;
