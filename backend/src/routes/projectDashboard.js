// backend/src/routes/projectDashboard.js
import express from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { serializeProjectSafe } from "../services/cryptoService.js";
import { logger } from "../utils/logger.js";

const router = express.Router();

const AUDIT_ACTION_LABELS = {
  AUTH_LOGIN: "Signed in via GitHub",
  PROJECT_CONNECTED: "Connected repository",
  WEBHOOK_CREATED: "Registered GitHub webhook",
  WEBHOOK_CREATE_FAILED: "Webhook registration failed",
  PREVIEW_REBUILD_TRIGGERED: "Triggered manual redeploy",
  PREVIEW_CANCELLED: "Cancelled active build",
  PREVIEW_DELETED: "Deleted preview deployment",
  TIER_UPGRADED: "Upgraded plan tier",
  TIER_DOWNGRADED: "Downgraded plan tier",
  FORK_PR_BLOCKED: "Blocked external fork PR build"
};

function computeDeploymentStats({ projects, builds, totalBuilds, completedBuilds, failedBuilds }) {
  let livePreviews = 0;
  let buildingPreviews = 0;
  let errorPreviews = 0;
  let archivedPreviews = 0;
  let activePreviews = 0;

  for (const proj of projects) {
    for (const pre of proj.previews || []) {
      const s = String(pre.status || "").toLowerCase();
      if (s === "deleted") {
        archivedPreviews++;
      } else {
        activePreviews++;
        if (s === "live" || s === "ready") livePreviews++;
        else if (s === "building") buildingPreviews++;
        else if (s === "error") errorPreviews++;
      }
    }
  }

  const finishedCount = completedBuilds + failedBuilds;
  const successRate =
    finishedCount > 0 ? Math.round((completedBuilds / finishedCount) * 100) : null;

  const durations = builds
    .filter((b) => b.status === "COMPLETED" && b.startedAt && b.completedAt)
    .map((b) => (new Date(b.completedAt).getTime() - new Date(b.startedAt).getTime()) / 1000)
    .filter((sec) => Number.isFinite(sec) && sec >= 0);

  const avgBuildDurationSec =
    durations.length > 0
      ? Math.round((durations.reduce((sum, sec) => sum + sec, 0) / durations.length) * 10) / 10
      : null;

  return {
    totalProjects: projects.length,
    totalPreviews: activePreviews,
    livePreviews,
    buildingPreviews,
    errorPreviews,
    archivedPreviews,
    totalBuilds,
    completedBuilds,
    failedBuilds,
    successRate,
    avgBuildDurationSec
  };
}

function formatRecentBuild(build) {
  const startMs = build.startedAt ? new Date(build.startedAt).getTime() : null;
  const endMs = build.completedAt
    ? new Date(build.completedAt).getTime()
    : build.failedAt
      ? new Date(build.failedAt).getTime()
      : null;
  const durationSec =
    startMs !== null && endMs !== null && endMs >= startMs
      ? Math.round(((endMs - startMs) / 1000) * 10) / 10
      : null;

  const proj = build.preview?.project;
  return {
    id: build.id,
    previewId: build.previewId,
    buildNumber: build.buildNumber,
    commitSha: build.commitSha,
    commitMessage: build.commitMessage || null,
    branch: build.branch,
    source: build.source,
    status: build.status,
    queuedAt: build.queuedAt,
    startedAt: build.startedAt,
    completedAt: build.completedAt,
    failedAt: build.failedAt,
    durationSec,
    errorMessage: build.errorMessage || null,
    prNumber: build.preview?.prNumber ?? null,
    previewUrl: build.preview?.url || null,
    projectId: proj?.id || null,
    repoOwner: proj?.repoOwner || null,
    repoName: proj?.repoName || null,
    framework: proj?.framework || null
  };
}

function buildActivityTimeline(formattedBuilds, auditEntries) {
  const items = [];

  for (const audit of auditEntries || []) {
    if (!audit?.action) continue;
    items.push({
      id: `audit-${audit.id}`,
      kind: "audit",
      action: audit.action,
      title: AUDIT_ACTION_LABELS[audit.action] || audit.action.replace(/_/g, " ").toLowerCase(),
      status: audit.status || "SUCCESS",
      resourceType: audit.resourceType || null,
      resourceId: audit.resourceId || null,
      metadata: audit.metadata || null,
      timestamp: audit.createdAt
    });
  }

  for (const b of formattedBuilds) {
    const labelTarget = b.repoName && b.prNumber ? `${b.repoName} PR #${b.prNumber}` : `Build #${b.buildNumber}`;
    let title = `Build queued for ${labelTarget}`;
    if (b.status === "COMPLETED") title = `Deployment live for ${labelTarget}`;
    else if (b.status === "FAILED") title = `Build failed for ${labelTarget}`;
    else if (b.status === "RUNNING") title = `Building ${labelTarget}`;
    else if (b.status === "CANCELLED") title = `Build cancelled for ${labelTarget}`;
    else if (b.status === "SUPERSEDED") title = `Superseded build on ${labelTarget}`;

    items.push({
      id: `build-${b.id}`,
      kind: "build",
      action: `BUILD_${b.status}`,
      title,
      status: b.status === "FAILED" ? "FAILURE" : b.status === "CANCELLED" ? "DENIED" : "SUCCESS",
      previewId: b.previewId,
      prNumber: b.prNumber,
      repoOwner: b.repoOwner,
      repoName: b.repoName,
      commitSha: b.commitSha,
      durationSec: b.durationSec,
      timestamp: b.completedAt || b.failedAt || b.startedAt || b.queuedAt
    });
  }

  return items
    .filter((item) => item.timestamp)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 15);
}

router.get("/projects", requireAuth, async (req, res) => {
  try {
    const projects = await prisma.project.findMany({
      where: { userId: req.auth.userId },
      include: {
        previews: {
          orderBy: { prNumber: "desc" }
        }
      }
    });

    res.json((projects || []).map(serializeProjectSafe));
  } catch (err) {
    logger.error("Failed to load projects", { err });
    res.status(500).json({ error: err.message || "Failed to load projects" });
  }
});

/**
 * GET /api/dashboard/overview
 * Returns tenant-scoped projects, deployment statistics, recent builds, and activity timeline.
 */
router.get("/dashboard/overview", requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const projects =
      (await prisma.project.findMany({
        where: { userId },
        include: {
          previews: {
            orderBy: { prNumber: "desc" }
          }
        }
      })) || [];

    const safeProjects = projects.map(serializeProjectSafe);

    const recentBuildsRaw =
      typeof prisma.build?.findMany === "function"
        ? await prisma.build
            .findMany({
              where: { preview: { project: { userId } } },
              include: {
                preview: {
                  select: {
                    id: true,
                    prNumber: true,
                    url: true,
                    project: {
                      select: { id: true, repoOwner: true, repoName: true, framework: true }
                    }
                  }
                }
              },
              orderBy: { queuedAt: "desc" },
              take: 12
            })
            .catch(() => [])
        : [];

    const [totalBuildsDb, completedDb, failedDb, auditEntries] = await Promise.all([
      typeof prisma.build?.count === "function"
        ? prisma.build.count({ where: { preview: { project: { userId } } } }).catch(() => null)
        : Promise.resolve(null),
      typeof prisma.build?.count === "function"
        ? prisma.build
            .count({ where: { status: "COMPLETED", preview: { project: { userId } } } })
            .catch(() => null)
        : Promise.resolve(null),
      typeof prisma.build?.count === "function"
        ? prisma.build
            .count({ where: { status: "FAILED", preview: { project: { userId } } } })
            .catch(() => null)
        : Promise.resolve(null),
      typeof prisma.auditLog?.findMany === "function"
        ? prisma.auditLog
            .findMany({
              where: { actorUserId: userId },
              orderBy: { createdAt: "desc" },
              take: 12
            })
            .catch(() => [])
        : Promise.resolve([])
    ]);

    const formattedBuilds = (recentBuildsRaw || []).map(formatRecentBuild);

    const completedFallback = formattedBuilds.filter((b) => b.status === "COMPLETED").length;
    const failedFallback = formattedBuilds.filter((b) => b.status === "FAILED").length;
    const completedBuilds =
      typeof completedDb === "number" && (completedDb > 0 || completedFallback === 0)
        ? completedDb
        : completedFallback;
    const failedBuilds =
      typeof failedDb === "number" && (failedDb > 0 || failedFallback === 0)
        ? failedDb
        : failedFallback;
    const totalBuilds =
      typeof totalBuildsDb === "number" && (totalBuildsDb > 0 || formattedBuilds.length === 0)
        ? totalBuildsDb
        : formattedBuilds.length;

    const stats = computeDeploymentStats({
      projects: safeProjects,
      builds: formattedBuilds,
      totalBuilds,
      completedBuilds,
      failedBuilds
    });

    const activity = buildActivityTimeline(formattedBuilds, auditEntries);

    return res.json({
      projects: safeProjects,
      stats,
      recentBuilds: formattedBuilds,
      activity
    });
  } catch (err) {
    logger.error("Failed to load dashboard overview", { err });
    return res.status(500).json({ error: "failed_to_load_dashboard" });
  }
});

export default router;
