// backend/tests/integration/loadBenchmark.test.js
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import app from "../../src/server.js";
import { prisma } from "../../src/db.js";
import {
  computeLatencyStats,
  runConcurrentTasks,
  benchmarkWorkerContention,
  benchmarkPortAllocation,
  runFullBenchmarkSuite
} from "../../src/services/benchmarkService.js";
import { resetMetrics } from "../../src/services/metricsService.js";

describe("Load Testing & Concurrency Benchmark Gate Suite", () => {
  afterEach(() => {
    resetMetrics();
  });

  test("computeLatencyStats and runConcurrentTasks accurately compute throughput and percentiles", async () => {
    const empty = computeLatencyStats([]);
    assert.equal(empty.count, 0);
    assert.equal(empty.p95Ms, 0);

    const stats = computeLatencyStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    assert.equal(stats.count, 10);
    assert.equal(stats.minMs, 10);
    assert.equal(stats.p50Ms, 50);
    assert.equal(stats.p95Ms, 100);
    assert.equal(stats.maxMs, 100);
    assert.equal(stats.meanMs, 55);

    const visited = new Set();
    const res = await runConcurrentTasks({
      total: 40,
      concurrency: 8,
      workerFn: async (i) => {
        visited.add(i);
        return i * 2;
      }
    });
    assert.equal(visited.size, 40);
    assert.equal(res.results.length, 40);
    assert.equal(res.results[39], 78);
    assert.equal(res.latency.count, 40);
  });

  test("concurrent worker claiming enforces single-claim SKIP LOCKED invariants across racing workers", async () => {
    const res = await benchmarkWorkerContention({ jobCount: 80, workerCount: 16 });
    assert.equal(res.passed, true);
    assert.equal(res.claimedCount, 80);
    assert.equal(res.duplicateClaimCount, 0);
    assert.equal(res.missedCount, 0);
  });

  test("concurrent port allocation maintains zero collisions and zero leaked handles under contention", async () => {
    const res = await benchmarkPortAllocation({ concurrentAllocations: 24, tier: "PRO" });
    assert.equal(res.passed, true);
    assert.equal(res.allocatedCount, 24);
    assert.equal(res.collisionCount, 0);
    assert.equal(res.crossProcessWinnerCount, 1);
    assert.equal(res.pendingLeakedCount, 0);
  });

  test("full 5-scenario concurrency benchmark suite passes SLA thresholds end-to-end", async () => {
    const report = await runFullBenchmarkSuite({
      app,
      prismaClient: prisma,
      scale: "light"
    });

    assert.equal(report.scenarios.length, 5);
    assert.equal(report.summary.allPassed, true, JSON.stringify(report.scenarios, null, 2));

    const http = report.scenarios.find((s) => s.scenario === "http_ingress");
    assert.equal(http.errorCount, 0);
    assert.equal(http.contextBleedCount, 0);

    const webhook = report.scenarios.find((s) => s.scenario === "webhook_storm");
    assert.equal(webhook.errorCount, 0);
    assert.ok(webhook.duplicateCount > 0, "Expected duplicate webhook replay suppression");

    const socket = report.scenarios.find((s) => s.scenario === "socket_fanout");
    assert.equal(socket.crossTenantLeaks, 0);
    assert.equal(socket.deliveredCount, socket.expectedDeliveries);
    assert.equal(socket.leakedActiveGauge, 0);
  });
});
