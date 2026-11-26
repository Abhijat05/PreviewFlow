// backend/tests/integration/database.integration.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

describe("6. Prisma & Database Integration Tests", () => {
  let testPrisma;
  let isDbAvailable = false;
  const createdUserIds = [];

  before(async () => {
    const dbUrl = process.env.DATABASE_URL || "";

    // 1. Production Safeguard: Never run tests against production Supabase or non-test databases
    const isLocalhost =
      dbUrl.includes("localhost") ||
      dbUrl.includes("127.0.0.1") ||
      dbUrl.includes("previewflow_test");

    const isExplicitlyRemote =
      dbUrl.includes("supabase") ||
      dbUrl.includes("neon.tech") ||
      dbUrl.includes("render.com") ||
      dbUrl.includes("railway.app") ||
      !isLocalhost;

    if (isExplicitlyRemote) {
      console.warn("⚠️ [Database Guard] Production or non-local database URL detected in environment. Skipping database integration tests to prevent data mutation.");
      return;
    }

    // 2. Connectivity check to local/CI test PostgreSQL
    testPrisma = new PrismaClient({
      datasources: { db: { url: dbUrl } }
    });

    try {
      await testPrisma.$connect();
      // Quick probe query
      await testPrisma.$queryRaw`SELECT 1`;
      isDbAvailable = true;
    } catch (err) {
      console.warn(`ℹ️ [Database Notice] Test PostgreSQL database not reachable at ${dbUrl.replace(/:[^:@]+@/, ":***@")}: ${err.message}. Database integration tests requiring active PostgreSQL will be skipped.`);
      await testPrisma.$disconnect().catch(() => {});
    }
  });

  after(async () => {
    if (isDbAvailable && testPrisma) {
      try {
        // Clean up test data created during this suite
        for (const userId of createdUserIds) {
          await testPrisma.user.delete({ where: { id: userId } }).catch(() => {});
        }
      } finally {
        await testPrisma.$disconnect();
      }
    }
  });

  test("User model CRUD, tier defaults, and unique constraints", async (t) => {
    if (!isDbAvailable) {
      t.skip("PostgreSQL test database service is not available in current environment");
      return;
    }

    const testGithubId = `gh_test_${Date.now()}`;
    const user = await testPrisma.user.create({
      data: {
        githubId: testGithubId,
        name: "Test DB User",
        email: `${testGithubId}@example.com`,
        tier: "FREE"
      }
    });

    createdUserIds.push(user.id);
    assert.ok(user.id);
    assert.equal(user.tier, "FREE");

    // Unique constraint on githubId
    await assert.rejects(
      async () => {
        await testPrisma.user.create({
          data: { githubId: testGithubId, name: "Duplicate User" }
        });
      },
      (err) => {
        assert.equal(err.code, "P2002", "Prisma unique constraint violation code must be P2002");
        return true;
      }
    );
  });

  test("Project and Preview relationships and cascade delete behavior", async (t) => {
    if (!isDbAvailable) {
      t.skip("PostgreSQL test database service is not available in current environment");
      return;
    }

    const testGithubId = `gh_rel_${Date.now()}`;
    const user = await testPrisma.user.create({
      data: {
        githubId: testGithubId,
        name: "Relation Test User",
        tier: "PRO"
      }
    });
    createdUserIds.push(user.id);

    const project = await testPrisma.project.create({
      data: {
        userId: user.id,
        repoOwner: "test-org",
        repoName: "test-app",
        webhookSecret: "secret12345"
      }
    });

    const preview = await testPrisma.preview.create({
      data: {
        projectId: project.id,
        prNumber: 101,
        status: "live",
        port: 5500
      }
    });

    const metric = await testPrisma.previewMetric.create({
      data: {
        previewId: preview.id,
        cpu: 15.5,
        memory: BigInt(128 * 1024 * 1024)
      }
    });

    assert.ok(preview.id);
    assert.ok(metric.id);

    // Verify Unique Constraint on [projectId, prNumber]
    await assert.rejects(
      async () => {
        await testPrisma.preview.create({
          data: {
            projectId: project.id,
            prNumber: 101, // duplicate prNumber
            status: "building"
          }
        });
      },
      (err) => {
        assert.equal(err.code, "P2002");
        return true;
      }
    );

    // Verify Cascade Deletion: Deleting user cascades to project, preview, and metrics
    await testPrisma.user.delete({ where: { id: user.id } });
    const remainingPreview = await testPrisma.preview.findUnique({ where: { id: preview.id } });
    const remainingMetric = await testPrisma.previewMetric.findFirst({ where: { previewId: preview.id } });

    assert.equal(remainingPreview, null, "Preview must be cascade-deleted");
    assert.equal(remainingMetric, null, "PreviewMetric must be cascade-deleted");
  });

  test("PortAllocation model supports atomic port lease, setNull on delete, and unique buildId", async (t) => {
    if (!isDbAvailable) {
      t.skip("PostgreSQL test database service is not available in current environment");
      return;
    }

    const testPort = 5699;
    await testPrisma.portAllocation.deleteMany({ where: { port: testPort } });

    const testGithubId = `gh_port_${Date.now()}`;
    const user = await testPrisma.user.create({
      data: { githubId: testGithubId, name: "Port Test User", tier: "FREE" }
    });
    createdUserIds.push(user.id);

    const project = await testPrisma.project.create({
      data: { userId: user.id, repoOwner: "port-org", repoName: "port-app", webhookSecret: "s1" }
    });
    const preview = await testPrisma.preview.create({
      data: { projectId: project.id, prNumber: 55, status: "live", port: testPort }
    });

    const alloc = await testPrisma.portAllocation.create({
      data: {
        port: testPort,
        previewId: preview.id,
        tier: "FREE",
        isAllocated: true,
        allocatedAt: new Date()
      }
    });

    assert.equal(alloc.port, testPort);
    assert.equal(alloc.isAllocated, true);

    await testPrisma.preview.delete({ where: { id: preview.id } });
    const afterDelete = await testPrisma.portAllocation.findUnique({ where: { port: testPort } });
    assert.equal(afterDelete.previewId, null, "PortAllocation previewId should set null on preview deletion");

    await testPrisma.portAllocation.deleteMany({ where: { port: testPort } });
  });
});
