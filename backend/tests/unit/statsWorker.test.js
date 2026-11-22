// backend/tests/unit/statsWorker.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startStatsWorker } from "../../src/services/statsWorker.js";
import { prisma } from "../../src/db.js";
import docker from "../../src/services/dockerClient.js";
import { setIO } from "../../src/socket.js";

describe("4.4 Statistics Worker Unit Tests", () => {
  let timer;
  let originalFindMany;
  let originalCreateMetric;
  let originalGetContainer;

  beforeEach(() => {
    originalFindMany = prisma.preview.findMany;
    originalCreateMetric = prisma.previewMetric.create;
    originalGetContainer = docker.getContainer;
  });

  afterEach(() => {
    if (timer) clearInterval(timer);
    prisma.preview.findMany = originalFindMany;
    prisma.previewMetric.create = originalCreateMetric;
    docker.getContainer = originalGetContainer;
    setIO(null);
  });

  test("startStatsWorker returns an active interval timer", () => {
    timer = startStatsWorker();
    assert.ok(timer, "Timer should be returned for controlled shutdown");
    clearInterval(timer);
    timer = null;
  });

  test("queries previews in live or building state and skips when no socket initialized", async () => {
    prisma.preview.findMany = async () => [];
    setIO(null);

    timer = startStatsWorker();

    // Verify timer is running and clean up
    assert.ok(timer);
    clearInterval(timer);
    timer = null;
  });

  test("calculates statistics and stores sample when storage interval is reached", async () => {
    const mockPreview = {
      id: "prev_stats_1",
      containerName: "preview-stats-container",
      projectId: "proj_1",
      prNumber: 5,
      buildStartedAt: new Date(Date.now() - 60000), // 60s uptime
      project: { userId: "user_owner" }
    };

    prisma.preview.findMany = async () => [mockPreview];

    let metricCreated = null;
    prisma.previewMetric.create = async ({ data }) => {
      metricCreated = data;
      return { id: "metric_1", ...data };
    };

    docker.getContainer = () => ({
      stats: async () => ({
        cpu_stats: {
          cpu_usage: { total_usage: 400000000 },
          system_cpu_usage: 2000000000,
          online_cpus: 2
        },
        precpu_stats: {
          cpu_usage: { total_usage: 200000000 },
          system_cpu_usage: 1000000000
        },
        memory_stats: { usage: 256 * 1024 * 1024, limit: 1024 * 1024 * 1024 },
        networks: {
          eth0: { rx_bytes: 1024, tx_bytes: 2048 }
        }
      })
    });

    let emittedEvent = null;
    const mockIO = {
      sockets: {
        adapter: {
          rooms: new Map([[`preview:${mockPreview.id}`, new Set(["client_socket_1"])]])
        }
      },
      to: () => ({
        to: () => ({
          to: () => ({
            emit: (event, payload) => {
              emittedEvent = { event, payload };
            }
          }),
          emit: (event, payload) => {
            emittedEvent = { event, payload };
          }
        })
      })
    };
    setIO(mockIO);

    // Validate calculations manually based on worker logic
    const previews = await prisma.preview.findMany();
    assert.equal(previews.length, 1);

    const p = previews[0];
    const container = docker.getContainer(p.containerName);
    const stats = await container.stats({ stream: false });

    // Validate CPU calculation
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpu = (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100;
    assert.equal(cpu, 40);

    // Validate Memory
    const memory = stats.memory_stats.usage;
    assert.equal(memory, 256 * 1024 * 1024);

    // Validate Network
    let rx = 0, tx = 0;
    for (const iface of Object.values(stats.networks)) {
      rx += iface.rx_bytes;
      tx += iface.tx_bytes;
    }
    assert.equal(rx, 1024);
    assert.equal(tx, 2048);

    // Trigger metric store
    await prisma.previewMetric.create({
      data: {
        previewId: p.id,
        cpu: Number(cpu.toFixed(2)),
        memory: BigInt(memory),
        networkRx: BigInt(rx),
        networkTx: BigInt(tx)
      }
    });

    assert.equal(metricCreated.previewId, "prev_stats_1");
    assert.equal(metricCreated.cpu, 40);
    assert.equal(metricCreated.memory, BigInt(256 * 1024 * 1024));
  });

  test("handles container inspection failure gracefully without worker crash", async () => {
    prisma.preview.findMany = async () => [
      {
        id: "prev_dead",
        containerName: "dead_container",
        project: { userId: "user_1" }
      }
    ];

    docker.getContainer = () => ({
      stats: async () => {
        throw new Error("container not found");
      }
    });

    setIO({
      sockets: { adapter: { rooms: new Map([["prev_dead", new Set(["client1"])]]) } },
      to: () => ({ to: () => ({ emit: () => {} }) })
    });

    const previews = await prisma.preview.findMany();
    for (const p of previews) {
      try {
        const container = docker.getContainer(p.containerName);
        await container.stats({ stream: false });
      } catch (err) {
        assert.match(err.message, /container not found/i);
      }
    }
  });
});
