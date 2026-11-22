// backend/tests/unit/containerStats.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getContainerStats } from "../../src/services/containerStats.js";
import docker from "../../src/services/dockerClient.js";

describe("4.5 Container Metrics Service Unit Tests", () => {
  let originalGetContainer;

  beforeEach(() => {
    originalGetContainer = docker.getContainer;
  });

  afterEach(() => {
    docker.getContainer = originalGetContainer;
  });

  test("calculates accurate CPU, memory, and network statistics from valid Docker stats payload", async () => {
    docker.getContainer = (name) => ({
      stats: async ({ stream }) => ({
        cpu_stats: {
          cpu_usage: { total_usage: 200000000 },
          system_cpu_usage: 1000000000,
          online_cpus: 2
        },
        precpu_stats: {
          cpu_usage: { total_usage: 100000000 },
          system_cpu_usage: 500000000
        },
        memory_stats: {
          usage: 128 * 1024 * 1024,
          limit: 512 * 1024 * 1024
        },
        networks: {
          eth0: { rx_bytes: 5000, tx_bytes: 8000 },
          eth1: { rx_bytes: 2000, tx_bytes: 1000 }
        }
      })
    });

    const result = await getContainerStats("test-container");

    // cpuDelta = 100000000, systemDelta = 500000000 => (1/5) * 2 * 100 = 40.00%
    assert.equal(result.cpu, "40.00");
    assert.equal(result.memoryUsage, 128 * 1024 * 1024);
    assert.equal(result.memoryLimit, 512 * 1024 * 1024);
    assert.deepEqual(result.network, { rx: 7000, tx: 9000 });
  });

  test("handles zero system_cpu_usage delta by returning 0.00% CPU", async () => {
    docker.getContainer = () => ({
      stats: async () => ({
        cpu_stats: {
          cpu_usage: { total_usage: 100 },
          system_cpu_usage: 500,
          online_cpus: 1
        },
        precpu_stats: {
          cpu_usage: { total_usage: 100 },
          system_cpu_usage: 500 // delta is 0
        },
        memory_stats: { usage: 1000, limit: 10000 }
      })
    });

    const result = await getContainerStats("zero-delta-container");
    assert.equal(result.cpu, "0.00");
  });

  test("handles missing networks field by returning 0 rx and tx bytes", async () => {
    docker.getContainer = () => ({
      stats: async () => ({
        cpu_stats: {
          cpu_usage: { total_usage: 200 },
          system_cpu_usage: 1000,
          online_cpus: 1
        },
        precpu_stats: {
          cpu_usage: { total_usage: 100 },
          system_cpu_usage: 500
        },
        memory_stats: { usage: 500, limit: 1000 }
        // networks omitted
      })
    });

    const result = await getContainerStats("no-network-container");
    assert.deepEqual(result.network, { rx: 0, tx: 0 });
  });

  test("propagates container stats query errors correctly", async () => {
    docker.getContainer = () => ({
      stats: async () => {
        throw new Error("No such container: deadbeef123");
      }
    });

    await assert.rejects(
      async () => getContainerStats("non-existent-container"),
      (err) => {
        assert.match(err.message, /No such container/i);
        return true;
      }
    );
  });
});
