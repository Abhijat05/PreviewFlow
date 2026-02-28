import docker from "./dockerClient.js";
import { prisma } from "../db.js";
import { getIO } from "../socket.js";

const POLL_INTERVAL = 1000; //default should be 4000
const STORE_INTERVAL = 30000;

const lastStoredAt = {};

export function startStatsWorker() {
  console.log("------Stats worker started------");

  setInterval(async () => {
    try {
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
          buildStartedAt: true  
        }
      });

      for (const p of previews) {
        try {
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

          /* ---------------- SOCKET EMIT ---------------- */
          const io = getIO();
          io.emit("preview-stats-update", {
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

          /* ---------------- STORE SAMPLE ---------------- */
          const now = Date.now();
          const last = lastStoredAt[p.id] || 0;

          if (now - last > STORE_INTERVAL) {
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

              lastStoredAt[p.id] = now;
            } catch (e) {
              console.error("metric store failed", e.message);
            }
          }

        } catch (err) {
          console.log("stats error for", p.containerName, err.message);
        }
      }

    } catch (err) {
      console.error("stats worker error", err);
    }
  }, POLL_INTERVAL);
}