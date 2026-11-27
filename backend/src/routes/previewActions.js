// backend/src/routes/previewActions.js
import express from "express";
import { prisma } from "../db.js";
import { getTierLimits } from "../middleware/tierLimits.js";
import { requireAuth } from "../middleware/auth.js";
import {
  triggerBuild,
  cancelPreviewBuilds,
  closeOrDeletePreview,
  emitPreviewStatus
} from "../services/buildOrchestrator.js";
import { getBuildHistory } from "../services/buildQueueService.js";
import { enforceBuildQuota } from "../services/quotaService.js";

const router = express.Router();

export function emitScopedStatus(previewId, userId, payload) {
  emitPreviewStatus(previewId, userId, payload);
}

/* ------------------------ HELPERS ------------------------ */
export async function enforceBuildLimit(userId, tier, { previewId = null, isNewPreview = false } = {}) {
  return enforceBuildQuota({ userId, tier, previewId, isNewPreview });
}

let customAsyncRebuildWorker = null;

export function setAsyncRebuildWorker(worker) {
  customAsyncRebuildWorker = worker;
}

export function resetAsyncRebuildWorker() {
  customAsyncRebuildWorker = null;
}

/* ----------------------------------------------------------
   POST /api/preview/:id/rebuild
   Enqueue rebuild via unified build orchestrator
----------------------------------------------------------- */
export async function handleRebuildPreview(req, res) {
  try {
    const previewId = req.params?.id;
    const userId = req.user?.userId;
    const tier = req.user?.tier;

    if (!previewId) {
      return res.status(400).json({ error: "Missing preview id" });
    }

    /* 1. Validate preview exists & belongs to user */
    const preview = await prisma.preview.findUnique({
      where: { id: previewId },
      include: { project: { include: { user: true } } }
    });

    if (!preview) return res.status(404).json({ error: "Preview not found" });
    if (preview.project.userId !== userId) {
      return res.status(403).json({ error: "Not allowed" });
    }

    /* 2. Concurrency protection unless force=true */
    const forceRebuild = Boolean(req.body?.force);
    if (preview.status === "building" && !forceRebuild) {
      return res.status(409).json({
        error: "build_already_in_progress",
        message: "A build is already currently in progress for this preview."
      });
    }

    /* 3. Enforce Unified Tier Build & Preview Quotas */
    const check = await enforceBuildLimit(userId, tier, {
      previewId: preview.id,
      isNewPreview: preview.status === "deleted"
    });
    if (!check.allowed) {
      return res.status(429).json({
        error: check.code || "build_limit_reached",
        message: check.message
      });
    }

    /* 4. Custom worker hook preserved for route isolation tests */
    if (customAsyncRebuildWorker) {
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

      res.status(202).json({
        ok: true,
        status: "building",
        message: "Build started successfully",
        previewId
      });

      (async () => {
        try {
          await customAsyncRebuildWorker({ preview, userId, previewId });
        } catch (e) {
          console.error("Async rebuild worker uncaught error:", e);
        }
      })();
      return;
    }

    /* 5. Enqueue via unified orchestrator */
    const { build } = await triggerBuild({
      project: preview.project,
      prNumber: preview.prNumber,
      commitSha: req.body?.commitSha || null,
      branch: req.body?.branch || null,
      source: "MANUAL_REBUILD"
    });

    return res.status(202).json({
      ok: true,
      status: "building",
      message: "Build started successfully",
      previewId,
      buildId: build.id,
      buildNumber: build.buildNumber
    });
  } catch (err) {
    console.error("rebuild error:", err);
    return res.status(500).json({ error: "Unexpected error" });
  }
}

/* ----------------------------------------------------------
   POST /api/preview/:id/cancel
   Cancel active or queued builds for a preview
----------------------------------------------------------- */
export async function handleCancelPreviewBuild(req, res) {
  try {
    const previewId = req.params?.id;
    const userId = req.user?.userId;

    if (!previewId) {
      return res.status(400).json({ error: "Missing preview id" });
    }

    const preview = await prisma.preview.findUnique({
      where: { id: previewId },
      include: { project: true }
    });

    if (!preview) return res.status(404).json({ error: "Preview not found" });
    if (preview.project.userId !== userId) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const result = await cancelPreviewBuilds({
      previewId,
      reason: req.body?.reason || "Build cancelled by user",
      userId
    });

    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("cancel preview build error:", err);
    return res.status(500).json({ error: "Cancel failed" });
  }
}

/* ----------------------------------------------------------
   POST /api/preview/:id/delete
   Delete preview with unified build cancellation & container teardown
----------------------------------------------------------- */
export async function handleDeletePreview(req, res) {
  try {
    const previewId = req.params?.id;
    const userId = req.user?.userId;

    const preview = await prisma.preview.findUnique({
      where: { id: previewId },
      include: { project: true }
    });

    if (!preview) return res.status(404).json({ error: "Preview not found" });
    if (preview.project.userId !== userId) {
      return res.status(403).json({ error: "Not allowed" });
    }

    await closeOrDeletePreview({
      previewId,
      project: preview.project,
      prNumber: preview.prNumber,
      reason: "Preview deleted by user",
      userId
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("delete preview error:", err);
    return res.status(500).json({ error: "Delete failed" });
  }
}

/* ----------------------------------------------------------
   GET /api/preview/:id/builds
   Retrieve ordered build history for an authorized preview
----------------------------------------------------------- */
export async function handleGetPreviewBuilds(req, res) {
  try {
    const previewId = req.params?.id;
    const userId = req.user?.userId;
    const limit = Math.min(Math.max(Number.parseInt(req.query?.limit, 10) || 20, 1), 100);
    const offset = Math.max(Number.parseInt(req.query?.offset, 10) || 0, 0);

    if (!previewId) {
      return res.status(400).json({ error: "Missing preview id" });
    }

    const preview = await prisma.preview.findUnique({
      where: { id: previewId },
      include: { project: true }
    });

    if (!preview) return res.status(404).json({ error: "Preview not found" });
    if (preview.project.userId !== userId) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const builds = await getBuildHistory(previewId, { limit, offset });

    return res.json({
      previewId,
      activeBuildId: preview.activeBuildId || null,
      latestBuildId: preview.latestBuildId || null,
      desiredCommitSha: preview.desiredCommitSha || null,
      deployedCommitSha: preview.deployedCommitSha || null,
      builds
    });
  } catch (err) {
    console.error("get preview builds error:", err);
    return res.status(500).json({ error: "Failed to load build history" });
  }
}

router.get("/preview/:id/builds", requireAuth, handleGetPreviewBuilds);
router.post("/preview/:id/rebuild", requireAuth, handleRebuildPreview);
router.post("/preview/:id/cancel", requireAuth, handleCancelPreviewBuild);
router.post("/preview/:id/delete", requireAuth, handleDeletePreview);

export default router;
