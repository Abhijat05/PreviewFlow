// backend/src/services/reconciliationService.js
import { execFile } from "child_process";
import { prisma as defaultPrisma } from "../db.js";
import { recoverStaleLeases } from "./buildWorker.js";
import {
  getDockerExecutable,
  inspectContainerState,
  removeContainer
} from "./dockerService.js";
import {
  claimPortAtomically,
  isPortFree,
  releasePort,
  releasePreviewPorts
} from "./portService.js";
import { cleanupOrphanedBuildDirs } from "./repoService.js";

export const RECONCILIATION_LOCK_ID = 724918;

function defaultExec(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function isUnmigratedError(err) {
  return Boolean(err?.code === "P2021" || err?.message?.includes("does not exist"));
}

/**
 * Lists all Docker containers managed by PreviewFlow via the `previewflow.managed=true` label.
 */
export async function listManagedContainers({ execFn = defaultExec } = {}) {
  const dockerBin = getDockerExecutable();
  const { err, stdout } = await execFn(dockerBin, [
    "ps",
    "-a",
    "--filter",
    "label=previewflow.managed=true",
    "--format",
    '{{.Names}}|{{.State}}|{{.Label "previewflow.previewId"}}|{{.Label "previewflow.buildId"}}|{{.Label "previewflow.port"}}'
  ]);

  if (err) {
    return { dockerAvailable: false, containers: [] };
  }

  const containers = [];
  for (const rawLine of (stdout || "").trim().split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [name, state, previewId, buildId, portRaw] = line.split("|");
    if (!name) continue;
    const parsedPort = portRaw ? Number.parseInt(portRaw, 10) : null;
    containers.push({
      name,
      state: (state || "").toLowerCase(),
      previewId: previewId || null,
      buildId: buildId || null,
      port: Number.isInteger(parsedPort) ? parsedPort : null
    });
  }

  return { dockerAvailable: true, containers };
}

async function tryAcquireAdvisoryLock(client) {
  if (typeof client.$queryRaw !== "function") {
    return { locked: true, pgSupported: false };
  }

  try {
    const res = await client.$queryRaw`
      SELECT pg_try_advisory_lock(${RECONCILIATION_LOCK_ID}) AS acquired;
    `;
    if (Array.isArray(res) && res.length > 0) {
      return { locked: Boolean(res[0].acquired), pgSupported: true };
    }
    return { locked: true, pgSupported: false };
  } catch {
    return { locked: true, pgSupported: false };
  }
}

async function releaseAdvisoryLock(client) {
  if (typeof client.$queryRaw !== "function") return;
  try {
    await client.$queryRaw`
      SELECT pg_advisory_unlock(${RECONCILIATION_LOCK_ID});
    `;
  } catch {
    // ignore lock release failure on shutdown
  }
}

/**
 * Startup reconciliation subsystem:
 *   1. Recovers stale build worker leases.
 *   2. Unsticks orphaned "building" previews that have no active/queued jobs.
 *   3. Inspects Docker containers: preserves healthy live containers, attempts restart
 *      for unexpectedly exited live containers, and prunes orphan/stale containers.
 *   4. Reconciles PostgreSQL PortAllocation table: frees leaked ports and syncs live previews.
 *   5. Prunes stale temporary build directories.
 */
export async function runStartupReconciliation({
  client = defaultPrisma,
  execFn = defaultExec,
  containerRemover = removeContainer,
  inspectFn = inspectContainerState,
  diskCleanupFn = cleanupOrphanedBuildDirs,
  isPortFreeFn = isPortFree
} = {}) {
  const report = {
    skipped: false,
    unmigrated: false,
    staleBuildsRecovered: 0,
    staleBuildsFailed: 0,
    unstuckPreviews: 0,
    restoredLivePreviews: 0,
    preservedContainers: 0,
    restartedContainers: 0,
    prunedContainers: 0,
    releasedPorts: 0,
    syncedPorts: 0,
    cleanedDirs: 0
  };

  const lock = await tryAcquireAdvisoryLock(client);
  if (lock.pgSupported && !lock.locked) {
    return { ...report, skipped: true, reason: "advisory_lock_held" };
  }

  try {
    // 1. Recover stale Build worker leases
    const staleReport = await recoverStaleLeases({ client });
    if (staleReport.unmigrated) {
      return { ...report, unmigrated: true };
    }
    report.staleBuildsRecovered = staleReport.recoveredCount || 0;
    report.staleBuildsFailed = staleReport.failedCount || 0;

    // 2. Discover Docker managed containers safely
    const { dockerAvailable, containers } = await listManagedContainers({ execFn });
    const containerByName = new Map(containers.map((c) => [c.name, c]));

    // 3. Unstick orphaned "building" previews with zero remaining QUEUED/RUNNING/RETRYING builds
    let buildingPreviews = [];
    try {
      buildingPreviews = await client.preview.findMany({
        where: { status: "building" }
      });
    } catch {
      buildingPreviews = [];
    }

    for (const preview of buildingPreviews || []) {
      const previewBuilds = await client.build.findMany({
        where: { previewId: preview.id }
      });
      const hasPendingWork = (previewBuilds || []).some(
        (b) => b.status === "QUEUED" || b.status === "RUNNING" || b.status === "RETRYING"
      );

      if (hasPendingWork) continue;

      let containerRunning = false;
      if (preview.containerName && preview.url) {
        const managed = containerByName.get(preview.containerName);
        if (managed) {
          containerRunning = managed.state === "running";
        } else if (inspectFn) {
          const state = await inspectFn(preview.containerName);
          containerRunning = Boolean(state?.running);
        }
      }

      if (containerRunning && preview.url) {
        await client.preview.update({
          where: { id: preview.id },
          data: { status: "live", buildCompletedAt: new Date() }
        });
        report.restoredLivePreviews++;
      } else {
        await client.preview.update({
          where: { id: preview.id },
          data: {
            status: "error",
            url: null,
            containerName: null,
            port: null,
            activeBuildId: null,
            buildCompletedAt: new Date()
          }
        });
        await releasePreviewPorts({ previewId: preview.id, client });
        report.unstuckPreviews++;
      }
    }

    // 4. Reconcile Docker containers against non-deleted previews and active builds
    const nonDeletedPreviews =
      (await client.preview.findMany({
        where: { status: { not: "deleted" } },
        include: { project: { include: { user: true } } }
      })) || [];

    const allRunningBuilds =
      (await client.build.findMany({
        where: { status: "RUNNING" }
      })) || [];

    const activePreviewById = new Map();
    const expectedContainerNames = new Set();
    const expectedBuildIds = new Set();

    for (const p of nonDeletedPreviews) {
      activePreviewById.set(p.id, p);
      if ((p.status === "live" || p.status === "building") && p.containerName) {
        expectedContainerNames.add(p.containerName);
      }
      if (p.activeBuildId) {
        expectedBuildIds.add(p.activeBuildId);
      }
    }
    for (const b of allRunningBuilds) {
      expectedBuildIds.add(b.id);
      if (b.containerName) expectedContainerNames.add(b.containerName);
    }

    if (dockerAvailable) {
      const dockerBin = getDockerExecutable();
      for (const c of containers) {
        const preview = c.previewId ? activePreviewById.get(c.previewId) : null;
        const isExpectedPreviewContainer =
          Boolean(preview && (preview.status === "live" || preview.status === "building")) &&
          (preview.containerName === c.name || (c.buildId && expectedBuildIds.has(c.buildId)));
        const isExpectedByNameOrBuild =
          expectedContainerNames.has(c.name) || Boolean(c.buildId && expectedBuildIds.has(c.buildId));

        if (isExpectedPreviewContainer || isExpectedByNameOrBuild) {
          if (c.state === "running") {
            // Preserve healthy running container without interrupting traffic
            report.preservedContainers++;
          } else if (preview && preview.status === "live" && preview.containerName === c.name) {
            // Live preview exited unexpectedly — try restarting once
            const startRes = await execFn(dockerBin, ["start", c.name]);
            const inspected = startRes.err ? null : await inspectFn(c.name);
            if (!startRes.err && inspected?.running) {
              report.restartedContainers++;
            } else {
              await containerRemover(c.name).catch(() => {});
              await client.preview.update({
                where: { id: preview.id },
                data: {
                  status: "error",
                  url: null,
                  containerName: null,
                  port: null,
                  activeBuildId: null,
                  buildCompletedAt: new Date()
                }
              });
              await releasePreviewPorts({ previewId: preview.id, client });
              report.prunedContainers++;
            }
          } else {
            // Dead container not backed by a live preview
            await containerRemover(c.name).catch(() => {});
            report.prunedContainers++;
          }
        } else {
          // Orphaned / deleted / superseded container -> prune immediately
          await containerRemover(c.name).catch(() => {});
          report.prunedContainers++;
        }
      }
    }

    // 5. Reconcile PortAllocation table
    try {
      const refreshedPreviews =
        (await client.preview.findMany({
          where: { status: { not: "deleted" } },
          include: { project: { include: { user: true } } }
        })) || [];

      const activePortToPreview = new Map();
      const liveOrBuildingById = new Map();

      for (const p of refreshedPreviews) {
        if (p.status === "live" || p.status === "building") {
          liveOrBuildingById.set(p.id, p);
          if (p.port) {
            activePortToPreview.set(p.port, p);
          }
        }
      }

      const runningBuildIds = new Set(allRunningBuilds.map((b) => b.id));
      const allocatedRows =
        (await client.portAllocation?.findMany({
          where: { isAllocated: true }
        })) || [];

      for (const alloc of allocatedRows) {
        const heldByPreview = alloc.previewId ? liveOrBuildingById.get(alloc.previewId) : null;
        const heldByRunningBuild = alloc.buildId && runningBuildIds.has(alloc.buildId);

        let keepLease = false;
        if (heldByRunningBuild) {
          keepLease = true;
        } else if (heldByPreview && heldByPreview.port === alloc.port) {
          // Verify OS / container reality: if a preview was marked live without a running process on port and OS port is free while docker is available, release if dead
          if (dockerAvailable && heldByPreview.containerName && !containerByName.has(heldByPreview.containerName)) {
            const state = await inspectFn(heldByPreview.containerName);
            const osStillFree = await isPortFreeFn(alloc.port);
            keepLease = Boolean(state?.running || !osStillFree);
          } else {
            keepLease = true;
          }
        }

        if (keepLease) {
          await client.portAllocation.update({
            where: { port: alloc.port },
            data: { lastVerifiedAt: new Date() }
          });
        } else {
          await releasePort({ port: alloc.port, client });
          report.releasedPorts++;
        }
      }

      // Sync existing live previews into PortAllocation so future allocations respect them
      for (const [port, preview] of activePortToPreview.entries()) {
        const tier = preview.project?.user?.tier || "FREE";
        const claim = await claimPortAtomically({
          port,
          previewId: preview.id,
          buildId: preview.activeBuildId || null,
          tier,
          client
        });
        if (claim.claimed && !claim.unmigrated) {
          report.syncedPorts++;
        }
      }
    } catch (err) {
      if (!isUnmigratedError(err)) {
        throw err;
      }
    }

    // 6. Clean orphaned filesystem temp build directories
    try {
      report.cleanedDirs = diskCleanupFn() || 0;
    } catch {
      report.cleanedDirs = 0;
    }

    return report;
  } finally {
    if (lock.pgSupported && lock.locked) {
      await releaseAdvisoryLock(client);
    }
  }
}
