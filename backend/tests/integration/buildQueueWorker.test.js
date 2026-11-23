// backend/tests/integration/buildQueueWorker.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../src/db.js";
import { mockPrisma } from "../helpers/prismaMock.js";
import { enqueueBuild, getBuildById } from "../../src/services/buildQueueService.js";
import {
  claimNextJob,
  renewLease,
  recoverStaleLeases,
  createWorkerLoop
} from "../../src/services/buildWorker.js";

describe("Build Queue & Worker Concurrency Integration Tests", () => {
  let prismaRestore;
  let inMemoryDb;

  beforeEach(() => {
    const { restore } = mockPrisma();
    prismaRestore = restore;

    // In-memory simulation of Build and Preview tables for concurrency tests
    inMemoryDb = {
      builds: new Map(),
      previews: new Map()
    };

    // Seed a preview
    inMemoryDb.previews.set("prev_int_1", {
      id: "prev_int_1",
      projectId: "proj_1",
      prNumber: 10,
      status: "pending",
      buildNumber: 0,
      activeBuildId: null,
      latestBuildId: null
    });

    // Mock prisma operations against in-memory store
    prisma.build.create = async ({ data }) => {
      const id = `build_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const record = { id, ...data };
      inMemoryDb.builds.set(id, record);
      return record;
    };

    prisma.build.findFirst = async ({ where, orderBy }) => {
      let matches = Array.from(inMemoryDb.builds.values()).filter((b) => {
        if (where.previewId && b.previewId !== where.previewId) return false;
        if (where.status && b.status !== where.status) return false;
        return true;
      });
      if (orderBy?.buildNumber === "desc") {
        matches.sort((a, b) => b.buildNumber - a.buildNumber);
      }
      return matches[0] || null;
    };

    prisma.build.findUnique = async ({ where }) => {
      return inMemoryDb.builds.get(where.id) || null;
    };

    prisma.build.findMany = async ({ where }) => {
      return Array.from(inMemoryDb.builds.values()).filter((b) => {
        if (where?.previewId && b.previewId !== where.previewId) return false;
        if (where?.status && b.status !== where.status) return false;
        return true;
      });
    };

    prisma.build.update = async ({ where, data }) => {
      const record = inMemoryDb.builds.get(where.id);
      if (!record) throw new Error(`Build ${where.id} not found`);
      const updated = { ...record, ...data };
      inMemoryDb.builds.set(where.id, updated);
      return updated;
    };

    prisma.build.updateMany = async ({ where, data }) => {
      let count = 0;
      for (const [id, record] of inMemoryDb.builds.entries()) {
        let match = true;
        if (where.previewId && record.previewId !== where.previewId) match = false;
        if (where.status && record.status !== where.status) match = false;
        if (match) {
          inMemoryDb.builds.set(id, { ...record, ...data });
          count++;
        }
      }
      return { count };
    };

    prisma.preview.update = async ({ where, data }) => {
      const record = inMemoryDb.previews.get(where.id);
      if (!record) throw new Error(`Preview ${where.id} not found`);
      const updated = { ...record, ...data };
      inMemoryDb.previews.set(where.id, updated);
      return updated;
    };

    prisma.preview.findFirst = async ({ where }) => {
      for (const record of inMemoryDb.previews.values()) {
        let match = true;
        if (where.id && record.id !== where.id) match = false;
        if (where.activeBuildId && record.activeBuildId !== where.activeBuildId) match = false;
        if (match) return record;
      }
      return null;
    };

    // Atomic claim simulation with FOR UPDATE SKIP LOCKED semantics
    prisma.$queryRaw = async (strings, ...values) => {
      // Find workerId from raw query values if passed
      const workerIdArg = values && values[0] ? values[0] : "worker-mock";
      const queuedJobs = Array.from(inMemoryDb.builds.values())
        .filter((b) => b.status === "QUEUED")
        .sort((a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime());

      if (queuedJobs.length === 0) return [];

      const nextJob = queuedJobs[0];
      const updated = {
        ...nextJob,
        status: "RUNNING",
        workerId: workerIdArg,
        startedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60000)
      };
      inMemoryDb.builds.set(nextJob.id, updated);
      return [updated];
    };
  });

  afterEach(() => {
    if (prismaRestore) prismaRestore();
  });

  test("End-to-End Build Lifecycle: Enqueue -> Claim -> Lease Renewal -> Completion", async () => {
    const workerId = "worker-integration-1";

    // 1. Enqueue build
    const enqueued = await enqueueBuild({
      previewId: "prev_int_1",
      commitSha: "sha_commit_100",
      branch: "feature/lifecycle",
      commitMessage: "Test full lifecycle"
    });

    assert.equal(enqueued.status, "QUEUED");
    assert.equal(enqueued.buildNumber, 1);

    // 2. Worker claims job
    const claimed = await claimNextJob(workerId, { leaseDurationSeconds: 45 });
    assert.ok(claimed);
    assert.equal(claimed.id, enqueued.id);
    assert.equal(claimed.status, "RUNNING");

    // Verify preview status was set to building
    const preview = inMemoryDb.previews.get("prev_int_1");
    assert.equal(preview.status, "building");
    assert.equal(preview.activeBuildId, claimed.id);

    // 3. Worker renews heartbeat lease
    const renewal = await renewLease(claimed.id, workerId, { leaseDurationSeconds: 60 });
    assert.equal(renewal.renewed, true);
    assert.ok(renewal.leaseExpiresAt);

    // 4. Job completes successfully
    await prisma.build.update({
      where: { id: claimed.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date()
      }
    });

    const finalBuild = inMemoryDb.builds.get(claimed.id);
    assert.equal(finalBuild.status, "COMPLETED");
    assert.ok(finalBuild.completedAt);
  });

  test("Simulated Worker Crash & Automatic Stale Lease Recovery", async () => {
    const deadWorkerId = "worker-crashed-x";

    // 1. Enqueue and claim a build
    const enqueued = await enqueueBuild({
      previewId: "prev_int_1",
      commitSha: "sha_crash_test",
      branch: "fix/crash"
    });

    const claimed = await claimNextJob(deadWorkerId, { leaseDurationSeconds: 30 });
    assert.equal(claimed.id, enqueued.id);

    // 2. Simulate worker died: lease time lapses 40 seconds into the past
    const expiredTime = new Date(Date.now() - 40000);
    inMemoryDb.builds.set(claimed.id, {
      ...inMemoryDb.builds.get(claimed.id),
      workerId: deadWorkerId,
      leaseExpiresAt: expiredTime,
      attempt: 1,
      maxAttempts: 3
    });

    // 3. Run reaper to recover stale leases
    const recoveryReport = await recoverStaleLeases();
    assert.equal(recoveryReport.recoveredCount, 1);
    assert.equal(recoveryReport.failedCount, 0);

    // Verify build is now re-QUEUED for attempt 2
    const recovered = inMemoryDb.builds.get(claimed.id);
    assert.equal(recovered.status, "QUEUED");
    assert.equal(recovered.attempt, 2);
    assert.equal(recovered.workerId, null);
    assert.equal(recovered.leaseExpiresAt, null);
    assert.match(recovered.errorMessage, /worker-crashed-x/);

    // 4. New healthy worker claims recovered build
    const healthyWorkerId = "worker-healthy-y";
    const reclaimed = await claimNextJob(healthyWorkerId, { leaseDurationSeconds: 60 });
    assert.ok(reclaimed);
    assert.equal(reclaimed.id, claimed.id);
    assert.equal(reclaimed.status, "RUNNING");
  });

  test("Supersession: New commit supersedes older queued build", async () => {
    // 1. Push commit A
    const buildA = await enqueueBuild({
      previewId: "prev_int_1",
      commitSha: "sha_A",
      branch: "feature/supersession"
    });
    assert.equal(buildA.buildNumber, 1);
    assert.equal(buildA.status, "QUEUED");

    // 2. Push commit B immediately before worker claims build A
    const buildB = await enqueueBuild({
      previewId: "prev_int_1",
      commitSha: "sha_B",
      branch: "feature/supersession"
    });
    assert.equal(buildB.buildNumber, 2);
    assert.equal(buildB.status, "QUEUED");

    // Check that build A was automatically superseded
    const checkedA = inMemoryDb.builds.get(buildA.id);
    assert.equal(checkedA.status, "SUPERSEDED");

    // 3. Worker claims job - should claim build B, NOT build A
    const claimed = await claimNextJob("worker-1");
    assert.ok(claimed);
    assert.equal(claimed.id, buildB.id);
    assert.equal(claimed.commitSha, "sha_B");

    // 4. Next claim attempt finds no more queued jobs
    const emptyClaim = await claimNextJob("worker-1");
    assert.equal(emptyClaim, null);
  });
});
