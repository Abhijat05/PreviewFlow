// backend/src/services/buildWorker.js
import os from "os";
import { prisma as defaultPrisma } from "../db.js";
import { logger, runWithContext } from "../utils/logger.js";
import { defaultAlertManager } from "./alertService.js";

/**
 * Generates a unique worker ID containing hostname, PID, and timestamp.
 */
export function generateWorkerId() {
  const host = os.hostname().replace(/[^a-zA-Z0-9-]/g, "").toLowerCase() || "node";
  const pid = process.pid;
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `worker-${host}-${pid}-${time}-${rand}`;
}

/**
 * Atomically claims the next QUEUED build job using PostgreSQL FOR UPDATE SKIP LOCKED.
 * Updates the build to RUNNING, sets the workerId, startedAt, and leaseExpiresAt,
 * and updates the associated preview to building status.
 */
export async function claimNextJob(
  workerId,
  { leaseDurationSeconds = 60, client = defaultPrisma } = {}
) {
  if (!workerId) {
    throw new Error("workerId is required to claim a job");
  }

  // Atomically select and update the next queued job
  let rows;
  try {
    rows = await client.$queryRaw`
      WITH next_job AS (
        SELECT id
        FROM "Build"
        WHERE status = 'QUEUED'
        ORDER BY "queuedAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "Build" b
      SET status = 'RUNNING',
          "workerId" = ${workerId},
          "startedAt" = NOW(),
          "leaseExpiresAt" = NOW() + (${leaseDurationSeconds} || ' seconds')::INTERVAL
      FROM next_job
      WHERE b.id = next_job.id
      RETURNING b.*;
    `;
  } catch (err) {
    if (err.code === "P2021" || err.message?.includes("does not exist")) {
      return null;
    }
    throw err;
  }

  if (!rows || rows.length === 0) {
    return null;
  }

  const job = rows[0];

  // Mark the associated preview as actively building
  if (job.previewId) {
    await client.preview.update({
      where: { id: job.previewId },
      data: {
        activeBuildId: job.id,
        status: "building"
      }
    });
  }

  return job;
}

/**
 * Renews the lease on a running job so long as the caller is still the assigned worker.
 */
export async function renewLease(
  buildId,
  workerId,
  { leaseDurationSeconds = 60, client = defaultPrisma } = {}
) {
  const build = await client.build.findUnique({
    where: { id: buildId }
  });

  if (!build) {
    return { renewed: false, reason: "Build not found" };
  }

  if (build.workerId !== workerId) {
    return {
      renewed: false,
      reason: `Owned by another worker (${build.workerId || "none"})`
    };
  }

  if (build.status !== "RUNNING") {
    return {
      renewed: false,
      reason: `Build is not in RUNNING status (${build.status})`
    };
  }

  const newExpiresAt = new Date(Date.now() + leaseDurationSeconds * 1000);

  await client.build.update({
    where: { id: buildId },
    data: { leaseExpiresAt: newExpiresAt }
  });

  return { renewed: true, leaseExpiresAt: newExpiresAt };
}

/**
 * Recovers stale builds whose worker lease expired without a heartbeat.
 * Re-queues the build if attempts < maxAttempts, otherwise marks it FAILED.
 */
export async function recoverStaleLeases({ client = defaultPrisma } = {}) {
  const now = new Date();

  // Find RUNNING builds whose lease has expired
  let runningBuilds;
  try {
    runningBuilds = await client.build.findMany({
      where: { status: "RUNNING" }
    });
  } catch (err) {
    if (err.code === "P2021" || err.message?.includes("does not exist")) {
      return {
        recoveredCount: 0,
        failedCount: 0,
        recoveredBuildIds: [],
        unmigrated: true
      };
    }
    throw err;
  }

  const staleBuilds = runningBuilds.filter(
    (b) => b.leaseExpiresAt && new Date(b.leaseExpiresAt).getTime() < now.getTime()
  );

  let recoveredCount = 0;
  let failedCount = 0;
  const recoveredBuildIds = [];

  for (const stale of staleBuilds) {
    const currentAttempt = stale.attempt || 1;
    const maxAttempts = stale.maxAttempts || 3;

    if (currentAttempt < maxAttempts) {
      await client.build.update({
        where: { id: stale.id },
        data: {
          status: "QUEUED",
          attempt: currentAttempt + 1,
          workerId: null,
          leaseExpiresAt: null,
          errorMessage: `Lease expired on worker ${stale.workerId || "unknown"}, re-queued for attempt ${currentAttempt + 1}`
        }
      });
      recoveredCount++;
      recoveredBuildIds.push(stale.id);
    } else {
      await client.build.update({
        where: { id: stale.id },
        data: {
          status: "FAILED",
          failedAt: new Date(),
          errorMessage: `Heartbeat lease expired after ${maxAttempts} attempts on worker ${stale.workerId || "unknown"}`
        }
      });
      failedCount++;

      if (stale.previewId) {
        await client.preview.update({
          where: { id: stale.previewId },
          data: { status: "failed" }
        });
      }
    }
  }

  if (recoveredCount + failedCount > 0) {
    defaultAlertManager.recordLeaseRecoveries(recoveredCount + failedCount);
    logger.warn("Recovered stale build leases", {
      recoveredCount,
      failedCount,
      recoveredBuildIds
    });
  }

  return {
    recoveredCount,
    failedCount,
    recoveredBuildIds
  };
}

/**
 * Factory for a worker polling loop that continuously recovers stale leases,
 * claims jobs, heartbeats leases during execution, and executes build handlers.
 */
export function createWorkerLoop({
  workerId = generateWorkerId(),
  pollIntervalMs = 2000,
  leaseDurationSeconds = 60,
  heartbeatIntervalMs = 15000,
  executeJob,
  client = defaultPrisma
} = {}) {
  let running = false;
  let pollTimer = null;
  let currentHeartbeat = null;
  let currentAbortController = null;
  let hasWarnedUnmigrated = false;

  async function poll() {
    if (!running) return;

    try {
      // 1. Check and recover stale leases from dead workers
      const staleReport = await recoverStaleLeases({ client });
      if (staleReport.unmigrated) {
        if (!hasWarnedUnmigrated) {
          hasWarnedUnmigrated = true;
          logger.warn("Build table unmigrated; build worker pausing until schema push");
        }
        return;
      }
      hasWarnedUnmigrated = false;

      // 2. Claim next available job
      const job = await claimNextJob(workerId, { leaseDurationSeconds, client });

      if (job && executeJob) {
        currentAbortController = new AbortController();

        // Start heartbeat renewal while job executes
        currentHeartbeat = setInterval(async () => {
          try {
            const res = await renewLease(job.id, workerId, {
              leaseDurationSeconds,
              client
            });
            if (!res.renewed && currentAbortController) {
              // Lease lost (e.g. superseded or cancelled)
              currentAbortController.abort();
            }
          } catch (err) {
            logger.error("Worker failed to renew lease", { workerId, buildId: job.id, err });
          }
        }, heartbeatIntervalMs);

        // Keep heartbeat from preventing event loop shutdown
        if (currentHeartbeat.unref) {
          currentHeartbeat.unref();
        }

        try {
          await runWithContext(
            { workerId, buildId: job.id, previewId: job.previewId },
            () =>
              executeJob(job, {
                abortSignal: currentAbortController.signal,
                renewLease: (sec) =>
                  renewLease(job.id, workerId, {
                    leaseDurationSeconds: sec || leaseDurationSeconds,
                    client
                  })
              })
          );
        } finally {
          if (currentHeartbeat) {
            clearInterval(currentHeartbeat);
            currentHeartbeat = null;
          }
          currentAbortController = null;
        }
      }
    } catch (err) {
      logger.error("Worker polling error", { workerId, err });
    } finally {
      if (running) {
        pollTimer = setTimeout(poll, pollIntervalMs);
        if (pollTimer.unref) {
          pollTimer.unref();
        }
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      poll();
    },
    stop() {
      running = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (currentHeartbeat) {
        clearInterval(currentHeartbeat);
        currentHeartbeat = null;
      }
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }
    },
    isRunning() {
      return running;
    },
    getWorkerId() {
      return workerId;
    }
  };
}
