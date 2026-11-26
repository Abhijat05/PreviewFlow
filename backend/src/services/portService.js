// backend/src/services/portService.js
import net from "net";
import { prisma as defaultPrisma } from "../db.js";
import { getPortPoolForTier } from "../middleware/subscription.js";
import { normalizeTier } from "../middleware/tierLimits.js";

// Process-local guard eliminating intra-process TOCTOU races between DB query & OS bind
const pendingAllocatedPorts = new Set();
let allocationMutex = Promise.resolve();

function acquirePortLock() {
  let release;
  const nextLock = new Promise((resolve) => {
    release = resolve;
  });
  const currentLock = allocationMutex;
  allocationMutex = currentLock.then(() => nextLock);
  return currentLock.then(() => release);
}

function isUnmigratedError(err) {
  return Boolean(
    err?.code === "P2021" ||
    err?.message?.includes("does not exist") ||
    err?.message?.includes("PortAllocation")
  );
}

export function reservePortInMemory(port) {
  pendingAllocatedPorts.add(port);
}

export function releasePortInMemory(port) {
  pendingAllocatedPorts.delete(port);
}

export function getPendingAllocatedPorts() {
  return Array.from(pendingAllocatedPorts);
}

/**
 * Check if a TCP port is free on localhost (127.0.0.1).
 * Resolves true if free, false if bound.
 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => {
        resolve(false);
      })
      .once("listening", () => {
        tester.close(() => resolve(true));
      })
      .listen(port, "127.0.0.1");
  });
}

/**
 * Determine if a port is reserved in the Preview table for a non-deleted preview.
 */
export async function portReservedInDB(port, client = defaultPrisma) {
  const existing = await client.preview.findFirst({
    where: { port, status: { not: "deleted" } }
  });
  return !!existing;
}

/**
 * Determine if a port is actively leased in PortAllocation (when table exists).
 */
export async function portLeasedInDB(port, { previewId = null, client = defaultPrisma } = {}) {
  try {
    const alloc = await client.portAllocation?.findUnique({ where: { port } });
    if (!alloc || !alloc.isAllocated) return false;
    if (previewId && alloc.previewId === previewId) return false;
    return true;
  } catch (err) {
    if (isUnmigratedError(err)) return false;
    throw err;
  }
}

/**
 * Atomically claims a single port in PostgreSQL PortAllocation table.
 * Uses SQL INSERT ... ON CONFLICT DO UPDATE ... WHERE isAllocated = false
 * for strict cross-process exclusivity, with safe Prisma ORM fallback for unit mocks.
 */
export async function claimPortAtomically({
  port,
  previewId = null,
  buildId = null,
  tier = "FREE",
  client = defaultPrisma
}) {
  const normalizedTier = normalizeTier(tier);

  try {
    // Release any prior port row holding the same buildId to satisfy @unique buildId constraint cleanly
    if (buildId && client.portAllocation?.updateMany) {
      await client.portAllocation.updateMany({
        where: { buildId, port: { not: port } },
        data: { buildId: null }
      });
    }

    // Attempt raw PostgreSQL atomic claim first (returns Array when Postgres / raw mock executes)
    if (typeof client.$queryRaw === "function") {
      const rows = await client.$queryRaw`
        INSERT INTO "PortAllocation" ("port", "previewId", "buildId", "tier", "isAllocated", "allocatedAt", "lastVerifiedAt")
        VALUES (${port}, ${previewId}, ${buildId}, ${normalizedTier}::"UserTier", true, NOW(), NOW())
        ON CONFLICT ("port") DO UPDATE
        SET "isAllocated" = true,
            "previewId" = EXCLUDED."previewId",
            "buildId" = EXCLUDED."buildId",
            "tier" = EXCLUDED."tier",
            "allocatedAt" = NOW(),
            "lastVerifiedAt" = NOW()
        WHERE "PortAllocation"."isAllocated" = false
           OR (${previewId}::text IS NOT NULL AND "PortAllocation"."previewId" = ${previewId}::text)
        RETURNING *;
      `;

      if (Array.isArray(rows)) {
        if (rows.length > 0) {
          return { claimed: true, row: rows[0] };
        }
        return { claimed: false, reason: "already_allocated" };
      }
    }

    // Prisma ORM fallback (for unit tests with mockPrisma where $queryRaw returns null)
    const existing = await client.portAllocation.findUnique({ where: { port } });
    if (!existing) {
      const created = await client.portAllocation.create({
        data: {
          port,
          previewId,
          buildId,
          tier: normalizedTier,
          isAllocated: true,
          allocatedAt: new Date(),
          lastVerifiedAt: new Date()
        }
      });
      return { claimed: true, row: created };
    }

    if (!existing.isAllocated || (previewId && existing.previewId === previewId)) {
      const updated = await client.portAllocation.update({
        where: { port },
        data: {
          isAllocated: true,
          previewId,
          buildId,
          tier: normalizedTier,
          allocatedAt: new Date(),
          lastVerifiedAt: new Date()
        }
      });
      return { claimed: true, row: updated };
    }

    return { claimed: false, reason: "already_allocated" };
  } catch (err) {
    if (isUnmigratedError(err)) {
      return { claimed: true, unmigrated: true };
    }
    throw err;
  }
}

/**
 * Legacy-compatible port finder (checks process memory, DB Preview rows,
 * PortAllocation leases, and OS loopback binding).
 */
export async function findAvailablePort(
  minPort = 5000,
  maxPort = 5999,
  { osPortChecker = isPortFree, client = defaultPrisma } = {}
) {
  const unlock = await acquirePortLock();
  try {
    for (let port = minPort; port <= maxPort; port++) {
      if (pendingAllocatedPorts.has(port)) continue;

      const reserved = await portReservedInDB(port, client);
      if (reserved) continue;

      const leased = await portLeasedInDB(port, { client });
      if (leased) continue;

      /* eslint-disable no-await-in-loop */
      const free = await osPortChecker(port);
      if (!free) continue;

      const reserved2 = await portReservedInDB(port, client);
      if (reserved2) continue;

      pendingAllocatedPorts.add(port);
      return port;
    }
    throw new Error(`No free ports available in configured range (${minPort}-${maxPort})`);
  } finally {
    unlock();
  }
}

/**
 * Allocates and durably leases an available port across processes using PostgreSQL
 * PortAllocation + OS loopback binding verification.
 */
export async function allocatePort({
  previewId = null,
  buildId = null,
  tier = "FREE",
  minPort = null,
  maxPort = null,
  preferredPort = null,
  client = defaultPrisma,
  osPortChecker = isPortFree
} = {}) {
  const normalizedTier = normalizeTier(tier);
  const pool = getPortPoolForTier(normalizedTier);
  const min = minPort ?? pool?.min ?? 5000;
  const max = maxPort ?? pool?.max ?? 5999;

  const unlock = await acquirePortLock();
  try {
    const occupiedPorts = new Set();

    // Load occupied ports from Preview table
    try {
      const usedPreviews = await client.preview.findMany({
        where: {
          port: { not: null },
          status: { not: "deleted" }
        }
      });
      for (const p of usedPreviews || []) {
        if (p.port && p.id !== previewId) {
          occupiedPorts.add(p.port);
        }
      }
    } catch {
      // ignore if minimally mocked
    }

    // Load allocated ports from PortAllocation table
    try {
      const allocs = await client.portAllocation?.findMany({
        where: { isAllocated: true }
      });
      for (const a of allocs || []) {
        if (a.port && (!previewId || a.previewId !== previewId)) {
          occupiedPorts.add(a.port);
        }
      }
    } catch (err) {
      if (!isUnmigratedError(err)) throw err;
    }

    // 1. Try preferredPort first if free on OS and not held by another preview
    if (
      preferredPort &&
      preferredPort >= min &&
      preferredPort <= max &&
      !pendingAllocatedPorts.has(preferredPort) &&
      !occupiedPorts.has(preferredPort)
    ) {
      const osFree = await osPortChecker(preferredPort);
      if (osFree) {
        const claim = await claimPortAtomically({
          port: preferredPort,
          previewId,
          buildId,
          tier: normalizedTier,
          client
        });
        if (claim.claimed) {
          pendingAllocatedPorts.add(preferredPort);
          return { port: preferredPort, dbLeased: !claim.unmigrated };
        }
      }
    }

    // 2. Scan tier pool range and atomically claim in PostgreSQL
    for (let port = min; port <= max; port++) {
      if (pendingAllocatedPorts.has(port)) continue;
      if (occupiedPorts.has(port)) continue;

      // Double check via portReservedInDB for mocks that only stub findFirst
      const reservedByFindFirst = await portReservedInDB(port, client);
      if (reservedByFindFirst) {
        const existingPrev = await client.preview.findFirst({
          where: { port, status: { not: "deleted" } }
        });
        if (!existingPrev || existingPrev.id !== previewId) continue;
      }

      /* eslint-disable no-await-in-loop */
      const osFree = await osPortChecker(port);
      if (!osFree) continue;

      const claim = await claimPortAtomically({
        port,
        previewId,
        buildId,
        tier: normalizedTier,
        client
      });

      if (!claim.claimed) {
        // Race condition won by peer process; add to local skip set and continue
        occupiedPorts.add(port);
        continue;
      }

      pendingAllocatedPorts.add(port);
      return { port, dbLeased: !claim.unmigrated };
    }

    throw new Error(`No free ports available in configured range (${min}-${max})`);
  } finally {
    unlock();
  }
}

/**
 * Releases a single port from process memory and PostgreSQL PortAllocation lease.
 */
export async function releasePort({
  port,
  previewId = null,
  buildId = null,
  client = defaultPrisma
} = {}) {
  if (!port) return { released: false };

  pendingAllocatedPorts.delete(port);

  try {
    const where = { port };
    if (buildId) where.buildId = buildId;
    if (previewId) where.previewId = previewId;

    const res = await client.portAllocation.updateMany({
      where,
      data: {
        isAllocated: false,
        previewId: null,
        buildId: null,
        allocatedAt: null,
        lastVerifiedAt: new Date()
      }
    });

    return { released: true, count: res?.count ?? 0 };
  } catch (err) {
    if (isUnmigratedError(err)) {
      return { released: true, unmigrated: true };
    }
    throw err;
  }
}

/**
 * Releases all ports held by a preview (e.g., on deletion, PR closure, or tier downgrade).
 */
export async function releasePreviewPorts({ previewId, client = defaultPrisma } = {}) {
  if (!previewId) return { count: 0 };

  try {
    const rows = await client.portAllocation.findMany({
      where: { previewId }
    });
    for (const row of rows || []) {
      if (row.port) pendingAllocatedPorts.delete(row.port);
    }

    const res = await client.portAllocation.updateMany({
      where: { previewId },
      data: {
        isAllocated: false,
        previewId: null,
        buildId: null,
        allocatedAt: null,
        lastVerifiedAt: new Date()
      }
    });

    return { count: res?.count ?? rows?.length ?? 0 };
  } catch (err) {
    if (isUnmigratedError(err)) {
      return { count: 0, unmigrated: true };
    }
    throw err;
  }
}

/**
 * Lists currently allocated ports from PostgreSQL.
 */
export async function getAllocatedPorts({ client = defaultPrisma } = {}) {
  try {
    return await client.portAllocation.findMany({
      where: { isAllocated: true },
      orderBy: { port: "asc" }
    });
  } catch (err) {
    if (isUnmigratedError(err)) return [];
    throw err;
  }
}
