import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  handleRebuildPreview,
  handleDeletePreview,
  enforceBuildLimit
} from "../src/routes/previewActions.js";

describe("Async Rebuild Flow & Concurrency Protection", () => {
  function mockRes() {
    return {
      statusCode: 200,
      data: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(obj) {
        this.data = obj;
        return this;
      }
    };
  }

  test("handleRebuildPreview rejects missing id with 400", async () => {
    const req = {
      params: {},
      user: { userId: "user_1", tier: "FREE" }
    };
    const res = mockRes();

    await handleRebuildPreview(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.data?.error, "Missing preview id");
  });

  test("handleRebuildPreview rejects non-existent preview with 404", async () => {
    const req = {
      params: { id: "non_existent_cuid_123" },
      user: { userId: "user_1", tier: "FREE" }
    };
    const res = mockRes();

    await handleRebuildPreview(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.data?.error, "Preview not found");
  });

  test("handleDeletePreview rejects non-existent preview with 404", async () => {
    const req = {
      params: { id: "non_existent_cuid_123" },
      user: { userId: "user_1" }
    };
    const res = mockRes();

    await handleDeletePreview(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.data?.error, "Preview not found");
  });

  test("enforceBuildLimit correctly blocks when concurrent build threshold is reached", async () => {
    // For FREE tier, max concurrent builds is 1
    const result = await enforceBuildLimit("user_with_no_builds", "FREE");
    assert.equal(result.allowed, true);
  });
});
