import docker from "./dockerClient.js";
import { prisma } from "../db.js";
import { getIO } from "../socket.js";

const POLL_INTERVAL = 4000;
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
          prNumber: true
        }
      });

      for (const p of previews) {
        try {
          const container = docker.getContainer(p.containerName);
          const stats = await container.stats({ stream: false });

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

          const memory = stats.memory_stats.usage || 0;
          const io = getIO();
          io.emit("preview-stats-update", {
            previewId: p.id,
            projectId: p.projectId,
            prNumber: p.prNumber,
            cpu: Number(cpu.toFixed(2)),
            memory
          });

          const now = Date.now();
          const last = lastStoredAt[p.id] || 0;

          if (now - last > STORE_INTERVAL) {
            try {
              await prisma.previewMetric.create({
                data: {
                  previewId: p.id,
                  cpu: Number(cpu.toFixed(2)),
                  memory: BigInt(memory)
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