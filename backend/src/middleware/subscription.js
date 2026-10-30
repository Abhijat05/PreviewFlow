import { prisma } from "../db.js";
import { requireAuth } from "./auth.js";
import { getTierLimits } from "./tierLimits.js";

/**
 * Unified authentication & subscription middleware
 * Maps cleanly to requireAuth to ensure fresh DB tier claims
 */
export const requireSubscription = requireAuth;

/**
 * Tier-based Repo Connect quota (called inside connect route)
 */
export async function assertRepoQuota(user) {
  const limits = getTierLimits(user?.tier);
  const max = limits.maxProjects;
  if (!Number.isFinite(max)) return true;

  const count = await prisma.project.count({ where: { userId: user.id } });
  if (count >= max) {
    const err = new Error("Tier " + (user.tier || "FREE") + " allows max " + max + " connected repos");
    err.code = "REPO_QUOTA_EXCEEDED";
    throw err;
  }

  return true;
}

/**
 * Tier-based Preview quota
 */
export async function assertPreviewQuota(user) {
  const limits = getTierLimits(user?.tier);
  const max = limits.maxPreviews;
  if (!Number.isFinite(max)) return true;

  const live = await prisma.preview.count({
    where: { project: { userId: user.id }, status: "live" }
  });

  if (live >= max) {
    const err = new Error("Tier " + (user.tier || "FREE") + " allows max " + max + " live previews");
    err.code = "PREVIEW_QUOTA_EXCEEDED";
    throw err;
  }

  return true;
}

/**
 * Allowed port pools per tier (exclusive pool for PRO, ENTERPRISE)
 */
export const tierPortPools = {
  FREE: { min: 5500, max: 5700, exclusive: false },
  HOBBY: { min: 5500, max: 5800, exclusive: false },
  PRO: { min: 5000, max: 5400, exclusive: true },
  ENTERPRISE: { min: 4001, max: 4800, exclusive: true }
};

export function getPortPoolForTier(tier) {
  return tierPortPools[tier] || tierPortPools.FREE;
}
