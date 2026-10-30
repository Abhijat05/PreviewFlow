// backend/src/services/prHandlers.js
import { prisma } from "../db.js";
import fs from "fs";
import { cloneRepo } from "./repoService.js";
import { buildPreview, removeContainer } from "./dockerService.js";
import { getIO } from "../socket.js";

function emitStatus(previewId, userId, payload) {
  try {
    const io = getIO();
    const target = userId
      ? io.to(`preview:${previewId}`).to(previewId).to(`user:${userId}`)
      : io.to(`preview:${previewId}`).to(previewId);
    target.emit("preview-status-update", payload);
  } catch (e) {
    // ignore socket emit error
  }
}

/**
 * handlePROpenOrSync
 *
 * Creates/upserts a preview record and triggers buildPreview.
 */
export async function handlePROpenOrSync({ project, prNumber, ref }) {
  const preview = await prisma.preview.upsert({
    where: { projectId_prNumber: { projectId: project.id, prNumber } },
    update: { status: "building" },
    create: { projectId: project.id, prNumber, status: "building" }
  });

  emitStatus(preview.id, project.userId, {
    previewId: preview.id,
    projectId: project.id,
    prNumber,
    status: "building"
  });

  const repoPath = await cloneRepo({
    repoOwner: project.repoOwner,
    repoName: project.repoName,
    ref,
    prNumber,
    accessToken: project.accessToken
  });

  try {
    try {
      const url = await buildPreview({
        project,
        previewId: preview.id,
        repoPath,
        prNumber
      });

      emitStatus(preview.id, project.userId, {
        previewId: preview.id,
        projectId: project.id,
        prNumber,
        status: "live",
        url
      });
    } catch (err) {
      emitStatus(preview.id, project.userId, {
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
    } catch (e) {
      // ignore deletion errors
    }
  }
}

/**
 * handlePRClosed
 *
 * Stops and removes the container if present, marks preview deleted.
 */
export async function handlePRClosed({ project, prNumber }) {
  const preview = await prisma.preview.findFirst({
    where: { projectId: project.id, prNumber }
  });

  if (!preview) return;

  if (preview.containerName) {
    try {
      await removeContainer(preview.containerName);
    } catch (e) {
      console.warn("Failed to remove container on PR close:", e?.message || e);
    }
  }

  await prisma.preview.update({
    where: { id: preview.id },
    data: {
      status: "deleted",
      url: null,
      containerName: null,
      port: null,
      buildStartedAt: null,
      buildCompletedAt: null
    }
  });

  emitStatus(preview.id, project.userId, {
    previewId: preview.id,
    projectId: project.id,
    prNumber,
    status: "deleted"
  });
}
