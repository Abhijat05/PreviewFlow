// backend/src/services/prHandlers.js
import { prisma } from "../db.js";
import fs from "fs";
import { cloneRepo } from "./repoService.js";
import { buildPreview, removeContainer } from "./dockerService.js";
import { getIO } from "../socket.js";

export async function handlePROpenOrSync({ project, prNumber, ref }) {
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

    fs.rmSync(repoPath, { recursive: true, force: true });

    getIO().emit("preview-status-update", {
      projectId: project.id,
      prNumber,
      status: "live",
      url
    });
  } catch (err) {
    fs.rmSync(repoPath, { recursive: true, force: true });

    getIO().emit("preview-status-update", {
      projectId: project.id,
      prNumber,
      status: "error"
    });

    throw err;
  }
}

export async function handlePRClosed({ project, prNumber }) {
  const preview = await prisma.preview.findFirst({
    where: { projectId: project.id, prNumber }
  });

  if (!preview) return;

  if (preview.containerName) {
    await removeContainer(preview.containerName);
  }

  await prisma.preview.update({
    where: { id: preview.id },
    data: { status: "deleted", url: null }
  });

  getIO().emit("preview-status-update", {
    projectId: project.id,
    prNumber,
    status: "deleted"
  });
}
