// backend/tests/unit/buildWorker.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../src/db.js";
import { mockPrisma } from "../helpers/prismaMock.js";
import {
  generateWorkerId,
  claimNextJob,
  renewLease,
  recoverStaleLeases,
  createWorkerLoop
} from "../../src/services/buildWorker.js";

describe("buildWorker Unit Tests", () => {
  let prismaRestore;

  beforeEach(() => {
    const { restore } = mockPrisma();
    prismaRestore = restore;
  });

  afterEach(() => {
    if (prismaRestore) prismaRestore();
  });

  test("generateWorkerId produces a unique non-empty worker identifier with process metadata", () => {
    const workerId1 = generateWorkerId();
    const workerId2 = generateWorkerId();

    assert.ok(workerId1.startsWith("worker-"));
    assert.ok(workerId2.startsWith("worker-"));
    assert.notEqual(workerId1, workerId2);
  });

  test("claimNextJob claims queued job and updates preview activeBuildId", async () => {
    const workerId = "worker-test-1";
    let rawQueryExecuted = false;
    let previewUpdated = null;

    // Mock raw query that performs the FOR UPDATE SKIP LOCKED claim
    prisma.$queryRaw = async () => {
      rawQueryExecuted = true;
      return [
        {
          id: "build_claim_1",
          previewId: "prev_claim_1",
          buildNumber: 1,
          status: "RUNNING",
          workerId,
          startedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60000)
        }
      ];
    };

    prisma.preview.update = async ({ where, data }) => {
      previewUpdated = { id: where.id, ...data };
      return previewUpdated;
    };

    const claimed = await claimNextJob(workerId, { leaseDurationSeconds: 60 });
    assert.ok(rawQueryExecuted);
    assert.equal(claimed.id, "build_claim_1");
    assert.equal(claimed.workerId, workerId);
    assert.equal(claimed.status, "RUNNING");
    assert.equal(previewUpdated.id, "prev_claim_1");
    assert.equal(previewUpdated.activeBuildId, "build_claim_1");
    assert.equal(previewUpdated.status, "building");
  });

  test("claimNextJob returns null when no queued jobs exist", async () => {
    prisma.$queryRaw = async () => [];
    const claimed = await claimNextJob("worker-empty");
    assert.equal(claimed, null);
  });

  test("renewLease extends leaseExpiresAt when worker owns the running job", async () => {
    const workerId = "worker-lease-1";
    let updatedData = null;

    prisma.build.findUnique = async () => ({
      id: "build_lease_1",
      workerId,
      status: "RUNNING",
      leaseExpiresAt: new Date(Date.now() + 5000)
    });

    prisma.build.update = async ({ where, data }) => {
      updatedData = { id: where.id, ...data };
      return updatedData;
    };

    const result = await renewLease("build_lease_1", workerId, { leaseDurationSeconds: 30 });
    assert.equal(result.renewed, true);
    assert.ok(result.leaseExpiresAt.getTime() > Date.now() + 20000);
    assert.ok(updatedData.leaseExpiresAt);
  });

  test("renewLease returns renewed: false if job is cancelled, superseded, or owned by another worker", async () => {
    // 1. Owned by different worker
    prisma.build.findUnique = async () => ({
      id: "build_lease_2",
      workerId: "worker-other",
      status: "RUNNING"
    });
    const resDifferent = await renewLease("build_lease_2", "worker-me");
    assert.equal(resDifferent.renewed, false);
    assert.match(resDifferent.reason, /Owned by another worker/);

    // 2. Build has been superseded
    prisma.build.findUnique = async () => ({
      id: "build_lease_3",
      workerId: "worker-me",
      status: "SUPERSEDED"
    });
    const resSuperseded = await renewLease("build_lease_3", "worker-me");
    assert.equal(resSuperseded.renewed, false);
    assert.match(resSuperseded.reason, /not in RUNNING status/);
  });

  test("recoverStaleLeases re-queues expired jobs when attempts < maxAttempts", async () => {
    const expiredBuild = {
      id: "build_stale_1",
      previewId: "prev_stale_1",
      workerId: "worker-dead",
      status: "RUNNING",
      attempt: 1,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 10000)
    };

    prisma.build.findMany = async ({ where }) => {
      if (where.status === "RUNNING") {
        return [expiredBuild];
      }
      return [];
    };

    let buildUpdated = null;
    prisma.build.update = async ({ where, data }) => {
      buildUpdated = { id: where.id, ...data };
      return buildUpdated;
    };

    const report = await recoverStaleLeases();
    assert.equal(report.recoveredCount, 1);
    assert.equal(report.failedCount, 0);
    assert.equal(buildUpdated.status, "QUEUED");
    assert.equal(buildUpdated.attempt, 2);
    assert.equal(buildUpdated.workerId, null);
    assert.equal(buildUpdated.leaseExpiresAt, null);
    assert.match(buildUpdated.errorMessage, /Lease expired on worker worker-dead/);
  });

  test("recoverStaleLeases marks job FAILED when attempt >= maxAttempts", async () => {
    const terminalBuild = {
      id: "build_max_stale",
      previewId: "prev_stale_2",
      workerId: "worker-dead-2",
      status: "RUNNING",
      attempt: 3,
      maxAttempts: 3,
      leaseExpiresAt: new Date(Date.now() - 50000)
    };

    prisma.build.findMany = async () => [terminalBuild];

    let buildUpdated = null;
    let previewUpdated = null;
    prisma.build.update = async ({ where, data }) => {
      buildUpdated = { id: where.id, ...data };
      return buildUpdated;
    };
    prisma.preview.update = async ({ where, data }) => {
      previewUpdated = { id: where.id, ...data };
      return previewUpdated;
    };

    const report = await recoverStaleLeases();
    assert.equal(report.recoveredCount, 0);
    assert.equal(report.failedCount, 1);
    assert.equal(buildUpdated.status, "FAILED");
    assert.ok(buildUpdated.failedAt);
    assert.match(buildUpdated.errorMessage, /Heartbeat lease expired after 3 attempts/);
    assert.equal(previewUpdated.status, "failed");
  });

  test("createWorkerLoop processes a claimed job and stops cleanly", async () => {
    let jobExecuted = false;
    let executedJobId = null;

    const mockJob = {
      id: "build_loop_1",
      previewId: "prev_loop_1",
      status: "RUNNING",
      workerId: "worker-loop-test"
    };

    let claimedOnce = false;
    prisma.$queryRaw = async () => {
      if (!claimedOnce) {
        claimedOnce = true;
        return [mockJob];
      }
      return [];
    };

    prisma.build.findMany = async () => [];
    prisma.preview.update = async () => ({});
    prisma.build.update = async ({ where, data }) => ({ id: where.id, ...data });

    const workerLoop = createWorkerLoop({
      workerId: "worker-loop-test",
      pollIntervalMs: 50,
      leaseDurationSeconds: 10,
      heartbeatIntervalMs: 200,
      executeJob: async (job) => {
        jobExecuted = true;
        executedJobId = job.id;
      }
    });

    assert.equal(workerLoop.isRunning(), false);
    workerLoop.start();
    assert.equal(workerLoop.isRunning(), true);

    // Wait briefly for the loop to poll and execute
    await new Promise((r) => setTimeout(r, 120));

    workerLoop.stop();
    assert.equal(workerLoop.isRunning(), false);
    assert.equal(jobExecuted, true);
    assert.equal(executedJobId, "build_loop_1");
  });
});
