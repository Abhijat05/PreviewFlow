// backend/tests/unit/prHandlers.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { handlePROpenOrSync, handlePRClosed } from "../../src/services/prHandlers.js";
import { prisma } from "../../src/db.js";

describe("4.3 Pull Request Handlers Unit Tests", () => {
  let originalUpsert;
  let originalFindFirst;
  let originalUpdate;
  let originalBuildFindMany;
  let originalBuildUpdate;
  let mockTempDir;

  beforeEach(() => {
    originalUpsert = prisma.preview.upsert;
    originalFindFirst = prisma.preview.findFirst;
    originalUpdate = prisma.preview.update;
    originalBuildFindMany = prisma.build.findMany;
    originalBuildUpdate = prisma.build.update;

    prisma.build.findMany = async () => [];
    prisma.build.update = async ({ where, data }) => ({ id: where.id, ...data });

    mockTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-handler-test-"));
  });

  afterEach(() => {
    prisma.preview.upsert = originalUpsert;
    prisma.preview.findFirst = originalFindFirst;
    prisma.preview.update = originalUpdate;
    prisma.build.findMany = originalBuildFindMany;
    prisma.build.update = originalBuildUpdate;

    try {
      if (fs.existsSync(mockTempDir)) {
        fs.rmSync(mockTempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  const testProject = {
    id: "proj_123",
    userId: "user_abc",
    repoOwner: "testowner",
    repoName: "testrepo",
    accessToken: "ghp_mock_token"
  };

  test("handlePROpenOrSync creates preview, clones repository, and builds preview successfully", async () => {
    let upsertCalledWith = null;
    let cloneCalledWith = null;
    let buildCalledWith = null;

    prisma.preview.upsert = async (args) => {
      upsertCalledWith = args;
      return { id: "prev_new_1", projectId: "proj_123", prNumber: 10, status: "building" };
    };

    const mockCloner = async (args) => {
      cloneCalledWith = args;
      return mockTempDir;
    };

    const mockBuilder = async (args) => {
      buildCalledWith = args;
      return "http://localhost:5050";
    };

    await handlePROpenOrSync({
      project: testProject,
      prNumber: 10,
      ref: "feature/login",
      cloner: mockCloner,
      builder: mockBuilder
    });

    assert.equal(upsertCalledWith.where.projectId_prNumber.projectId, "proj_123");
    assert.equal(upsertCalledWith.where.projectId_prNumber.prNumber, 10);
    assert.equal(cloneCalledWith.repoOwner, "testowner");
    assert.equal(cloneCalledWith.prNumber, 10);
    assert.equal(cloneCalledWith.ref, "feature/login");
    assert.equal(buildCalledWith.previewId, "prev_new_1");

    // Verify temp dir is cleaned up in finally block
    assert.equal(fs.existsSync(mockTempDir), false, "Temp dir must be cleaned up after build");
  });

  test("handlePROpenOrSync cleans up temporary files and propagates error when build fails", async () => {
    prisma.preview.upsert = async () => ({
      id: "prev_fail_1",
      projectId: "proj_123",
      prNumber: 15,
      status: "building"
    });

    const mockCloner = async () => mockTempDir;

    const mockBuilder = async () => {
      throw new Error("Docker build command failed with exit code 1");
    };

    await assert.rejects(
      async () => {
        await handlePROpenOrSync({
          project: testProject,
          prNumber: 15,
          ref: "broken-branch",
          cloner: mockCloner,
          builder: mockBuilder
        });
      },
      (err) => {
        assert.match(err.message, /Docker build command failed/i);
        return true;
      }
    );

    // Verify temp directory was still cleaned up
    assert.equal(fs.existsSync(mockTempDir), false, "Temp dir must be cleaned up on build failure");
  });

  test("handlePROpenOrSync cleans up and propagates error when cloneRepo fails", async () => {
    prisma.preview.upsert = async () => ({
      id: "prev_clone_fail",
      projectId: "proj_123",
      prNumber: 20,
      status: "building"
    });

    const mockCloner = async () => {
      throw new Error("fatal: remote branch not found");
    };

    await assert.rejects(
      async () => {
        await handlePROpenOrSync({
          project: testProject,
          prNumber: 20,
          ref: "missing-branch",
          cloner: mockCloner
        });
      },
      (err) => {
        assert.match(err.message, /remote branch not found/i);
        return true;
      }
    );
  });

  test("handlePRClosed removes container and marks preview status deleted in database", async () => {
    let removedContainer = null;
    let updatedPreviewData = null;

    prisma.preview.findFirst = async ({ where }) => {
      if (where.projectId === "proj_123" && where.prNumber === 10) {
        return {
          id: "prev_to_close",
          containerName: "preview-pproj_123-pr10-b1",
          status: "live"
        };
      }
      return null;
    };

    const mockContainerRemover = async (name) => {
      removedContainer = name;
      return true;
    };

    prisma.preview.update = async ({ where, data }) => {
      updatedPreviewData = { where, data };
      return { id: where.id, ...data };
    };

    await handlePRClosed({
      project: testProject,
      prNumber: 10,
      containerRemover: mockContainerRemover
    });

    assert.equal(removedContainer, "preview-pproj_123-pr10-b1");
    assert.equal(updatedPreviewData.where.id, "prev_to_close");
    assert.equal(updatedPreviewData.data.status, "deleted");
    assert.equal(updatedPreviewData.data.url, null);
    assert.equal(updatedPreviewData.data.containerName, null);
    assert.equal(updatedPreviewData.data.port, null);
  });

  test("handlePRClosed handles missing preview gracefully without error", async () => {
    prisma.preview.findFirst = async () => null;

    // Should return silently without throwing
    await handlePRClosed({
      project: testProject,
      prNumber: 9999
    });
  });

  test("handlePRClosed handles container removal failure gracefully and proceeds to update status", async () => {
    prisma.preview.findFirst = async () => ({
      id: "prev_orphan",
      containerName: "preview-missing-container",
      status: "live"
    });

    const mockContainerRemover = async () => {
      throw new Error("Container not found");
    };

    let updated = false;
    prisma.preview.update = async ({ data }) => {
      if (data.status === "deleted") updated = true;
      return { id: "prev_orphan", ...data };
    };

    await handlePRClosed({
      project: testProject,
      prNumber: 12,
      containerRemover: mockContainerRemover
    });

    assert.equal(updated, true, "Status must be updated to deleted even if container removal fails");
  });
});
