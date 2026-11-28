// backend/tests/integration/projectRoutes.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { generateTestToken } from "../helpers/authHelper.js";
import { isEncryptedSecret } from "../../src/services/cryptoService.js";
import { setRepoAccessVerifier, resetRepoAccessVerifier } from "../../src/routes/connectRepo.js";

describe("5.4 Project, Logs & Metrics API Integration Tests", () => {
  let originalFindUniqueUser;
  let originalFindUniquePreview;
  let originalFindFirstPreview;
  let originalFindManyPreview;
  let originalFindUniqueProject;
  let originalFindFirstProject;
  let originalFindManyProject;
  let originalCreateProject;
  let originalCountProject;
  let originalFindManyMetric;

  const testUserId = "user_project_tester";
  const otherUserId = "user_other_tester";
  const freeToken = generateTestToken({ userId: testUserId, tier: "FREE" });
  const proToken = generateTestToken({ userId: testUserId, tier: "PRO" });
  const otherToken = generateTestToken({ userId: otherUserId, tier: "FREE" });

  beforeEach(() => {
    originalFindUniqueUser = prisma.user.findUnique;
    originalFindUniquePreview = prisma.preview.findUnique;
    originalFindFirstPreview = prisma.preview.findFirst;
    originalFindManyPreview = prisma.preview.findMany;
    originalFindUniqueProject = prisma.project.findUnique;
    originalFindFirstProject = prisma.project.findFirst;
    originalFindManyProject = prisma.project.findMany;
    originalCreateProject = prisma.project.create;
    originalCountProject = prisma.project.count;
    originalFindManyMetric = prisma.previewMetric.findMany;

    // Default user auth resolution
    prisma.user.findUnique = async ({ where }) => ({
      id: where.id,
      tier: where.id === testUserId ? "FREE" : "FREE",
      username: "projtester"
    });
  });

  afterEach(() => {
    resetRepoAccessVerifier();
    prisma.user.findUnique = originalFindUniqueUser;
    prisma.preview.findUnique = originalFindUniquePreview;
    prisma.preview.findFirst = originalFindFirstPreview;
    prisma.preview.findMany = originalFindManyPreview;
    prisma.project.findUnique = originalFindUniqueProject;
    prisma.project.findFirst = originalFindFirstProject;
    prisma.project.findMany = originalFindManyProject;
    prisma.project.create = originalCreateProject;
    prisma.project.count = originalCountProject;
    prisma.previewMetric.findMany = originalFindManyMetric;
  });

  /* ---------------- CONNECT REPO ---------------- */

  test("POST /api/connect-repo rejects invalid input types with 400", async () => {
    const res = await request(app)
      .post("/api/connect-repo")
      .set("Authorization", `Bearer ${freeToken}`)
      .send({ repoOwner: 12345, repoName: null });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_input_format");
  });

  test("POST /api/connect-repo rejects missing repo details with 400", async () => {
    const res = await request(app)
      .post("/api/connect-repo")
      .set("Authorization", `Bearer ${freeToken}`)
      .send({ repoOwner: "   ", repoName: "valid-name" });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, "missing_repo_details");
  });

  test("POST /api/connect-repo enforces repository quota with 429", async () => {
    // FREE tier allows max 1 project; simulate 1 existing project
    prisma.project.count = async () => 1;

    const res = await request(app)
      .post("/api/connect-repo")
      .set("Authorization", `Bearer ${freeToken}`)
      .send({ repoOwner: "org", repoName: "new-repo" });

    assert.equal(res.status, 429);
    assert.equal(res.body.code, "REPO_QUOTA_EXCEEDED");
  });

  test("POST /api/connect-repo returns already_connected when repo was already added", async () => {
    prisma.project.count = async () => 0;
    const existingProj = {
      id: "proj_existing",
      userId: testUserId,
      repoOwner: "my-org",
      repoName: "my-repo"
    };
    prisma.project.findFirst = async () => existingProj;

    const res = await request(app)
      .post("/api/connect-repo")
      .set("Authorization", `Bearer ${freeToken}`)
      .send({ repoOwner: "my-org", repoName: "my-repo" });

    assert.equal(res.status, 200);
    assert.equal(res.body.note, "already_connected");
    assert.equal(res.body.project.id, "proj_existing");
  });

  test("POST /api/connect-repo creates new project and generates webhook secret", async () => {
    setRepoAccessVerifier(async () => true);
    prisma.project.count = async () => 0;
    prisma.project.findFirst = async () => null;

    let createdProjectData = null;
    prisma.project.create = async ({ data }) => {
      createdProjectData = data;
      return { id: "proj_created_123", ...data };
    };

    const res = await request(app)
      .post("/api/connect-repo")
      .set("Authorization", `Bearer ${freeToken}`)
      .send({ repoOwner: "facebook", repoName: "react" });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(createdProjectData.repoOwner, "facebook");
    assert.equal(createdProjectData.repoName, "react");
    assert.ok(isEncryptedSecret(createdProjectData.webhookSecret), "Secret must be encrypted at rest");
    assert.equal(res.body.project.webhookSecret, undefined, "webhookSecret must NEVER leak in HTTP response");
    assert.equal(res.body.project.accessToken, undefined, "accessToken must NEVER leak in HTTP response");
  });

  /* ---------------- PROJECTS LISTING ---------------- */

  test("GET /api/projects returns user's connected projects with previews and masks secrets", async () => {
    const mockProjects = [
      {
        id: "p1",
        userId: testUserId,
        repoOwner: "org",
        repoName: "app",
        webhookSecret: "enc:v1:abc:def:123",
        accessToken: "enc:v1:abc:def:456",
        webhookId: "wh_1",
        previews: [{ id: "prev_1", prNumber: 1, status: "live" }]
      }
    ];

    prisma.project.findMany = async ({ where }) => {
      if (where.userId === testUserId) return mockProjects;
      return [];
    };

    const res = await request(app)
      .get("/api/projects")
      .set("Authorization", `Bearer ${freeToken}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].repoName, "app");
    assert.equal(res.body[0].hasWebhook, true);
    assert.equal(res.body[0].webhookSecret, undefined);
    assert.equal(res.body[0].accessToken, undefined);
  });

  /* ---------------- LOGS ---------------- */

  test("GET /preview/:id/logs rejects non-existent preview with 404", async () => {
    prisma.preview.findUnique = async () => null;

    const res = await request(app)
      .get("/api/preview/prev_not_found/logs")
      .set("Authorization", `Bearer ${freeToken}`);

    assert.equal(res.status, 404);
  });

  test("GET /preview/:id/logs rejects another user's preview with 403 Forbidden", async () => {
    prisma.preview.findUnique = async () => ({
      id: "prev_secret",
      project: { userId: otherUserId },
      buildLogs: "top secret build logs"
    });

    const res = await request(app)
      .get("/api/preview/prev_secret/logs")
      .set("Authorization", `Bearer ${freeToken}`); // testUserId trying to access otherUserId's preview

    assert.equal(res.status, 403);
    assert.equal(res.body.error, "Forbidden");
  });

  test("GET /preview/:id/logs returns buildLogs for authorized owner", async () => {
    prisma.preview.findUnique = async () => ({
      id: "prev_mine",
      project: { userId: testUserId },
      buildLogs: "Step 1: npm install\nStep 2: npm run build\nBUILD FINISHED"
    });

    const res = await request(app)
      .get("/api/preview/prev_mine/logs")
      .set("Authorization", `Bearer ${freeToken}`);

    assert.equal(res.status, 200);
    assert.match(res.body.logs, /BUILD FINISHED/);
  });

  /* ---------------- METRICS ---------------- */

  test("GET /api/previews/:previewId/metrics returns formatted telemetry history", async () => {
    prisma.preview.findFirst = async () => ({
      id: "prev_metrics_test",
      projectId: "proj_1"
    });

    const sampleDate = new Date();
    prisma.previewMetric.findMany = async () => [
      {
        id: "m1",
        previewId: "prev_metrics_test",
        cpu: 25.4,
        memory: BigInt(268435456), // 256 MB
        networkRx: BigInt(1048576),
        networkTx: BigInt(2097152),
        createdAt: sampleDate
      }
    ];

    const res = await request(app)
      .get("/api/previews/prev_metrics_test/metrics?range=1h")
      .set("Authorization", `Bearer ${freeToken}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.previewId, "prev_metrics_test");
    assert.equal(res.body.count, 1);
    assert.equal(res.body.metrics[0].cpu, 25.4);
    assert.equal(res.body.metrics[0].memory, 268435456); // BigInt serialized to Number
  });

  /* ---------------- CREATE WEBHOOK ---------------- */

  test("POST /api/create-webhook rejects FREE tier with 403 webhook_not_allowed", async () => {
    const res = await request(app)
      .post("/api/create-webhook")
      .set("Authorization", `Bearer ${freeToken}`)
      .send({ projectId: "proj_any" });

    assert.equal(res.status, 403);
    assert.equal(res.body.error, "webhook_not_allowed");
  });

  /* ---------------- PHASE 4A FRAMEWORK & DASHBOARD OVERVIEW ---------------- */

  test("POST /api/connect-repo persists normalized framework preset when provided", async () => {
    setRepoAccessVerifier(async () => true);
    prisma.project.count = async () => 0;
    prisma.project.findFirst = async () => null;

    const capturedPayloads = [];
    prisma.project.create = async ({ data }) => {
      capturedPayloads.push(data);
      return {
        id: `proj_${capturedPayloads.length}`,
        ...data,
        framework: data.framework ?? null,
        webhookId: null,
        createdAt: new Date("2026-11-28T08:00:00Z")
      };
    };

    const origAuditCreate = prisma.auditLog?.create;
    if (prisma.auditLog) {
      prisma.auditLog.create = async () => ({ id: "audit_mock" });
    }

    try {
      const validRes = await request(app)
        .post("/api/connect-repo")
        .set("Authorization", `Bearer ${freeToken}`)
        .send({ repoOwner: "octocat", repoName: "portal-web", framework: "  NextJS " });

      assert.equal(validRes.status, 200);
      assert.equal(validRes.body.project.framework, "nextjs");
      assert.equal(capturedPayloads[0].framework, "nextjs");

      const invalidFwRes = await request(app)
        .post("/api/connect-repo")
        .set("Authorization", `Bearer ${freeToken}`)
        .send({ repoOwner: "octocat", repoName: "legacy-app", framework: "rails" });

      assert.equal(invalidFwRes.status, 200);
      assert.equal(invalidFwRes.body.project.framework, null);
      assert.equal(capturedPayloads[1].framework, undefined);
    } finally {
      if (prisma.auditLog && origAuditCreate) {
        prisma.auditLog.create = origAuditCreate;
      }
    }
  });

  test("GET /api/dashboard/overview rejects unauthenticated requests with 401", async () => {
    const res = await request(app).get("/api/dashboard/overview");
    assert.equal(res.status, 401);
  });

  test("GET /api/dashboard/overview returns masked projects, framework, stats, builds, and activity timeline", async () => {
    prisma.project.findMany = async () => [
      {
        id: "proj_ov_1",
        userId: testUserId,
        repoOwner: "octocat",
        repoName: "next-dashboard",
        framework: "nextjs",
        webhookSecret: "enc_super_secret",
        accessToken: "enc_ghp_secret",
        webhookId: "hook_42",
        createdAt: new Date("2026-11-25T10:00:00Z"),
        previews: [
          { id: "prev_live", prNumber: 12, status: "live", url: "http://pr-12.localhost:3000" },
          { id: "prev_err", prNumber: 13, status: "error", url: null },
          { id: "prev_arch", prNumber: 10, status: "deleted", url: null }
        ]
      }
    ];

    const origBuildFindMany = prisma.build?.findMany;
    const origBuildCount = prisma.build?.count;
    const origAuditFindMany = prisma.auditLog?.findMany;

    if (prisma.build) {
      prisma.build.findMany = async () => [
        {
          id: "bld_2",
          previewId: "prev_err",
          buildNumber: 2,
          commitSha: "deadbeef1234",
          commitMessage: "Fix build",
          branch: "fix/header",
          source: "WEBHOOK",
          status: "FAILED",
          queuedAt: new Date("2026-11-28T09:50:00Z"),
          startedAt: new Date("2026-11-28T09:50:05Z"),
          completedAt: null,
          failedAt: new Date("2026-11-28T09:50:15Z"),
          errorMessage: "Exit code 1",
          preview: {
            id: "prev_err",
            prNumber: 13,
            url: null,
            project: { id: "proj_ov_1", repoOwner: "octocat", repoName: "next-dashboard", framework: "nextjs" }
          }
        },
        {
          id: "bld_1",
          previewId: "prev_live",
          buildNumber: 1,
          commitSha: "abcdef123456",
          commitMessage: "Add cards",
          branch: "feat/cards",
          source: "WEBHOOK",
          status: "COMPLETED",
          queuedAt: new Date("2026-11-28T09:00:00Z"),
          startedAt: new Date("2026-11-28T09:00:02Z"),
          completedAt: new Date("2026-11-28T09:00:14Z"),
          failedAt: null,
          errorMessage: null,
          preview: {
            id: "prev_live",
            prNumber: 12,
            url: "http://pr-12.localhost:3000",
            project: { id: "proj_ov_1", repoOwner: "octocat", repoName: "next-dashboard", framework: "nextjs" }
          }
        }
      ];

      prisma.build.count = async ({ where }) => {
        if (where?.status === "COMPLETED") return 3;
        if (where?.status === "FAILED") return 1;
        return 4;
      };
    }

    if (prisma.auditLog) {
      prisma.auditLog.findMany = async () => [
        {
          id: "aud_1",
          action: "PROJECT_CONNECTED",
          status: "SUCCESS",
          resourceType: "Project",
          resourceId: "proj_ov_1",
          metadata: { repoName: "next-dashboard" },
          createdAt: new Date("2026-11-28T08:00:00Z")
        }
      ];
    }

    try {
      const res = await request(app)
        .get("/api/dashboard/overview")
        .set("Authorization", `Bearer ${freeToken}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.projects.length, 1);
      assert.equal(res.body.projects[0].framework, "nextjs");
      assert.equal(res.body.projects[0].hasWebhook, true);
      assert.equal(res.body.projects[0].webhookSecret, undefined);
      assert.equal(res.body.projects[0].accessToken, undefined);

      assert.equal(res.body.stats.totalProjects, 1);
      assert.equal(res.body.stats.totalPreviews, 2);
      assert.equal(res.body.stats.livePreviews, 1);
      assert.equal(res.body.stats.errorPreviews, 1);
      assert.equal(res.body.stats.archivedPreviews, 1);
      assert.equal(res.body.stats.totalBuilds, 4);
      assert.equal(res.body.stats.completedBuilds, 3);
      assert.equal(res.body.stats.failedBuilds, 1);
      assert.equal(res.body.stats.successRate, 75);
      assert.equal(res.body.stats.avgBuildDurationSec, 12);

      assert.equal(res.body.recentBuilds.length, 2);
      assert.equal(res.body.recentBuilds[0].framework, "nextjs");
      assert.equal(res.body.activity.length, 3);
      assert.ok(
        new Date(res.body.activity[0].timestamp).getTime() >=
          new Date(res.body.activity[1].timestamp).getTime()
      );
    } finally {
      if (prisma.build && origBuildFindMany) prisma.build.findMany = origBuildFindMany;
      if (prisma.build && origBuildCount) prisma.build.count = origBuildCount;
      if (prisma.auditLog && origAuditFindMany) prisma.auditLog.findMany = origAuditFindMany;
    }
  });
});
