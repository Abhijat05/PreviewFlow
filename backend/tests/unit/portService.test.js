// backend/tests/unit/portService.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../src/db.js";
import { mockPrisma } from "../helpers/prismaMock.js";
import {
  allocatePort,
  claimPortAtomically,
  releasePort,
  releasePreviewPorts,
  getAllocatedPorts,
  releasePortInMemory,
  getPendingAllocatedPorts
} from "../../src/services/portService.js";

describe("portService Cross-Process Port Allocation Unit Tests", () => {
  let prismaRestore;
  let portTable;

  beforeEach(() => {
    const { restore } = mockPrisma();
    prismaRestore = restore;
    portTable = new Map();

    prisma.portAllocation.findUnique = async ({ where }) => portTable.get(where.port) || null;
    prisma.portAllocation.findMany = async ({ where }) =>
      Array.from(portTable.values()).filter((row) => {
        if (where?.isAllocated !== undefined && row.isAllocated !== where.isAllocated) return false;
        if (where?.previewId && row.previewId !== where.previewId) return false;
        return true;
      });
    prisma.portAllocation.create = async ({ data }) => {
      const record = { ...data };
      portTable.set(record.port, record);
      return record;
    };
    prisma.portAllocation.update = async ({ where, data }) => {
      const existing = portTable.get(where.port);
      if (!existing) throw new Error(`Port ${where.port} not found`);
      const updated = { ...existing, ...data };
      portTable.set(where.port, updated);
      return updated;
    };
    prisma.portAllocation.updateMany = async ({ where, data }) => {
      let count = 0;
      for (const [port, row] of portTable.entries()) {
        if (where?.port !== undefined) {
          if (typeof where.port === "object" && where.port.not !== undefined) {
            if (port === where.port.not) continue;
          } else if (port !== where.port) {
            continue;
          }
        }
        if (where?.buildId && row.buildId !== where.buildId) continue;
        if (where?.previewId && row.previewId !== where.previewId) continue;
        portTable.set(port, { ...row, ...data });
        count++;
      }
      return { count };
    };
  });

  afterEach(() => {
    for (const p of getPendingAllocatedPorts()) {
      releasePortInMemory(p);
    }
    if (prismaRestore) prismaRestore();
  });

  test("allocatePort assigns port inside tier-specific pool and persists DB lease", async () => {
    const freeRes = await allocatePort({
      previewId: "prev_free_1",
      buildId: "build_free_1",
      tier: "FREE",
      osPortChecker: async () => true
    });
    assert.ok(freeRes.port >= 5500 && freeRes.port <= 5700);
    assert.equal(freeRes.dbLeased, true);

    const proRes = await allocatePort({
      previewId: "prev_pro_1",
      buildId: "build_pro_1",
      tier: "PRO",
      osPortChecker: async () => true
    });
    assert.ok(proRes.port >= 5000 && proRes.port <= 5400);

    const allocated = await getAllocatedPorts();
    assert.equal(allocated.length, 2);
  });

  test("allocatePort handles cross-process SQL ON CONFLICT contention cleanly", async () => {
    // Simulate peer worker holding port 5000 when raw query checks SQL lock
    let sqlAttempt = 0;
    prisma.$queryRaw = async (strings, ...values) => {
      sqlAttempt++;
      const port = values[0];
      if (port === 5000 && sqlAttempt === 1) {
        // Peer worker won the PostgreSQL lock for 5000 -> ON CONFLICT WHERE returns 0 rows
        return [];
      }
      const row = { port, isAllocated: true, previewId: values[1], buildId: values[2] };
      portTable.set(port, row);
      return [row];
    };

    const res = await allocatePort({
      previewId: "prev_race_1",
      buildId: "build_race_1",
      tier: "PRO",
      osPortChecker: async () => true
    });

    assert.equal(res.port, 5001, "Should cleanly skip contended port 5000 and acquire 5001");
  });

  test("allocatePort skips OS-bound ports during dual verification", async () => {
    const busyPorts = new Set([5500, 5501, 5502]);
    const res = await allocatePort({
      previewId: "prev_os_1",
      buildId: "build_os_1",
      tier: "FREE",
      osPortChecker: async (port) => !busyPorts.has(port)
    });

    assert.equal(res.port, 5503);
  });

  test("allocatePort reuses preferredPort if free, or assigns fresh port during blue-green rebuild", async () => {
    // 1. Reuse free preferredPort owned by same preview
    portTable.set(5025, {
      port: 5025,
      previewId: "prev_reuse",
      buildId: "build_1",
      tier: "PRO",
      isAllocated: true
    });

    const reuse = await allocatePort({
      previewId: "prev_reuse",
      buildId: "build_2",
      tier: "PRO",
      preferredPort: 5025,
      osPortChecker: async () => true
    });
    assert.equal(reuse.port, 5025);
    releasePortInMemory(5025);

    // 2. Old container is still listening on 5025 (OS busy) -> allocates new port 5000
    const next = await allocatePort({
      previewId: "prev_reuse",
      buildId: "build_3",
      tier: "PRO",
      preferredPort: 5025,
      osPortChecker: async (p) => p !== 5025
    });
    assert.equal(next.port, 5000);
  });

  test("releasePort and releasePreviewPorts reclaim allocated ports and clear memory", async () => {
    await allocatePort({
      previewId: "prev_rel_1",
      buildId: "build_rel_1",
      tier: "PRO",
      osPortChecker: async () => true
    });
    assert.ok(getPendingAllocatedPorts().includes(5000));

    // Releasing with wrong buildId should NOT free port owned by build_rel_1
    const mismatch = await releasePort({ port: 5000, previewId: "prev_rel_1", buildId: "other_build" });
    assert.equal(mismatch.count, 0);
    assert.equal(portTable.get(5000).isAllocated, true);

    await releasePreviewPorts({ previewId: "prev_rel_1" });
    assert.equal(portTable.get(5000).isAllocated, false);
    assert.equal(portTable.get(5000).previewId, null);
    assert.equal(getPendingAllocatedPorts().includes(5000), false);
  });

  test("claimPortAtomically and allocatePort degrade gracefully if PortAllocation table is unmigrated", async () => {
    prisma.portAllocation.findMany = async () => {
      const e = new Error('The table "public.PortAllocation" does not exist');
      e.code = "P2021";
      throw e;
    };
    prisma.portAllocation.findUnique = async () => {
      const e = new Error('The table "public.PortAllocation" does not exist');
      e.code = "P2021";
      throw e;
    };

    const claim = await claimPortAtomically({ port: 5510, previewId: "p1", tier: "FREE" });
    assert.equal(claim.claimed, true);
    assert.equal(claim.unmigrated, true);

    const alloc = await allocatePort({
      previewId: "p1",
      tier: "FREE",
      osPortChecker: async () => true
    });
    assert.equal(alloc.port, 5500);
    assert.equal(alloc.dbLeased, false);
  });
});
