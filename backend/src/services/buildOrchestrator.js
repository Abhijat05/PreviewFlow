// backend/src/services/buildOrchestrator.js
import fs from "fs";
import { prisma as defaultPrisma } from "../db.js";
import { getIO } from "../socket.js";
import { cloneRepo } from "./repoService.js";
import { buildPreview, removeContainer, removeImage, releasePortInMemory } from "./dockerService.js";
import { releasePort, releasePreviewPorts } from "./portService.js";
import { enqueueBuild, TERMINAL_BUILD_STATUSES } from "./buildQueueService.js";
import { decryptSecret } from "./cryptoService.js";

/**
 * In-process registry of running build AbortControllers keyed by buildId.
 * Enables immediate cooperative cancellation when superseded or cancelled.
 */
const activeJobControllers = new Map();

export class BuildAbortedError extends Error {
  constructor(message = "Build aborted", reasonStatus = "CANCELLED") {
    super(message);
    this.name = "AbortError";
    this.isAborted = true;
    this.reasonStatus = reasonStatus;
  }
}

export function getActiveBuildAbortController(buildId) {
  return activeJobControllers.get(buildId) || null;
}

export function getActiveBuildCount() {
  return activeJobControllers.size;
}

/**
 * Immediately aborts an in-process running build via its AbortController.
 */
export function abortActiveBuild(buildId, reason = "Build cancelled") {
  const entry = activeJobControllers.get(buildId);
  if (entry && !entry.controller.signal.aborted) {
    entry.reason = reason;
    entry.controller.abort();
    return true;
  }
  return false;
}

/**
 * Emits preview lifecycle updates over Socket.IO to preview and owner rooms.
 */
export function emitPreviewStatus(previewId, userId, payload) {
  try {
    const io = getIO();
    const target = userId
      ? io.to(`preview:${previewId}`).to(previewId).to(`user:${userId}`)
      : io.to(`preview:${previewId}`).to(previewId);
    target.emit("preview-status-update", payload);
  } catch {
    // Socket may be uninitialized in worker-only or test modes
  }
}

function emitSupersededEvent(previewId, userId, payload) {
  try {
    const io = getIO();
    const target = userId
      ? io.to(`preview:${previewId}`).to(previewId).to(`user:${userId}`)
      : io.to(`preview:${previewId}`).to(previewId);
    target.emit("build-superseded", payload);
  } catch {
    // ignore socket errors
  }
}

/**
 * Best-effort lookup of a pull request's current head SHA via GitHub REST API.
 */
export async function resolvePRHeadSha({ repoOwner, repoName, prNumber, accessToken }) {
  if (!repoOwner || !repoName || !prNumber) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  if (timeout.unref) timeout.unref();

  try {
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "PreviewFlow-Orchestrator"
    };
    const plainToken = decryptSecret(accessToken);
    if (plainToken) {
      headers.Authorization = `Bearer ${plainToken}`;
    }

    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/pulls/${prNumber}`,
      { headers, signal: controller.signal }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.head?.sha || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Marks any active RUNNING or RETRYING builds for a preview as SUPERSEDED
 * and aborts any matching local worker tasks.
 */
export async function supersedeActiveBuilds(
  previewId,
  { reason = "Superseded by newer build", supersededByBuildId = null, userId = null, client = defaultPrisma } = {}
) {
  const existingBuilds = await client.build.findMany({
    where: { previewId }
  });

  const activeBuilds = (existingBuilds || []).filter(
    (b) => b.status === "RUNNING" || b.status === "RETRYING" || b.status === "QUEUED"
  );

  const supersededIds = [];
  for (const b of activeBuilds) {
    await client.build.update({
      where: { id: b.id },
      data: {
        status: "SUPERSEDED",
        cancelledAt: new Date(),
        errorMessage: supersededByBuildId
          ? `Superseded by ${supersededByBuildId}`
          : reason
      }
    });
    supersededIds.push(b.id);
    abortActiveBuild(b.id, reason);

    emitSupersededEvent(previewId, userId, {
      previewId,
      supersededBuildId: b.id,
      newBuildId: supersededByBuildId
    });
  }

  return supersededIds;
}

/**
 * Unified entry point to trigger a build (used by GitHub webhooks, manual rebuilds, and dev simulator).
 * Ensures preview exists, supersedes any in-flight/queued builds, and enqueues a durable Build job.
 */
export async function triggerBuild({
  project,
  prNumber,
  commitSha = null,
  branch = null,
  source = "WEBHOOK_SYNC",
  commitMessage = null,
  client = defaultPrisma
}) {
  if (!project || !project.id) {
    throw new Error("project with valid id is required to trigger build");
  }
  if (!prNumber) {
    throw new Error("prNumber is required to trigger build");
  }

  // Upsert preview row cleanly; keep active deployment fields intact until new build passes
  const preview = await client.preview.upsert({
    where: { projectId_prNumber: { projectId: project.id, prNumber } },
    update: {
      status: "building",
      buildStartedAt: new Date(),
      buildCompletedAt: null
    },
    create: {
      projectId: project.id,
      prNumber,
      status: "building",
      buildStartedAt: new Date()
    }
  });

  // Resolve commit SHA: explicit -> stored desired/deployed -> GitHub API -> pr-head fallback
  let resolvedSha = commitSha || preview.desiredCommitSha || preview.deployedCommitSha;
  if (!resolvedSha) {
    resolvedSha = await resolvePRHeadSha({
      repoOwner: project.repoOwner,
      repoName: project.repoName,
      prNumber,
      accessToken: project.accessToken
    });
  }
  resolvedSha = resolvedSha || "pr-head";

  const resolvedBranch = branch || `pr-${prNumber}`;

  // Supersede any currently RUNNING or RETRYING builds for this preview
  await supersedeActiveBuilds(preview.id, {
    reason: `Superseded by ${source} build for commit ${resolvedSha}`,
    userId: project.userId,
    client
  });

  // Enqueue durable build job in PostgreSQL (also supersedes any remaining QUEUED builds)
  const build = await enqueueBuild({
    previewId: preview.id,
    commitSha: resolvedSha,
    branch: resolvedBranch,
    source,
    commitMessage,
    client
  });

  emitPreviewStatus(preview.id, project.userId, {
    previewId: preview.id,
    projectId: project.id,
    prNumber,
    buildId: build.id,
    buildNumber: build.buildNumber,
    commitSha: resolvedSha,
    status: "building"
  });

  return { preview, build };
}

/**
 * Checks database and local AbortSignal to ensure the build has not been superseded,
 * cancelled, or orphaned by preview deletion.
 */
async function assertJobCanContinue(jobId, previewId, abortSignal, client) {
  if (abortSignal?.aborted) {
    throw new BuildAbortedError(`Build ${jobId} aborted via signal`, "CANCELLED");
  }

  const [currentBuild, preview] = await Promise.all([
    client.build.findUnique({ where: { id: jobId } }),
    client.preview.findUnique({ where: { id: previewId } })
  ]);

  if (!currentBuild) {
    throw new BuildAbortedError(`Build ${jobId} record not found`, "CANCELLED");
  }

  if (currentBuild.status === "SUPERSEDED" || currentBuild.status === "CANCELLED") {
    throw new BuildAbortedError(
      `Build ${jobId} transitioned externally to ${currentBuild.status}`,
      currentBuild.status
    );
  }

  if (!preview || preview.status === "deleted") {
    throw new BuildAbortedError(`Preview ${previewId} was deleted`, "CANCELLED");
  }

  if (preview.latestBuildId && preview.latestBuildId !== jobId) {
    throw new BuildAbortedError(
      `Build ${jobId} superseded by newer build ${preview.latestBuildId}`,
      "SUPERSEDED"
    );
  }

  return { currentBuild, preview };
}

/**
 * Links an external AbortSignal (from buildWorker heartbeat) with a local AbortController
 * registered in activeJobControllers so local supersession or cancellation aborts immediately.
 */
function createLinkedController(jobId, externalSignal) {
  const controller = new AbortController();
  const entry = { controller, reason: null };
  activeJobControllers.set(jobId, entry);

  const onExternalAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  return {
    controller,
    cleanup() {
      activeJobControllers.delete(jobId);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  };
}

/**
 * Executes a claimed durable Build job end-to-end:
 *   Clone exact commitSha -> Docker Build & Run -> Late-Completion Guard -> Atomic Deployment Switch.
 * Automatically aborts and cleans up intermediate artifacts if superseded or cancelled.
 */
export async function executeBuildJob(
  job,
  {
    abortSignal: externalSignal,
    cloner = cloneRepo,
    builder = buildPreview,
    containerRemover = removeContainer,
    imageRemover = removeImage,
    portReleaser = releasePort,
    client = defaultPrisma
  } = {}
) {
  if (!job || !job.id || !job.previewId) {
    throw new Error("Valid job with id and previewId is required");
  }

  const { controller, cleanup } = createLinkedController(job.id, externalSignal);
  let repoPath = null;
  let builtContainerName = null;
  let builtImageName = null;
  let allocatedPort = null;
  let previousPort = null;
  let committedSwitch = false;
  let previewContext = null;

  try {
    // Load preview + project + owner info
    previewContext = await client.preview.findUnique({
      where: { id: job.previewId },
      include: { project: { include: { user: true } } }
    });

    if (!previewContext || !previewContext.project) {
      throw new Error(`Preview or Project not found for build ${job.id}`);
    }

    const project = previewContext.project;
    const previousContainerName = previewContext.containerName || null;
    previousPort = previewContext.port || null;
    const previousActiveBuild = previewContext.activeBuildId
      ? await client.build.findUnique({ where: { id: previewContext.activeBuildId } }).catch(() => null)
      : null;
    const previousImageTag = previousActiveBuild?.imageTag || null;

    // Gate 1: Verify build is still active before cloning
    await assertJobCanContinue(job.id, previewContext.id, controller.signal, client);

    emitPreviewStatus(previewContext.id, project.userId, {
      previewId: previewContext.id,
      projectId: project.id,
      prNumber: previewContext.prNumber,
      buildId: job.id,
      buildNumber: job.buildNumber,
      commitSha: job.commitSha,
      status: "building"
    });

    // Stage 1: Clone repository pinned to exact commitSha
    repoPath = await cloner({
      repoOwner: project.repoOwner,
      repoName: project.repoName,
      ref: job.branch,
      commitSha: job.commitSha,
      prNumber: previewContext.prNumber,
      accessToken: decryptSecret(project.accessToken),
      abortSignal: controller.signal
    });

    // Gate 2: Verify build wasn't superseded or cancelled during git clone
    await assertJobCanContinue(job.id, previewContext.id, controller.signal, client);

    // Stage 2: Build image, enforce resource limits, run container, and execute readiness probe
    const rawResult = await builder({
      project,
      previewId: previewContext.id,
      repoPath,
      prNumber: previewContext.prNumber,
      buildNumber: job.buildNumber,
      buildId: job.id,
      commitSha: job.commitSha,
      abortSignal: controller.signal,
      managedByOrchestrator: true
    });

    const buildResult =
      typeof rawResult === "string"
        ? { url: rawResult, containerName: null, port: null, imageName: null, logs: "" }
        : rawResult || {};

    builtContainerName = buildResult.containerName || null;
    builtImageName = buildResult.imageName || null;
    allocatedPort = buildResult.port || null;

    // Gate 3 (Late Completion Guard): Verify build still owns latestBuildId before switching deployment
    await assertJobCanContinue(job.id, previewContext.id, controller.signal, client);

    const completedAt = new Date();

    // Stage 3: Atomic Deployment Switch in database
    await client.build.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        completedAt,
        containerName: builtContainerName,
        port: allocatedPort,
        imageTag: builtImageName,
        buildLogs: buildResult.logs || null
      }
    });

    const updatedPreviewData = {
      status: "live",
      url: buildResult.url,
      activeBuildId: job.id,
      deployedCommitSha: job.commitSha,
      buildCompletedAt: completedAt
    };

    if (builtContainerName) {
      updatedPreviewData.containerName = builtContainerName;
    }
    if (allocatedPort !== null && allocatedPort !== undefined) {
      updatedPreviewData.port = allocatedPort;
    }
    if (buildResult.logs !== undefined) {
      updatedPreviewData.buildLogs = buildResult.logs;
    }

    await client.preview.update({
      where: { id: previewContext.id },
      data: updatedPreviewData
    });

    committedSwitch = true;

    if (allocatedPort) {
      releasePortInMemory(allocatedPort);
    }

    // Decommission old container & superseded image/port if replaced
    if (previousContainerName && builtContainerName && previousContainerName !== builtContainerName) {
      await containerRemover(previousContainerName).catch((err) => {
        console.warn(`Failed to remove superseded container ${previousContainerName}:`, err?.message || err);
      });
    }
    if (previousPort && allocatedPort && previousPort !== allocatedPort) {
      await portReleaser({ port: previousPort, previewId: previewContext.id, client }).catch(() => {});
    }
    if (previousImageTag && builtImageName && previousImageTag !== builtImageName) {
      await imageRemover(previousImageTag).catch(() => {});
    }

    emitPreviewStatus(previewContext.id, project.userId, {
      previewId: previewContext.id,
      projectId: project.id,
      prNumber: previewContext.prNumber,
      buildId: job.id,
      buildNumber: job.buildNumber,
      commitSha: job.commitSha,
      status: "live",
      url: buildResult.url,
      containerName: builtContainerName
    });

    return {
      status: "COMPLETED",
      url: buildResult.url,
      buildId: job.id,
      containerName: builtContainerName,
      port: allocatedPort
    };
  } catch (err) {
    // Cleanup newly spun-up container & uncommitted image if switch was aborted or failed before activation
    if (builtContainerName && !committedSwitch) {
      await containerRemover(builtContainerName).catch(() => {});
    }
    if (builtImageName && !committedSwitch) {
      await imageRemover(builtImageName, { force: true }).catch(() => {});
    }
    if (allocatedPort && !committedSwitch) {
      releasePortInMemory(allocatedPort);
      if (allocatedPort !== previousPort) {
        await portReleaser({ port: allocatedPort, previewId: previewContext?.id, buildId: job.id, client }).catch(() => {});
      }
    }

    const isAborted = err?.isAborted || err?.name === "AbortError" || controller.signal.aborted;

    if (isAborted) {
      const targetStatus = err?.reasonStatus === "SUPERSEDED" ? "SUPERSEDED" : "CANCELLED";
      const currentBuild = await client.build.findUnique({ where: { id: job.id } }).catch(() => null);

      if (currentBuild && !TERMINAL_BUILD_STATUSES.has(currentBuild.status)) {
        await client.build.update({
          where: { id: job.id },
          data: {
            status: targetStatus,
            cancelledAt: new Date(),
            errorMessage: err.message
          }
        }).catch(() => {});
      }

      return {
        status: currentBuild?.status && TERMINAL_BUILD_STATUSES.has(currentBuild.status)
          ? currentBuild.status
          : targetStatus,
        aborted: true
      };
    }

    // Non-abort failure: record FAILED on Build and update Preview only if still latest
    await client.build.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        errorMessage: err?.message || String(err),
        buildLogs: err?.buildLogs || null
      }
    }).catch(() => {});

    const latestPreview = previewContext
      ? await client.preview.findUnique({ where: { id: previewContext.id } }).catch(() => null)
      : null;

    if (
      latestPreview &&
      latestPreview.status !== "deleted" &&
      (!latestPreview.latestBuildId || latestPreview.latestBuildId === job.id)
    ) {
      await client.preview.update({
        where: { id: latestPreview.id },
        data: {
          status: "error",
          buildCompletedAt: new Date(),
          ...(err?.buildLogs ? { buildLogs: err.buildLogs } : {})
        }
      }).catch(() => {});

      emitPreviewStatus(latestPreview.id, previewContext?.project?.userId, {
        previewId: latestPreview.id,
        projectId: previewContext?.project?.id,
        prNumber: latestPreview.prNumber,
        buildId: job.id,
        buildNumber: job.buildNumber,
        status: "error",
        error: err?.message || "Build failed"
      });
    }

    throw err;
  } finally {
    cleanup();
    if (repoPath) {
      try {
        fs.rmSync(repoPath, { recursive: true, force: true });
      } catch {
        // ignore temp dir cleanup errors
      }
    }
  }
}

/**
 * Direct synchronous build execution pipeline (used when direct cloner/builder injection
 * is provided for in-process testing or direct simulation).
 */
export async function runDirectBuild({
  project,
  prNumber,
  ref,
  commitSha,
  cloner = cloneRepo,
  builder = buildPreview,
  client = defaultPrisma
}) {
  const preview = await client.preview.upsert({
    where: { projectId_prNumber: { projectId: project.id, prNumber } },
    update: { status: "building" },
    create: { projectId: project.id, prNumber, status: "building" }
  });

  emitPreviewStatus(preview.id, project.userId, {
    previewId: preview.id,
    projectId: project.id,
    prNumber,
    status: "building"
  });

  const repoPath = await cloner({
    repoOwner: project.repoOwner,
    repoName: project.repoName,
    ref,
    commitSha,
    prNumber,
    accessToken: decryptSecret(project.accessToken)
  });

  try {
    try {
      const result = await builder({
        project,
        previewId: preview.id,
        repoPath,
        prNumber
      });
      const url = typeof result === "string" ? result : result?.url;

      emitPreviewStatus(preview.id, project.userId, {
        previewId: preview.id,
        projectId: project.id,
        prNumber,
        status: "live",
        url
      });

      return { previewId: preview.id, url };
    } catch (err) {
      emitPreviewStatus(preview.id, project.userId, {
        previewId: preview.id,
        projectId: project.id,
        prNumber,
        status: "error"
      });

      throw err;
    }
  } finally {
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      // ignore deletion errors
    }
  }
}

/**
 * Cancels all non-terminal (QUEUED, RUNNING, RETRYING) builds for a preview,
 * aborts running worker execution, and restores/updates Preview status.
 */
export async function cancelPreviewBuilds({
  previewId,
  reason = "Build cancelled by user",
  userId = null,
  client = defaultPrisma
}) {
  const preview = await client.preview.findUnique({
    where: { id: previewId },
    include: { project: true }
  });

  if (!preview) {
    throw new Error(`Preview ${previewId} not found`);
  }

  const builds = await client.build.findMany({
    where: { previewId }
  });

  const activeBuilds = (builds || []).filter((b) => !TERMINAL_BUILD_STATUSES.has(b.status));
  const cancelledBuildIds = [];

  for (const b of activeBuilds) {
    await client.build.update({
      where: { id: b.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        errorMessage: reason
      }
    });
    cancelledBuildIds.push(b.id);
    abortActiveBuild(b.id, reason);
  }

  // Restore previous live state if an active completed deployment is still serving; else mark error
  const hasPreviousLive = Boolean(preview.url && preview.deployedCommitSha);
  const nextStatus = preview.status === "deleted"
    ? "deleted"
    : hasPreviousLive
      ? "live"
      : "error";

  const updateData = {
    status: nextStatus,
    buildCompletedAt: new Date()
  };

  if (cancelledBuildIds.includes(preview.activeBuildId)) {
    updateData.activeBuildId = null;
  }

  await client.preview.update({
    where: { id: previewId },
    data: updateData
  });

  emitPreviewStatus(previewId, userId || preview.project?.userId, {
    previewId,
    projectId: preview.projectId,
    prNumber: preview.prNumber,
    status: nextStatus,
    url: preview.url || null,
    cancelledBuildIds
  });

  return {
    cancelledCount: cancelledBuildIds.length,
    cancelledBuildIds,
    status: nextStatus
  };
}

/**
 * Unified teardown for PR Closure (webhook) and Manual Preview Deletion (UI/API).
 * Cancels queued/running builds, aborts in-flight jobs, removes containers,
 * and marks the preview as deleted.
 */
export async function closeOrDeletePreview({
  previewId = null,
  project = null,
  prNumber = null,
  reason = "Preview deleted",
  containerRemover = removeContainer,
  imageRemover = removeImage,
  previewPortsReleaser = releasePreviewPorts,
  userId = null,
  client = defaultPrisma
}) {
  const preview = previewId
    ? await client.preview.findUnique({ where: { id: previewId }, include: { project: true } })
    : await client.preview.findFirst({ where: { projectId: project?.id, prNumber } });

  if (!preview) {
    return null;
  }

  const targetProject = project || preview.project;
  const ownerId = userId || targetProject?.userId;

  // 1. Cancel any active/queued builds for this preview and collect containers/images to tear down
  const containersToRemove = new Set();
  const imagesToRemove = new Set();
  if (preview.containerName) {
    containersToRemove.add(preview.containerName);
  }

  try {
    const builds = await client.build.findMany({
      where: { previewId: preview.id }
    });

    for (const b of builds || []) {
      if (b.containerName) {
        containersToRemove.add(b.containerName);
      }
      if (b.imageTag) {
        imagesToRemove.add(b.imageTag);
      }
      if (!TERMINAL_BUILD_STATUSES.has(b.status)) {
        await client.build.update({
          where: { id: b.id },
          data: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            errorMessage: reason
          }
        });
        abortActiveBuild(b.id, reason);
      }
    }
  } catch (err) {
    if (err?.code !== "P2021") {
      console.warn("Build cancellation during preview teardown warning:", err?.message || err);
    }
  }

  // 2. Remove all associated Docker containers gracefully
  for (const containerName of containersToRemove) {
    try {
      await containerRemover(containerName);
    } catch (e) {
      console.warn("Failed to remove container on teardown:", e?.message || e);
    }
  }

  // 3. Reclaim Docker images built specifically for this preview
  for (const imageTag of imagesToRemove) {
    await imageRemover(imageTag).catch(() => {});
  }

  // 4. Release all PortAllocation leases held by this preview
  await previewPortsReleaser({ previewId: preview.id, client }).catch(() => {});

  // 3. Mark preview deleted in database
  const updated = await client.preview.update({
    where: { id: preview.id },
    data: {
      status: "deleted",
      url: null,
      containerName: null,
      port: null,
      activeBuildId: null,
      buildStartedAt: reason === "Pull request closed" ? null : preview.buildStartedAt,
      buildCompletedAt: reason === "Pull request closed" ? null : new Date()
    }
  });

  emitPreviewStatus(preview.id, ownerId, {
    previewId: preview.id,
    projectId: preview.projectId,
    prNumber: preview.prNumber,
    status: "deleted",
    url: null,
    buildStartedAt: updated?.buildStartedAt ?? null,
    buildCompletedAt: updated?.buildCompletedAt ?? null
  });

  return updated;
}
