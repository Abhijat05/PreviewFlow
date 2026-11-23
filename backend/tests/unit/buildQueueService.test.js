// backend/tests/unit/buildQueueService.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../src/db.js";
import { mockPrisma } from "../helpers/prismaMock.js";
import {
  enqueueBuild,
  getBuildById,
  getBuildHistory,
  cancelBuild,
  markBuildSuperseded
} from "../../src/services/buildQueueService.js";

describe("buildQueueService Unit Tests", () => {
  let prismaRestore;

  beforeEach(() => {
    const { restore } = mockPrisma();
    prismaRestore = restore;
  });

  afterEach(() => {
    if (prismaRestore) prismaRestore();
  });

  test("enqueueBuild validates required arguments", async () => {
    await assert.rejects(
      async () => enqueueBuild({}),
      /previewId is required/
    );
    await assert.rejects(
      async () => enqueueBuild({ previewId: "prev_1" }),
      /commitSha is required/
    );
    await assert.rejects(
      async () => enqueueBuild({ previewId: "prev_1", commitSha: "abc1234" }),
      /branch is required/
    );
  });

  test("enqueueBuild supersedes existing QUEUED builds and increments buildNumber", async () => {
    let supersededUpdates = [];
    let createdBuild = null;
    let updatedPreview = null;

    prisma.build.findMany = async ({ where }) => {
      if (where.previewId === "prev_1" && where.status === "QUEUED") {
        return [{ id: "build_old_1", buildNumber: 1, status: "QUEUED" }];
      }
      return [];
    };

    prisma.build.updateMany = async ({ where, data }) => {
      supersededUpdates.push({ where, data });
      return { count: 1 };
    };

    prisma.build.findFirst = async ({ where, orderBy }) => {
      // Find latest build to determine next buildNumber
      if (where.previewId === "prev_1") {
        return { buildNumber: 1 };
      }
      return null;
    };

    prisma.build.create = async ({ data }) => {
      createdBuild = { id: "build_new_2", ...data };
      return createdBuild;
    };

    prisma.preview.update = async ({ where, data }) => {
      updatedPreview = { id: where.id, ...data };
      return updatedPreview;
    };

    const build = await enqueueBuild({
      previewId: "prev_1",
      commitSha: "sha_new_456",
      branch: "feature/new",
      commitMessage: "Add awesome feature",
      source: "WEBHOOK_SYNC"
    });

    assert.equal(build.id, "build_new_2");
    assert.equal(build.buildNumber, 2);
    assert.equal(build.status, "QUEUED");
    assert.equal(build.commitSha, "sha_new_456");

    // Check that old QUEUED build was superseded
    assert.equal(supersededUpdates.length, 1);
    assert.equal(supersededUpdates[0].data.status, "SUPERSEDED");

    // Check that preview record was updated with latest build reference
    assert.equal(updatedPreview.latestBuildId, "build_new_2");
    assert.equal(updatedPreview.desiredCommitSha, "sha_new_456");
    assert.equal(updatedPreview.buildNumber, 2);
  });

  test("getBuildById returns build with relations", async () => {
    const mockBuild = {
      id: "build_123",
      previewId: "prev_1",
      buildNumber: 1,
      status: "RUNNING",
      preview: { id: "prev_1", prNumber: 42 }
    };

    prisma.build.findUnique = async ({ where, include }) => {
      if (where.id === "build_123") {
        return mockBuild;
      }
      return null;
    };

    const result = await getBuildById("build_123");
    assert.deepEqual(result, mockBuild);

    const nonExistent = await getBuildById("non_existent");
    assert.equal(nonExistent, null);
  });

  test("getBuildHistory returns paginated builds ordered descending by buildNumber", async () => {
    const mockHistory = [
      { id: "b2", buildNumber: 2, status: "COMPLETED" },
      { id: "b1", buildNumber: 1, status: "SUPERSEDED" }
    ];

    let queryArgs = null;
    prisma.build.findMany = async (args) => {
      queryArgs = args;
      return mockHistory;
    };

    const history = await getBuildHistory("prev_1", { limit: 10, offset: 0 });
    assert.equal(history.length, 2);
    assert.equal(queryArgs.where.previewId, "prev_1");
    assert.deepEqual(queryArgs.orderBy, { buildNumber: "desc" });
    assert.equal(queryArgs.take, 10);
  });

  test("cancelBuild cancels non-terminal build and updates status", async () => {
    let updatedBuild = null;
    let previewUpdated = null;

    prisma.build.findUnique = async () => ({
      id: "build_to_cancel",
      previewId: "prev_1",
      status: "RUNNING"
    });

    prisma.build.update = async ({ where, data }) => {
      updatedBuild = { id: where.id, ...data };
      return updatedBuild;
    };

    prisma.preview.findFirst = async () => ({
      id: "prev_1",
      activeBuildId: "build_to_cancel"
    });

    prisma.preview.update = async ({ where, data }) => {
      previewUpdated = { id: where.id, ...data };
      return previewUpdated;
    };

    const cancelled = await cancelBuild("build_to_cancel", { reason: "User requested abort" });
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(cancelled.errorMessage, "User requested abort");
    assert.ok(cancelled.cancelledAt);
    assert.equal(previewUpdated.activeBuildId, null);
  });

  test("cancelBuild rejects cancelling already terminal builds", async () => {
    prisma.build.findUnique = async () => ({
      id: "build_done",
      status: "COMPLETED"
    });

    await assert.rejects(
      async () => cancelBuild("build_done"),
      /Cannot cancel build in terminal state COMPLETED/
    );
  });

  test("markBuildSuperseded updates build status to SUPERSEDED", async () => {
    let updatedData = null;

    prisma.build.findUnique = async () => ({
      id: "build_old",
      status: "QUEUED"
    });

    prisma.build.update = async ({ where, data }) => {
      updatedData = { id: where.id, ...data };
      return updatedData;
    };

    const res = await markBuildSuperseded("build_old", { supersededByBuildId: "build_new" });
    assert.equal(res.status, "SUPERSEDED");
    assert.match(res.errorMessage, /Superseded by build_new/);
  });
});
