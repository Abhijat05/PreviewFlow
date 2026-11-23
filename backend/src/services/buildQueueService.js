// backend/src/services/buildQueueService.js
import { prisma as defaultPrisma } from "../db.js";

export const TERMINAL_BUILD_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "SUPERSEDED",
  "CANCELLED"
]);

/**
 * Enqueues a new build job for a preview.
 * Automatically supersedes any currently QUEUED builds for this preview,
 * calculates the next buildNumber sequentially, and updates the Preview record.
 */
export async function enqueueBuild({
  previewId,
  commitSha,
  branch,
  source = "WEBHOOK_SYNC",
  commitMessage = null,
  maxAttempts = 3,
  client = defaultPrisma
}) {
  if (!previewId) {
    throw new Error("previewId is required to enqueue build");
  }
  if (!commitSha) {
    throw new Error("commitSha is required to enqueue build");
  }
  if (!branch) {
    throw new Error("branch is required to enqueue build");
  }

  // 1. Supersede any existing queued builds for this preview
  await client.build.updateMany({
    where: {
      previewId,
      status: "QUEUED"
    },
    data: {
      status: "SUPERSEDED",
      completedAt: new Date(),
      errorMessage: "Superseded by newer queued build"
    }
  });

  // 2. Determine next buildNumber
  const latestBuild = await client.build.findFirst({
    where: { previewId },
    orderBy: { buildNumber: "desc" }
  });
  const nextBuildNumber = (latestBuild?.buildNumber || 0) + 1;

  // 3. Create the queued build record
  const build = await client.build.create({
    data: {
      previewId,
      buildNumber: nextBuildNumber,
      commitSha,
      commitMessage,
      branch,
      source,
      status: "QUEUED",
      attempt: 1,
      maxAttempts: Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 3,
      queuedAt: new Date()
    }
  });

  // 4. Update preview with latest build coordinates
  await client.preview.update({
    where: { id: previewId },
    data: {
      latestBuildId: build.id,
      desiredCommitSha: commitSha,
      buildNumber: nextBuildNumber
    }
  });

  return build;
}

/**
 * Fetches a single build by ID.
 */
export async function getBuildById(buildId, { client = defaultPrisma, include = { preview: true } } = {}) {
  if (!buildId) return null;
  return client.build.findUnique({
    where: { id: buildId },
    include
  });
}

/**
 * Retrieves paginated build history for a preview ordered newest first.
 */
export async function getBuildHistory(
  previewId,
  { limit = 20, offset = 0, client = defaultPrisma } = {}
) {
  if (!previewId) return [];
  return client.build.findMany({
    where: { previewId },
    orderBy: { buildNumber: "desc" },
    take: limit,
    skip: offset
  });
}

/**
 * Cancels a non-terminal build and detaches it if it is the preview's active build.
 */
export async function cancelBuild(
  buildId,
  { reason = "Build cancelled", client = defaultPrisma } = {}
) {
  const existing = await client.build.findUnique({ where: { id: buildId } });
  if (!existing) {
    throw new Error(`Build ${buildId} not found`);
  }

  if (TERMINAL_BUILD_STATUSES.has(existing.status)) {
    throw new Error(`Cannot cancel build in terminal state ${existing.status}`);
  }

  const updated = await client.build.update({
    where: { id: buildId },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      errorMessage: reason
    }
  });

  // If this build was marked as active on the preview, clear activeBuildId
  if (existing.previewId) {
    const preview = await client.preview.findFirst({
      where: { id: existing.previewId, activeBuildId: buildId }
    });
    if (preview) {
      await client.preview.update({
        where: { id: existing.previewId },
        data: { activeBuildId: null }
      });
    }
  }

  return updated;
}

/**
 * Marks a build as superseded by a newer build.
 */
export async function markBuildSuperseded(
  buildId,
  { supersededByBuildId, client = defaultPrisma } = {}
) {
  return client.build.update({
    where: { id: buildId },
    data: {
      status: "SUPERSEDED",
      completedAt: new Date(),
      errorMessage: supersededByBuildId
        ? `Superseded by ${supersededByBuildId}`
        : "Superseded by newer build"
    }
  });
}
