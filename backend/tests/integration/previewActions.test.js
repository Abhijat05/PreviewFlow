// backend/tests/integration/previewActions.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { generateTestToken } from "../helpers/authHelper.js";
import { setAsyncRebuildWorker, resetAsyncRebuildWorker } from "../../src/routes/previewActions.js";

describe("5.3 Preview Actions API Integration Tests", () => {
  let originalFindUniqueUser;
  let originalFindUniquePreview;
  let originalCountPreview;
  let originalUpdatePreview;

  const testUserId = "user_owner_preview";
  const otherUserId = "user_other_preview";
  const validToken = generateTestToken({ userId: testUserId, tier: "FREE" });
  const otherToken = generateTestToken({ userId: otherUserId, tier: "FREE" });

  const mockPreview = {
    id: "prev_active_123",
    projectId: "proj_abc",
    prNumber: 7,
    status: "live",
    containerName: "preview-p123-pr7-b1",
    port: 5050,
    project: { id: "proj_abc", userId: testUserId }
  };

  beforeEach(() => {
    setAsyncRebuildWorker(async () => {}); // silence background build during route test
    originalFindUniqueUser = prisma.user.findUnique;
    originalFindUniquePreview = prisma.preview.findUnique;
    originalCountPreview = prisma.preview.count;
    originalUpdatePreview = prisma.preview.update;

    // Standard user auth resolution
    prisma.user.findUnique = async ({ where }) => ({
      id: where.id,
      tier: "FREE",
      username: "testuser"
    });
  });

  afterEach(() => {
    resetAsyncRebuildWorker();
    prisma.user.findUnique = originalFindUniqueUser;
    prisma.preview.findUnique = originalFindUniquePreview;
    prisma.preview.count = originalCountPreview;
    prisma.preview.update = originalUpdatePreview;
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
      .set("Authorization", `Bearer ${otherToken}`); // other user

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
    prisma.preview.count = async () => 0; // 0 active builds
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

  test("POST /api/preview/:id/delete succeeds and marks preview deleted in database", async () => {
    prisma.preview.findUnique = async () => mockPreview;
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
    assert.equal(updateData.status, "deleted");
  });
});
