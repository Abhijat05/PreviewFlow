// backend/tests/unit/buildOrchestrator.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { prisma } from "../../src/db.js";
import { mockPrisma } from "../helpers/prismaMock.js";
import {
  triggerBuild,
  executeBuildJob,
  cancelPreviewBuilds,
  closeOrDeletePreview,
  supersedeActiveBuilds,
  abortActiveBuild,
  getActiveBuildAbortController
} from "../../src/services/buildOrchestrator.js";
import { runCommand } from "../../src/services/dockerService.js";

describe("buildOrchestrator Unit & Lifecycle Tests", () => {
  let prismaRestore;
  let builds;
  let previews;
  let seq;
  let tempDirsToClean;

  const project = {
    id: "proj_orch_1",
    userId: "user_orch_1",
    repoOwner: "acme",
    repoName: "web-app",
    accessToken: "ghp_mock",
    user: { id: "user_orch_1", tier: "PRO" }
  };

  beforeEach(() => {
    const { restore } = mockPrisma();
    prismaRestore = restore;
    builds = new Map();
    previews = new Map();
    seq = 0;
    tempDirsToClean = [];

    prisma.preview.upsert = async ({ where, update, create }) => {
      const existing = Array.from(previews.values()).find(
        (p) =>
          p.projectId === where.projectId_prNumber.projectId &&
          p.prNumber === where.projectId_prNumber.prNumber
      );
      if (existing) {
        const updated = { ...existing, ...update };
        previews.set(existing.id, updated);
        return updated;
      }
      const id = `prev_orch_${++seq}`;
      const created = {
        id,
        buildNumber: 1,
        activeBuildId: null,
        latestBuildId: null,
        desiredCommitSha: null,
        deployedCommitSha: null,
        url: null,
        containerName: null,
        port: null,
        ...create,
        project
      };
      previews.set(id, created);
      return created;
    };

    prisma.preview.findUnique = async ({ where }) => {
      const p = previews.get(where.id);
      return p ? { ...p, project } : null;
    };

    prisma.preview.findFirst = async ({ where }) => {
      for (const p of previews.values()) {
        if (where.id && p.id !== where.id) continue;
        if (where.projectId && p.projectId !== where.projectId) continue;
        if (where.prNumber !== undefined && p.prNumber !== where.prNumber) continue;
        if (where.activeBuildId && p.activeBuildId !== where.activeBuildId) continue;
        return { ...p, project };
      }
      return null;
    };

    prisma.preview.update = async ({ where, data }) => {
      const existing = previews.get(where.id);
      if (!existing) throw new Error(`Preview ${where.id} not found`);
      const updated = { ...existing, ...data };
      previews.set(where.id, updated);
      return updated;
    };

    prisma.build.create = async ({ data }) => {
      const id = `build_orch_${++seq}`;
      const record = { id, ...data };
      builds.set(id, record);
      return record;
    };

    prisma.build.findUnique = async ({ where }) => builds.get(where.id) || null;

    prisma.build.findFirst = async ({ where, orderBy }) => {
      const matches = Array.from(builds.values()).filter(
        (b) => !where?.previewId || b.previewId === where.previewId
      );
      if (orderBy?.buildNumber === "desc") {
        matches.sort((a, b) => b.buildNumber - a.buildNumber);
      }
      return matches[0] || null;
    };

    prisma.build.findMany = async ({ where }) =>
      Array.from(builds.values()).filter((b) => {
        if (where?.previewId && b.previewId !== where.previewId) return false;
        if (where?.status && b.status !== where.status) return false;
        return true;
      });

    prisma.build.update = async ({ where, data }) => {
      const existing = builds.get(where.id);
      if (!existing) throw new Error(`Build ${where.id} not found`);
      const updated = { ...existing, ...data };
      builds.set(where.id, updated);
      return updated;
    };

    prisma.build.updateMany = async ({ where, data }) => {
      let count = 0;
      for (const [id, b] of builds.entries()) {
        if (where?.previewId && b.previewId !== where.previewId) continue;
        if (where?.status && b.status !== where.status) continue;
        builds.set(id, { ...b, ...data });
        count++;
      }
      return { count };
    };
  });

  afterEach(() => {
    if (prismaRestore) prismaRestore();
    for (const dir of tempDirsToClean) {
      try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  test("triggerBuild supersedes active RUNNING and QUEUED builds and enqueues new commit", async () => {
    // 1. Trigger initial build A
    const first = await triggerBuild({
      project,
      prNumber: 42,
      commitSha: "sha_commit_aaa111",
      branch: "feat/unified",
      source: "WEBHOOK_OPEN"
    });

    assert.equal(first.build.status, "QUEUED");
    assert.equal(first.build.buildNumber, 1);
    assert.equal(first.preview.status, "building");

    // Simulate worker claiming build A (now RUNNING)
    builds.set(first.build.id, { ...first.build, status: "RUNNING" });

    // 2. Rapid commit arrives -> trigger build B
    const second = await triggerBuild({
      project,
      prNumber: 42,
      commitSha: "sha_commit_bbb222",
      branch: "feat/unified",
      source: "WEBHOOK_SYNC"
    });

    assert.equal(second.build.status, "QUEUED");
    assert.equal(second.build.buildNumber, 2);

    const buildA = builds.get(first.build.id);
    assert.equal(buildA.status, "SUPERSEDED");

    const updatedPreview = previews.get(first.preview.id);
    assert.equal(updatedPreview.latestBuildId, second.build.id);
    assert.equal(updatedPreview.desiredCommitSha, "sha_commit_bbb222");
  });

  test("executeBuildJob executes atomic deployment switch and cleans up old container and temp repo", async () => {
    // Seed existing live preview with old container
    const prev = await prisma.preview.upsert({
      where: { projectId_prNumber: { projectId: project.id, prNumber: 77 } },
      update: {},
      create: {
        projectId: project.id,
        prNumber: 77,
        status: "live",
        url: "http://localhost:5050",
        containerName: "preview-old-b1",
        port: 5050
      }
    });

    const { build } = await triggerBuild({
      project,
      prNumber: 77,
      commitSha: "sha_release_777",
      branch: "feat/atomic-switch",
      source: "WEBHOOK_SYNC"
    });

    // Mark job as RUNNING (as claimNextJob does)
    const job = await prisma.build.update({
      where: { id: build.id },
      data: { status: "RUNNING", workerId: "worker-1" }
    });

    const tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-repo-"));
    tempDirsToClean.push(tempRepoDir);

    const removedContainers = [];
    const releasedPorts = [];
    let clonedSha = null;

    const result = await executeBuildJob(job, {
      cloner: async ({ commitSha }) => {
        clonedSha = commitSha;
        return tempRepoDir;
      },
      builder: async ({ buildNumber }) => ({
        url: "http://localhost:5051",
        containerName: `preview-new-b${buildNumber}`,
        port: 5051,
        imageName: "acme-web-app-pr-77:b1",
        logs: "Built successfully"
      }),
      containerRemover: async (name) => {
        removedContainers.push(name);
        return true;
      },
      portReleaser: async ({ port }) => {
        releasedPorts.push(port);
        return { released: true };
      }
    });

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.url, "http://localhost:5051");
    assert.equal(clonedSha, "sha_release_777");
    assert.equal(fs.existsSync(tempRepoDir), false, "Cloned temp directory must be removed");
    assert.deepEqual(removedContainers, ["preview-old-b1"]);
    assert.deepEqual(releasedPorts, [5050]);

    const updatedPreview = previews.get(prev.id);
    assert.equal(updatedPreview.status, "live");
    assert.equal(updatedPreview.activeBuildId, build.id);
    assert.equal(updatedPreview.deployedCommitSha, "sha_release_777");
    assert.equal(updatedPreview.url, "http://localhost:5051");
    assert.equal(updatedPreview.containerName, "preview-new-b1");
    assert.equal(updatedPreview.port, 5051);

    const completedBuild = builds.get(build.id);
    assert.equal(completedBuild.status, "COMPLETED");
    assert.equal(completedBuild.containerName, "preview-new-b1");
  });

  test("executeBuildJob late-completion guard cleans up stale container when superseded mid-build", async () => {
    const { preview, build: buildA } = await triggerBuild({
      project,
      prNumber: 88,
      commitSha: "sha_stale_a",
      branch: "feat/race",
      source: "WEBHOOK_OPEN"
    });

    // Set existing live deployment so we verify it is NOT overwritten by stale Build A
    await prisma.preview.update({
      where: { id: preview.id },
      data: {
        activeBuildId: "build_live_original",
        deployedCommitSha: "sha_original_live",
        url: "http://localhost:5010",
        containerName: "preview-original"
      }
    });

    const jobA = await prisma.build.update({
      where: { id: buildA.id },
      data: { status: "RUNNING", workerId: "worker-a" }
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-stale-"));
    tempDirsToClean.push(tempDir);

    const removedContainers = [];

    const res = await executeBuildJob(jobA, {
      cloner: async () => tempDir,
      builder: async () => {
        // Simulate Build B arriving right while Build A finishes Docker build
        await prisma.preview.update({
          where: { id: preview.id },
          data: { latestBuildId: "build_newer_b", desiredCommitSha: "sha_newer_b" }
        });
        return {
          url: "http://localhost:5099",
          containerName: "preview-stale-container",
          port: 5099
        };
      },
      containerRemover: async (name) => {
        removedContainers.push(name);
        return true;
      }
    });

    assert.equal(res.aborted, true);
    assert.equal(res.status, "SUPERSEDED");
    assert.deepEqual(removedContainers, ["preview-stale-container"]);

    // Verify Preview still points to original live deployment and NOT Build A
    const afterPreview = previews.get(preview.id);
    assert.equal(afterPreview.activeBuildId, "build_live_original");
    assert.equal(afterPreview.url, "http://localhost:5010");
    assert.equal(afterPreview.deployedCommitSha, "sha_original_live");

    const buildARecord = builds.get(buildA.id);
    assert.equal(buildARecord.status, "SUPERSEDED");
  });

  test("executeBuildJob aborts cooperatively when supersedeActiveBuilds is invoked mid-build", async () => {
    const { preview, build } = await triggerBuild({
      project,
      prNumber: 90,
      commitSha: "sha_abort_mid",
      branch: "feat/abort",
      source: "WEBHOOK_OPEN"
    });

    const job = await prisma.build.update({
      where: { id: build.id },
      data: { status: "RUNNING", workerId: "worker-coop" }
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-abort-"));
    tempDirsToClean.push(tempDir);

    let signalAbortedInsideBuilder = false;

    const res = await executeBuildJob(job, {
      cloner: async () => tempDir,
      builder: async ({ abortSignal }) => {
        assert.ok(getActiveBuildAbortController(build.id));
        await supersedeActiveBuilds(preview.id, { reason: "Newer commit pushed" });
        signalAbortedInsideBuilder = abortSignal.aborted;
        const err = new Error("Aborted");
        err.name = "AbortError";
        err.isAborted = true;
        throw err;
      }
    });

    assert.equal(signalAbortedInsideBuilder, true);
    assert.equal(res.aborted, true);
    assert.equal(res.status, "SUPERSEDED");
    assert.equal(getActiveBuildAbortController(build.id), null);
    assert.equal(fs.existsSync(tempDir), false);
  });

  test("cancelPreviewBuilds cancels queued/running builds and restores live state if active deployment exists", async () => {
    const prev = await prisma.preview.upsert({
      where: { projectId_prNumber: { projectId: project.id, prNumber: 55 } },
      update: {},
      create: {
        projectId: project.id,
        prNumber: 55,
        status: "live",
        url: "http://localhost:5055",
        deployedCommitSha: "sha_stable"
      }
    });

    const { build } = await triggerBuild({
      project,
      prNumber: 55,
      commitSha: "sha_cancel_me",
      branch: "feat/cancel",
      source: "MANUAL_REBUILD"
    });

    const cancelRes = await cancelPreviewBuilds({
      previewId: prev.id,
      reason: "User cancelled"
    });

    assert.equal(cancelRes.cancelledCount, 1);
    assert.deepEqual(cancelRes.cancelledBuildIds, [build.id]);
    assert.equal(cancelRes.status, "live");
    assert.equal(builds.get(build.id).status, "CANCELLED");
    assert.equal(previews.get(prev.id).status, "live");
  });

  test("closeOrDeletePreview cancels builds, removes all build & preview containers, and marks preview deleted", async () => {
    const { preview, build } = await triggerBuild({
      project,
      prNumber: 66,
      commitSha: "sha_delete_me",
      branch: "feat/delete",
      source: "WEBHOOK_OPEN"
    });

    await prisma.preview.update({
      where: { id: preview.id },
      data: { containerName: "preview-current-66", status: "live", url: "http://localhost:5066" }
    });
    await prisma.build.update({
      where: { id: build.id },
      data: { status: "RUNNING", containerName: "preview-running-66" }
    });

    const removed = [];
    const updated = await closeOrDeletePreview({
      previewId: preview.id,
      reason: "Pull request closed",
      containerRemover: async (name) => {
        removed.push(name);
        return true;
      }
    });

    assert.equal(updated.status, "deleted");
    assert.equal(updated.url, null);
    assert.equal(updated.containerName, null);
    assert.equal(updated.port, null);
    assert.equal(builds.get(build.id).status, "CANCELLED");
    assert.ok(removed.includes("preview-current-66"));
    assert.ok(removed.includes("preview-running-66"));
  });

  test("dockerService.runCommand aborts child process cooperatively via AbortSignal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);

    const start = Date.now();
    await assert.rejects(
      async () => {
        await runCommand(
          process.execPath,
          ["-e", "setTimeout(() => {}, 10000);"],
          () => {},
          { abortSignal: controller.signal }
        );
      },
      (err) => {
        assert.equal(err.isAborted, true);
        assert.equal(err.name, "AbortError");
        return true;
      }
    );

    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000, `Process should have terminated quickly on abort, took ${elapsed}ms`);
  });

  test("executeBuildJob reclaims superseded image on completion and failed images on abort", async () => {
    // 1. Seed active build with an imageTag
    const prev = await prisma.preview.upsert({
      where: { projectId_prNumber: { projectId: project.id, prNumber: 120 } },
      update: {},
      create: {
        projectId: project.id,
        prNumber: 120,
        status: "live",
        url: "http://localhost:5120",
        containerName: "preview-img-old",
        port: 5120
      }
    });

    const oldBuild = await prisma.build.create({
      data: {
        previewId: prev.id,
        buildNumber: 1,
        commitSha: "sha_img_1",
        branch: "pr-120",
        status: "COMPLETED",
        imageTag: "previewflow/acme-web-app:pr-120-b1-old"
      }
    });
    await prisma.preview.update({
      where: { id: prev.id },
      data: { activeBuildId: oldBuild.id }
    });

    const { build: newBuild } = await triggerBuild({
      project,
      prNumber: 120,
      commitSha: "sha_img_2",
      branch: "pr-120",
      source: "WEBHOOK_SYNC"
    });
    const runningJob = await prisma.build.update({
      where: { id: newBuild.id },
      data: { status: "RUNNING", workerId: "w-img" }
    });

    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "orch-img-"));
    tempDirsToClean.push(tempRepo);
    const removedImages = [];

    await executeBuildJob(runningJob, {
      cloner: async () => tempRepo,
      builder: async () => ({
        url: "http://localhost:5121",
        containerName: "preview-img-new",
        port: 5121,
        imageName: "previewflow/acme-web-app:pr-120-b2-new"
      }),
      containerRemover: async () => true,
      imageRemover: async (img) => {
        removedImages.push(img);
        return true;
      }
    });

    assert.deepEqual(removedImages, ["previewflow/acme-web-app:pr-120-b1-old"]);

    // Verify closeOrDeletePreview cleans up associated images too
    await closeOrDeletePreview({
      previewId: prev.id,
      reason: "Pull request closed",
      containerRemover: async () => true,
      imageRemover: async (img) => {
        removedImages.push(`del:${img}`);
        return true;
      }
    });

    assert.ok(removedImages.includes("del:previewflow/acme-web-app:pr-120-b2-new"));
  });
});
