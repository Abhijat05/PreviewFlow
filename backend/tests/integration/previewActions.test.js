// backend/tests/integration/previewActions.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { generateTestToken } from "../helpers/authHelper.js";
import { setAsyncRebuildWorker, resetAsyncRebuildWorker } from "../../src/routes/previewActions.js";
import { mockPrisma } from "../helpers/prismaMock.js";

describe("5.3 Preview Actions API Integration Tests", () => {
  let prismaRestore;

  const testUserId = "user_owner_preview";
  const otherUserId = "user_other_preview";
  const validToken = generateTestToken({ userId: testUserId, tier: "FREE" });
  const otherToken = generateTestToken({ userId: otherUserId, tier: "FREE" });

  const mockPreview = {
    id: "prev_active_123",
    projectId: "proj_abc",
    prNumber: 7,
    status: "live",
    url: "http://localhost:5050",
    deployedCommitSha: "sha_deployed_7",
    desiredCommitSha: "sha_deployed_7",
    containerName: "preview-p123-pr7-b1",
    port: 5050,
    project: { id: "proj_abc", userId: testUserId, repoOwner: "acme", repoName: "web", user: { id: testUserId, tier: "FREE" } }
  };

  beforeEach(() => {
    const { restore } = mockPrisma();
    prismaRestore = restore;

    setAsyncRebuildWorker(async () => {}); // silence background build during base route tests

    // Standard user auth resolution
    prisma.user.findUnique = async ({ where }) => ({
      id: where.id,
      tier: "FREE",
      username: "testuser"
    });

    prisma.build.findMany = async () => [];
    prisma.build.findFirst = async () => null;
    prisma.build.create = async ({ data }) => ({ id: "build_int_1", ...data });
    prisma.build.update = async ({ where, data }) => ({ id: where.id, ...data });
    prisma.build.updateMany = async () => ({ count: 0 });
  });

  afterEach(() => {
    resetAsyncRebuildWorker();
    if (prismaRestore) prismaRestore();
  });

  /* ---------------- REBUILD ---------------- */

  test("POST /api/preview/:id/rebuild rejects unauthenticated request with 401", async () => {
    const res = await request(app).post("/api/preview/prev_active_123/rebuild");
    assert.equal(res.status, 401);
  });

  test("POST /api/preview/:id/rebuild rejects non-existent preview with 404", async () => {
    prisma.preview.findUnique = async () => null;

    const res = await request(app)
      .post("/api/preview/prev_not_found/rebuild")
      .set("Authorization", `Bearer ${validToken}`);

    assert.equal(res.status, 404);
    assert.equal(res.body.error, "Preview not found");
  });

  test("POST /api/preview/:id/rebuild rejects request for another user's preview with 403", async () => {
    prisma.preview.findUnique = async () => mockPreview;

    const res = await request(app)
      .post("/api/preview/prev_active_123/rebuild")
      .set("Authorization", `Bearer ${otherToken}`);

    assert.equal(res.status, 403);
    assert.equal(res.body.error, "Not allowed");
  });

  test("POST /api/preview/:id/rebuild rejects with 409 if preview is already building", async () => {
    prisma.preview.findUnique = async () => ({
      ...mockPreview,
      status: "building"
    });

    const res = await request(app)
      .post("/api/preview/prev_active_123/rebuild")
      .set("Authorization", `Bearer ${validToken}`);

    assert.equal(res.status, 409);
    assert.equal(res.body.error, "build_already_in_progress");
  });

  test("POST /api/preview/:id/rebuild rejects with 429 when user tier concurrent build limit is reached", async () => {
    prisma.preview.findUnique = async () => mockPreview;
    // FREE tier allows only 1 concurrent build; simulate 1 build already in progress
    prisma.preview.count = async () => 1;

    const res = await request(app)
      .post("/api/preview/prev_active_123/rebuild")
      .set("Authorization", `Bearer ${validToken}`);

    assert.equal(res.status, 429);
    assert.equal(res.body.error, "build_limit_reached");
  });

  test("POST /api/preview/:id/rebuild accepts valid rebuild and returns 202 with status building", async () => {
    prisma.preview.findUnique = async () => mockPreview;
    prisma.preview.count = async () => 0;
    let previewUpdated = null;
    prisma.preview.update = async ({ where, data }) => {
      previewUpdated = { where, data };
      return { ...mockPreview, ...data };
    };

    const res = await request(app)
      .post("/api/preview/prev_active_123/rebuild")
      .set("Authorization", `Bearer ${validToken}`);

    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, "building");
    assert.equal(previewUpdated.data.status, "building");
  });

  test("POST /api/preview/:id/rebuild enqueues build via unified orchestrator and supports force supersession", async () => {
    resetAsyncRebuildWorker(); // Use real buildOrchestrator.triggerBuild path

    let buildingPreview = { ...mockPreview, status: "building" };
    const createdBuilds = [];
    const updatedBuilds = [];

    prisma.preview.findUnique = async () => buildingPreview;
    prisma.preview.upsert = async ({ update }) => {
      buildingPreview = { ...buildingPreview, ...update };
      return buildingPreview;
    };
    prisma.preview.update = async ({ data }) => {
      buildingPreview = { ...buildingPreview, ...data };
      return buildingPreview;
    };
    prisma.preview.count = async () => 0;

    prisma.build.findMany = async () => [
      { id: "build_prev_running", previewId: mockPreview.id, status: "RUNNING" }
    ];
    prisma.build.findFirst = async () => ({ buildNumber: 1 });
    prisma.build.update = async ({ where, data }) => {
      updatedBuilds.push({ id: where.id, ...data });
      return { id: where.id, ...data };
    };
    prisma.build.create = async ({ data }) => {
      const b = { id: "build_manual_2", ...data };
      createdBuilds.push(b);
      return b;
    };

    const res = await request(app)
      .post("/api/preview/prev_active_123/rebuild")
      .send({ force: true, commitSha: "sha_forced_commit" })
      .set("Authorization", `Bearer ${validToken}`);

    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.buildId, "build_manual_2");
    assert.equal(res.body.buildNumber, 2);
    assert.equal(createdBuilds.length, 1);
    assert.equal(createdBuilds[0].source, "MANUAL_REBUILD");
    assert.equal(createdBuilds[0].commitSha, "sha_forced_commit");
    assert.ok(updatedBuilds.some((b) => b.id === "build_prev_running" && b.status === "SUPERSEDED"));
  });

  /* ---------------- CANCEL ---------------- */

  test("POST /api/preview/:id/cancel cancels active builds for authorized owner", async () => {
    prisma.preview.findUnique = async () => ({ ...mockPreview, status: "building" });
    prisma.build.findMany = async () => [
      { id: "build_cancel_1", previewId: mockPreview.id, status: "RUNNING" }
    ];
    const cancelledUpdates = [];
    prisma.build.update = async ({ where, data }) => {
      cancelledUpdates.push({ id: where.id, ...data });
      return { id: where.id, ...data };
    };
    prisma.preview.update = async ({ where, data }) => ({ ...mockPreview, ...data });

    const res = await request(app)
      .post("/api/preview/prev_active_123/cancel")
      .send({ reason: "Cancel requested by owner" })
      .set("Authorization", `Bearer ${validToken}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.cancelledCount, 1);
    assert.equal(cancelledUpdates[0].status, "CANCELLED");
    assert.equal(cancelledUpdates[0].errorMessage, "Cancel requested by owner");
  });

  test("POST /api/preview/:id/cancel rejects unauthorized owner with 403", async () => {
    prisma.preview.findUnique = async () => mockPreview;

    const res = await request(app)
      .post("/api/preview/prev_active_123/cancel")
      .set("Authorization", `Bearer ${otherToken}`);

    assert.equal(res.status, 403);
  });

  /* ---------------- DELETE ---------------- */

  test("POST /api/preview/:id/delete rejects non-existent preview with 404", async () => {
    prisma.preview.findUnique = async () => null;

    const res = await request(app)
      .post("/api/preview/prev_missing/delete")
      .set("Authorization", `Bearer ${validToken}`);

    assert.equal(res.status, 404);
  });

  test("POST /api/preview/:id/delete rejects another user's preview with 403", async () => {
    prisma.preview.findUnique = async () => mockPreview;

    const res = await request(app)
      .post("/api/preview/prev_active_123/delete")
      .set("Authorization", `Bearer ${otherToken}`);

    assert.equal(res.status, 403);
  });

  test("POST /api/preview/:id/delete cancels builds and marks preview deleted in database", async () => {
    prisma.preview.findUnique = async () => mockPreview;
    prisma.build.findMany = async () => [
      { id: "build_running_del", previewId: mockPreview.id, status: "RUNNING" }
    ];
    let cancelledId = null;
    prisma.build.update = async ({ where, data }) => {
      if (data.status === "CANCELLED") cancelledId = where.id;
      return { id: where.id, ...data };
    };
    let updateData = null;
    prisma.preview.update = async ({ data }) => {
      updateData = data;
      return { ...mockPreview, ...data };
    };

    const res = await request(app)
      .post("/api/preview/prev_active_123/delete")
      .set("Authorization", `Bearer ${validToken}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(cancelledId, "build_running_del");
    assert.equal(updateData.status, "deleted");
  });
});
