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
});
