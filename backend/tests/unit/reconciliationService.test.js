// backend/tests/unit/reconciliationService.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../src/db.js";
import { mockPrisma } from "../helpers/prismaMock.js";
import { runStartupReconciliation } from "../../src/services/reconciliationService.js";

describe("reconciliationService Startup Recovery & Preservation Unit Tests", () => {
  let prismaRestore;
  let previews;
  let builds;
  let portAllocations;

  beforeEach(() => {
    const { restore } = mockPrisma();
    prismaRestore = restore;
    previews = new Map();
    builds = new Map();
    portAllocations = new Map();

    prisma.preview.findMany = async ({ where } = {}) =>
      Array.from(previews.values()).filter((p) => {
        if (where?.status === "building") return p.status === "building";
        if (where?.status?.not) return p.status !== where.status.not;
        return true;
      });

    prisma.preview.update = async ({ where, data }) => {
      const existing = previews.get(where.id);
      if (!existing) throw new Error(`Preview ${where.id} not found`);
      const updated = { ...existing, ...data };
      previews.set(where.id, updated);
      return updated;
    };

    prisma.build.findMany = async ({ where } = {}) =>
      Array.from(builds.values()).filter((b) => {
        if (where?.previewId && b.previewId !== where.previewId) return false;
        if (where?.status && b.status !== where.status) return false;
        return true;
      });

    prisma.build.update = async ({ where, data }) => {
      const existing = builds.get(where.id);
      if (!existing) throw new Error(`Build ${where.id} not found`);
      const updated = { ...existing, ...data };
      builds.set(where.id, updated);
      return updated;
    };

    prisma.portAllocation.findMany = async ({ where } = {}) =>
      Array.from(portAllocations.values()).filter((row) => {
        if (where?.isAllocated !== undefined && row.isAllocated !== where.isAllocated) return false;
        if (where?.previewId && row.previewId !== where.previewId) return false;
        return true;
      });

    prisma.portAllocation.findUnique = async ({ where }) => portAllocations.get(where.port) || null;
    prisma.portAllocation.create = async ({ data }) => {
      const r = { ...data };
      portAllocations.set(r.port, r);
      return r;
    };
    prisma.portAllocation.update = async ({ where, data }) => {
      const existing = portAllocations.get(where.port);
      const updated = { ...existing, ...data };
      portAllocations.set(where.port, updated);
      return updated;
    };
    prisma.portAllocation.updateMany = async ({ where, data }) => {
      let count = 0;
      for (const [port, row] of portAllocations.entries()) {
        if (where?.port !== undefined) {
          if (typeof where.port === "object" && where.port.not !== undefined) {
            if (port === where.port.not) continue;
          } else if (port !== where.port) continue;
        }
        if (where?.previewId && row.previewId !== where.previewId) continue;
        if (where?.buildId && row.buildId !== where.buildId) continue;
        portAllocations.set(port, { ...row, ...data });
        count++;
      }
      return { count };
    };
  });

  afterEach(() => {
    if (prismaRestore) prismaRestore();
  });

  test("preserves healthy running containers, prunes orphan containers, and reclaims leaked ports", async () => {
    // 1. Seed a live preview whose container IS healthy and running
    previews.set("prev_live_ok", {
      id: "prev_live_ok",
      projectId: "proj_1",
      prNumber: 10,
      status: "live",
      url: "http://localhost:5501",
      containerName: "preview-live-healthy",
      port: 5501,
      activeBuildId: "build_live_10",
      project: { user: { tier: "FREE" } }
    });
    builds.set("build_live_10", {
      id: "build_live_10",
      previewId: "prev_live_ok",
      status: "COMPLETED"
    });

    // 2. Seed a deleted preview that leaked port 5509
    previews.set("prev_deleted", {
      id: "prev_deleted",
      projectId: "proj_1",
      prNumber: 11,
      status: "deleted",
      port: null
    });
    portAllocations.set(5509, {
      port: 5509,
      previewId: "prev_deleted",
      buildId: null,
      isAllocated: true
    });

    const removedContainers = [];

    const report = await runStartupReconciliation({
      execFn: async (bin, args) => {
        if (args[0] === "ps") {
          return {
            err: null,
            stdout: [
              "preview-live-healthy|running|prev_live_ok|build_live_10|5501",
              "preview-orphan-ghost|running|prev_deleted|build_dead_99|5509"
            ].join("\n")
          };
        }
        return { err: null, stdout: "" };
      },
      containerRemover: async (name) => {
        removedContainers.push(name);
        return true;
      },
      diskCleanupFn: () => 2
    });

    assert.equal(report.preservedContainers, 1);
    assert.equal(report.prunedContainers, 1);
    assert.deepEqual(removedContainers, ["preview-orphan-ghost"]);
    assert.equal(report.releasedPorts, 1);
    assert.equal(report.syncedPorts, 1);
    assert.equal(report.cleanedDirs, 2);

    // Verify healthy preview preserved and port 5501 synced into PortAllocation
    assert.equal(previews.get("prev_live_ok").status, "live");
    assert.equal(portAllocations.get(5501).isAllocated, true);
    assert.equal(portAllocations.get(5501).previewId, "prev_live_ok");

    // Verify leaked port 5509 released
    assert.equal(portAllocations.get(5509).isAllocated, false);
    assert.equal(portAllocations.get(5509).previewId, null);
  });

  test("recovers stale leases, unsticks dead building previews, and restores live previews with running containers", async () => {
    // 1. Dead building preview with no builds left & no running container
    previews.set("prev_stuck", {
      id: "prev_stuck",
      projectId: "proj_1",
      prNumber: 20,
      status: "building",
      url: null,
      containerName: "preview-crashed-20",
      port: 5510
    });
    portAllocations.set(5510, {
      port: 5510,
      previewId: "prev_stuck",
      isAllocated: true
    });

    // 2. Building preview whose previous container is actually running & serving
    previews.set("prev_recoverable", {
      id: "prev_recoverable",
      projectId: "proj_1",
      prNumber: 21,
      status: "building",
      url: "http://localhost:5511",
      containerName: "preview-running-21",
      port: 5511,
      project: { user: { tier: "FREE" } }
    });

    const report = await runStartupReconciliation({
      execFn: async (bin, args) => {
        if (args[0] === "ps") {
          return {
            err: null,
            stdout: "preview-running-21|running|prev_recoverable||5511"
          };
        }
        return { err: null, stdout: "" };
      },
      containerRemover: async () => true,
      diskCleanupFn: () => 0
    });

    assert.equal(report.unstuckPreviews, 1);
    assert.equal(report.restoredLivePreviews, 1);
    assert.equal(previews.get("prev_stuck").status, "error");
    assert.equal(previews.get("prev_stuck").port, null);
    assert.equal(portAllocations.get(5510).isAllocated, false);

    assert.equal(previews.get("prev_recoverable").status, "live");
    assert.equal(portAllocations.get(5511).isAllocated, true);
  });

  test("attempts restart for exited live container and marks error if container fails to restart", async () => {
    previews.set("prev_exit_ok", {
      id: "prev_exit_ok",
      projectId: "proj_1",
      prNumber: 30,
      status: "live",
      url: "http://localhost:5520",
      containerName: "preview-exit-ok",
      port: 5520,
      project: { user: { tier: "FREE" } }
    });
    previews.set("prev_exit_dead", {
      id: "prev_exit_dead",
      projectId: "proj_1",
      prNumber: 31,
      status: "live",
      url: "http://localhost:5521",
      containerName: "preview-exit-dead",
      port: 5521,
      project: { user: { tier: "FREE" } }
    });
    portAllocations.set(5521, { port: 5521, previewId: "prev_exit_dead", isAllocated: true });

    const startedContainers = [];
    const removedContainers = [];

    const report = await runStartupReconciliation({
      execFn: async (bin, args) => {
        if (args[0] === "ps") {
          return {
            err: null,
            stdout: [
              "preview-exit-ok|exited|prev_exit_ok||5520",
              "preview-exit-dead|exited|prev_exit_dead||5521"
            ].join("\n")
          };
        }
        if (args[0] === "start") {
          startedContainers.push(args[1]);
          return { err: null, stdout: args[1] };
        }
        return { err: null, stdout: "" };
      },
      inspectFn: async (name) =>
        name === "preview-exit-ok"
          ? { status: "running", running: true, exitCode: 0 }
          : { status: "exited", running: false, exitCode: 1 },
      containerRemover: async (name) => {
        removedContainers.push(name);
        return true;
      },
      diskCleanupFn: () => 0
    });

    assert.deepEqual(startedContainers, ["preview-exit-ok", "preview-exit-dead"]);
    assert.deepEqual(removedContainers, ["preview-exit-dead"]);
    assert.equal(report.restartedContainers, 1);
    assert.equal(report.prunedContainers, 1);
    assert.equal(previews.get("prev_exit_ok").status, "live");
    assert.equal(previews.get("prev_exit_dead").status, "error");
    assert.equal(portAllocations.get(5521).isAllocated, false);
  });

  test("skips startup reconciliation when PostgreSQL advisory lock is held by a peer instance", async () => {
    prisma.$queryRaw = async () => [{ acquired: false }];

    const report = await runStartupReconciliation();
    assert.equal(report.skipped, true);
    assert.equal(report.reason, "advisory_lock_held");
  });
});
