// backend/src/services/prHandlers.js
import { prisma } from "../db.js";
import fs from "fs";
import { cloneRepo } from "./repoService.js";
import { buildPreview, removeContainer } from "./dockerService.js";
import { getIO } from "../socket.js";

/**
 * handlePROpenOrSync
 *
 * This creates/upserts a preview record and triggers buildPreview.
 * It will:
 *  - upsert a Preview row (status=building)
 *  - clone the repo
 *  - call buildPreview which will assign ports and container names
 */
export async function handlePROpenOrSync({ project, prNumber, ref }) {
  // upsert preview row; keep buildNumber (default 1) if new, or preserve existing
  const preview = await prisma.preview.upsert({
    where: { projectId_prNumber: { projectId: project.id, prNumber } },
    update: { status: "building" },
    create: { projectId: project.id, prNumber, status: "building" }
  });

  getIO().emit("preview-status-update", {
    projectId: project.id,
    prNumber,
    status: "building"
  });

  const repoPath = await cloneRepo({
    repoOwner: project.repoOwner,
    repoName: project.repoName,
    ref
  });

  try {
    const url = await buildPreview({
      project,
      previewId: preview.id,
      repoPath,
      prNumber
    });

    // cleanup repo clone
    try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    getIO().emit("preview-status-update", {
      projectId: project.id,
      prNumber,
      status: "live",
      url
    });
  } catch (err) {
    try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    getIO().emit("preview-status-update", {
      projectId: project.id,
      prNumber,
      status: "error"
    });

    throw err;
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
    data: { status: "deleted", url: null, port: null }
  });

  getIO().emit("preview-status-update", {
    projectId: project.id,
    prNumber,
    status: "deleted"
  });
}
