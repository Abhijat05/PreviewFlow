// backend/src/services/statsWorker.js
import docker from "./dockerClient.js";
import { prisma } from "../db.js";
import { getIO } from "../socket.js";
import { logger } from "../utils/logger.js";

const POLL_INTERVAL = 3000; // Balanced 3-second interval prevents Docker socket thrashing
const STORE_INTERVAL = 30000; // Persist metric sample every 30 seconds
const PRUNE_INTERVAL = 60 * 60 * 1000; // Prune expired metrics once per hour
const DEFAULT_RETENTION_HOURS = Number(process.env.METRIC_RETENTION_HOURS) || 168; // 7 days

const lastStoredAt = {};
let lastPrunedAt = 0;

export async function pruneExpiredPreviewMetrics({
  retentionHours = DEFAULT_RETENTION_HOURS,
  client = prisma
} = {}) {
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);
  try {
    const res = await client.previewMetric.deleteMany({
      where: { createdAt: { lt: cutoff } }
    });
    return res?.count || 0;
  } catch {
    return 0;
  }
}

export function startStatsWorker() {
  logger.info("Stats worker started");
  let isTickRunning = false;

  const timer = setInterval(async () => {
    if (isTickRunning) {
      return; // Prevent overlapping poll cycles from thrashing Docker socket
    }
    isTickRunning = true;

    try {
      const now = Date.now();
      if (now - lastPrunedAt > PRUNE_INTERVAL) {
        lastPrunedAt = now;
        await pruneExpiredPreviewMetrics();
      }

      let io;
      try {
        io = getIO();
      } catch {
        return; // Socket not initialized yet
      }

      const previews = await prisma.preview.findMany({
        where: {
          status: { in: ["live", "building"] },
          containerName: { not: null }
        },
        select: {
          id: true,
          containerName: true,
          projectId: true,
          prNumber: true,
          buildStartedAt: true,
          project: {
            select: { userId: true }
          }
        }
      });

      for (const p of previews || []) {
        try {
          const sampleNow = Date.now();
          const last = lastStoredAt[p.id] || 0;
          const needsStore = sampleNow - last > STORE_INTERVAL;

          // Check if any client is actively subscribed to this preview or user channel
          const hasListeners =
            Boolean(io.sockets.adapter.rooms.get(`preview:${p.id}`)?.size) ||
            Boolean(io.sockets.adapter.rooms.get(p.id)?.size) ||
            Boolean(p.project?.userId && io.sockets.adapter.rooms.get(`user:${p.project.userId}`)?.size);

          // Skip querying Docker if no client is watching AND periodic store not due
          if (!hasListeners && !needsStore) {
            continue;
          }

          const container = docker.getContainer(p.containerName);
          const stats = await container.stats({ stream: false });

          /* ---------------- CPU ---------------- */
          const cpuDelta =
            stats.cpu_stats.cpu_usage.total_usage -
            stats.precpu_stats.cpu_usage.total_usage;

          const systemDelta =
            stats.cpu_stats.system_cpu_usage -
            stats.precpu_stats.system_cpu_usage;

          const cpu =
            systemDelta > 0
              ? (cpuDelta / systemDelta) *
                stats.cpu_stats.online_cpus *
                100
              : 0;

          /* ---------------- MEMORY ---------------- */
          const memory = stats.memory_stats.usage || 0;
          const memoryLimit = stats.memory_stats.limit || 1;
          const memoryPercent =
            memoryLimit > 0
              ? (memory / memoryLimit) * 100
              : 0;

          /* ---------------- NETWORK ---------------- */
          let networkRx = 0;
          let networkTx = 0;

          if (stats.networks) {
            for (const iface of Object.values(stats.networks)) {
              networkRx += iface.rx_bytes || 0;
              networkTx += iface.tx_bytes || 0;
            }
          }

          /* ---------------- UPTIME ---------------- */
          const uptime =
            p.buildStartedAt
              ? Math.floor(
                  (Date.now() - new Date(p.buildStartedAt).getTime()) / 1000
                )
              : 0;

          /* ---------------- SCOPED SOCKET EMIT ---------------- */
          if (hasListeners) {
            const target = p.project?.userId
              ? io.to(`preview:${p.id}`).to(p.id).to(`user:${p.project.userId}`)
              : io.to(`preview:${p.id}`).to(p.id);

            target.emit("preview-stats-update", {
              previewId: p.id,
              projectId: p.projectId,
              prNumber: p.prNumber,

              cpu: Number(cpu.toFixed(2)),
              memory,

              memoryLimit,
              memoryPercent: Number(memoryPercent.toFixed(2)),
              networkRx,
              networkTx,
              uptime
            });
          }

          /* ---------------- STORE SAMPLE ---------------- */
          if (needsStore) {
            try {
              await prisma.previewMetric.create({
                data: {
                  previewId: p.id,
                  cpu: Number(cpu.toFixed(2)),
                  memory: BigInt(memory),
                  networkRx: BigInt(networkRx),
                  networkTx: BigInt(networkTx)
                }
              });

              lastStoredAt[p.id] = sampleNow;
            } catch (e) {
              logger.error("Preview metric store failed", { previewId: p.id, err: e });
            }
          }
        } catch {
          // container not ready or stopped
        }
      }
    } catch (err) {
      logger.error("Stats worker tick error", { err });
    } finally {
      isTickRunning = false;
    }
  }, POLL_INTERVAL);

  if (timer.unref) {
    timer.unref();
  }

  return timer;
}
