// backend/src/services/quotaService.js
import { prisma as defaultPrisma } from "../db.js";
import { getTierLimits, normalizeTier } from "../middleware/tierLimits.js";

/**
 * Unified tenant quota enforcement for builds and live previews.
 * Used across manual rebuilds and GitHub webhook ingress so neither path can bypass limits.
 */
export async function enforceBuildQuota({
  userId,
  tier = "FREE",
  previewId = null,
  isNewPreview = false,
  client = defaultPrisma
}) {
  const normalizedTier = normalizeTier(tier);
  const limits = getTierLimits(normalizedTier);

  if (!userId) {
    return { allowed: true };
  }

  // 1. Check total live + building preview count when creating a new PR preview
  if (isNewPreview && Number.isFinite(limits.maxPreviews)) {
    const activePreviewCount = await client.preview.count({
      where: {
        status: { in: ["live", "building"] },
        project: { userId }
      }
    });

    if (activePreviewCount >= limits.maxPreviews) {
      return {
        allowed: false,
        code: "preview_quota_exceeded",
        message: `Tier ${normalizedTier} allows only ${limits.maxPreviews} active preview(s).`
      };
    }
  }

  // 2. Enforce concurrent active build limit across other previews
  if (Number.isFinite(limits.maxConcurrentBuilds)) {
    let activeDurableBuilds = 0;
    try {
      const builds = await client.build.findMany({
        where: {
          preview: { project: { userId } }
        }
      });
      activeDurableBuilds = (builds || []).filter(
        (b) =>
          (b.status === "QUEUED" || b.status === "RUNNING" || b.status === "RETRYING") &&
          (!previewId || b.previewId !== previewId)
      ).length;
    } catch {
      // Fallback safely if build table unavailable/unmocked
      activeDurableBuilds = 0;
    }

    const buildingPreviewCount = await client.preview.count({
      where: {
        status: "building",
        project: { userId }
      }
    });

    const effectiveActiveBuilds = Math.max(activeDurableBuilds, buildingPreviewCount);
    if (effectiveActiveBuilds >= limits.maxConcurrentBuilds) {
      return {
        allowed: false,
        code: "build_limit_reached",
        message: `Tier ${normalizedTier} allows only ${limits.maxConcurrentBuilds} concurrent build(s).`
      };
    }
  }

  return { allowed: true };
}
