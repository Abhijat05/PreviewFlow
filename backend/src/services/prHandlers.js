// backend/src/services/prHandlers.js
import { prisma } from "../db.js";
import { cloneRepo } from "./repoService.js";
import { buildPreview, removeContainer } from "./dockerService.js";
import {
  triggerBuild,
  runDirectBuild,
  closeOrDeletePreview
} from "./buildOrchestrator.js";

/**
 * handlePROpenOrSync
 *
 * Enqueues a durable build job via buildOrchestrator when asyncQueue is true
 * (webhook / async flow), or executes the shared direct pipeline when cloner/builder
 * overrides are supplied.
 */
export async function handlePROpenOrSync({
  project,
  prNumber,
  ref,
  commitSha,
  user,
  source = "WEBHOOK_SYNC",
  commitMessage = null,
  asyncQueue = false,
  cloner,
  builder,
  client = prisma
}) {
  if (asyncQueue && !cloner && !builder) {
    const projectWithUser = user && !project.user ? { ...project, user } : project;
    return triggerBuild({
      project: projectWithUser,
      prNumber,
      commitSha,
      branch: ref,
      source,
      commitMessage,
      client
    });
  }

  return runDirectBuild({
    project,
    prNumber,
    ref,
    commitSha,
    cloner: cloner || cloneRepo,
    builder: builder || buildPreview,
    client
  });
}

/**
 * handlePRClosed
 *
 * Cancels active/queued builds, removes container(s), and marks preview deleted.
 */
export async function handlePRClosed({
  project,
  prNumber,
  containerRemover = removeContainer,
  client = prisma
}) {
  return closeOrDeletePreview({
    project,
    prNumber,
    reason: "Pull request closed",
    containerRemover,
    userId: project?.userId,
    client
  });
}
