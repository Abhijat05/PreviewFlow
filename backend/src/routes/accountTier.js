// backend/src/routes/accountTier.js
import express from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getTierLimits, compareTier, normalizeTier } from "../middleware/tierLimits.js";
import { removeContainer } from "../services/dockerService.js";

const router = express.Router();

const VALID_TIERS = ["FREE", "HOBBY", "PRO", "ENTERPRISE"];

/**
 * Core handler for changing account tier.
 * Exported for testability.
 */
export async function handleChangeTier(req, res) {
  try {
    const { newTier, confirmCleanup, paymentToken } = req.body || {};
    const user = req.auth?.user;

    if (!user || !user.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!newTier || typeof newTier !== "string") {
      return res.status(400).json({ error: "newTier is required" });
    }

    const upperTier = newTier.trim().toUpperCase();
    if (!VALID_TIERS.includes(upperTier)) {
      return res.status(400).json({ error: "Invalid tier", allowed: VALID_TIERS });
    }

    const targetTier = upperTier;
    const currentTier = normalizeTier(user.tier);
    const tierComparison = compareTier(currentTier, targetTier);
    const limits = getTierLimits(targetTier);

    // If not actually changing, just echo back
    if (tierComparison === 0) {
      return res.json({
        needsCleanup: false,
        changed: false,
        currentTier,
        newTier: targetTier,
      });
    }

    // If upgrading (target > current) → enforce payment authorization
    if (tierComparison === 1) {
      const adminToken = req.headers?.["x-admin-token"];
      const clientPaymentToken = paymentToken || req.headers?.["x-payment-token"];
      const isDev = process.env.NODE_ENV !== "production";
      const selfServeAllowed = process.env.ALLOW_SELF_SERVE_UPGRADES === "true" || isDev;
      const hasAdminAuth = Boolean(process.env.ADMIN_SECRET && adminToken === process.env.ADMIN_SECRET);

      if (!selfServeAllowed && !hasAdminAuth && !clientPaymentToken) {
        return res.status(402).json({
          error: "payment_required",
          message: `Upgrades to ${targetTier} require valid payment verification or admin authorization.`
        });
      }

      const updatedUser = await prisma.user.update({
        where: { id: user.id },
        data: { tier: targetTier },
      });

      const token = jwt.sign(
        {
          userId: updatedUser.id,
          accessToken: req.auth?.accessToken,
          tier: updatedUser.tier,
        },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );

      return res.json({
        needsCleanup: false,
        changed: true,
        currentTier,
        newTier: targetTier,
        token,
      });
    }

    // From here on → it's a downgrade (target < current)
    // We need to see what must be deleted to fit new limits.
    const maxProjects = limits.maxProjects;
    const maxPreviews = limits.maxPreviews;

    const projects = await prisma.project.findMany({
      where: { userId: user.id },
      include: { previews: true },
    });

    const totalPreviews = projects.reduce(
      (acc, p) => acc + p.previews.length,
      0
    );

    // Decide which projects to keep vs delete
    let projectsToKeep = projects;
    let projectsToDelete = [];

    if (Number.isFinite(maxProjects) && projects.length > maxProjects) {
      projectsToKeep = projects.slice(0, maxProjects);
      projectsToDelete = projects.slice(maxProjects);
    }

    // Previews inside projects we're keeping
    const previewsInKeptProjects = projectsToKeep.flatMap((p) =>
      p.previews.map((pre) => ({
        ...pre,
        projectId: p.id,
      }))
    );

    // Previews inside projects to delete
    const previewsInDeletedProjects = projectsToDelete.flatMap((p) =>
      p.previews.map((pre) => ({
        ...pre,
        projectId: p.id,
      }))
    );

    // Among kept projects, enforce maxPreviews limit
    let previewsToDeleteFromKept = [];
    if (Number.isFinite(maxPreviews) && previewsInKeptProjects.length > maxPreviews) {
      previewsToDeleteFromKept = previewsInKeptProjects.slice(maxPreviews);
    }

    // Combined deletions
    const allPreviewsToDelete = [
      ...previewsInDeletedProjects,
      ...previewsToDeleteFromKept,
    ];

    const projectIdsToDelete = projectsToDelete.map((p) => p.id);
    const previewIdsToDelete = allPreviewsToDelete.map((p) => p.id);

    const responseSummary = {
      needsCleanup:
        projectIdsToDelete.length > 0 || previewIdsToDelete.length > 0,
      currentTier,
      newTier: targetTier,
      totalProjects: projects.length,
      totalPreviews,
      willDeleteProjects: projectsToDelete.map((p) => ({
        id: p.id,
        repoOwner: p.repoOwner,
        repoName: p.repoName,
      })),
      willDeletePreviews: allPreviewsToDelete.map((pre) => ({
        id: pre.id,
        projectId: pre.projectId,
        prNumber: pre.prNumber,
        status: pre.status,
      })),
    };

    // If cleanup is needed but the user hasn't confirmed yet → dry-run response
    if (responseSummary.needsCleanup && !confirmCleanup) {
      return res.json(responseSummary);
    }

    // If no cleanup needed → just update tier
    if (!responseSummary.needsCleanup) {
      const updatedUser = await prisma.user.update({
        where: { id: user.id },
        data: { tier: targetTier },
      });

      const token = jwt.sign(
        {
          userId: updatedUser.id,
          accessToken: req.auth?.accessToken,
          tier: updatedUser.tier,
        },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );

      return res.json({
        ...responseSummary,
        needsCleanup: false,
        changed: true,
        token,
        deletedProjectsCount: 0,
        deletedPreviewsCount: 0,
      });
    }

    // Cleanup has been confirmed → perform deletions + tier update
    // 1. Stop containers for previews that will be deleted (best-effort)
    for (const pre of allPreviewsToDelete) {
      if (pre.containerName) {
        try {
          await removeContainer(pre.containerName);
        } catch (e) {
          console.error(
            `Failed to remove container for preview ${pre.id}:`,
            e.message
          );
        }
      }
    }

    // 2. Delete preview metrics first, then previews, then projects in transaction
    await prisma.$transaction(async (tx) => {
      let allPreviewIds = [...previewIdsToDelete];
      if (projectIdsToDelete.length > 0) {
        const projectPreviews = await tx.preview.findMany({
          where: { projectId: { in: projectIdsToDelete } },
          select: { id: true },
        });
        allPreviewIds = [...new Set([...allPreviewIds, ...projectPreviews.map((p) => p.id)])];
      }

      if (allPreviewIds.length > 0) {
        // Cascade delete child metrics first to satisfy foreign key integrity
        await tx.previewMetric.deleteMany({
          where: { previewId: { in: allPreviewIds } },
        });

        await tx.preview.deleteMany({
          where: { id: { in: allPreviewIds } },
        });
      }

      if (projectIdsToDelete.length > 0) {
        await tx.project.deleteMany({
          where: { id: { in: projectIdsToDelete } },
        });
      }

      await tx.user.update({
        where: { id: user.id },
        data: { tier: targetTier },
      });
    });

    const token = jwt.sign(
      {
        userId: user.id,
        accessToken: req.auth?.accessToken,
        tier: targetTier,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      ...responseSummary,
      needsCleanup: false,
      changed: true,
      token,
      deletedProjectsCount: projectIdsToDelete.length,
      deletedPreviewsCount: previewIdsToDelete.length,
    });
  } catch (err) {
    console.error("change-tier error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
}

router.post("/change-tier", requireAuth, handleChangeTier);

export default router;
