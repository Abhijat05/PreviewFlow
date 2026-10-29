import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { handleChangeTier } from "../src/routes/accountTier.js";

describe("POST /api/account/change-tier authorization & cleanup", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalAdminSecret = process.env.ADMIN_SECRET;

  after(() => {
    process.env.NODE_ENV = originalEnv;
    process.env.ADMIN_SECRET = originalAdminSecret;
  });

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

  test("rejects unverified upgrade in production with 402 Payment Required", async () => {
    process.env.NODE_ENV = "production";
    process.env.ADMIN_SECRET = "supersecret123";

    const req = {
      body: { newTier: "PRO" },
      headers: {},
      auth: {
        user: { id: "user_test_1", tier: "FREE" },
        userId: "user_test_1"
      }
    };
    const res = mockRes();

    await handleChangeTier(req, res);

    assert.equal(res.statusCode, 402);
    assert.equal(res.data?.error, "payment_required");
  });

  test("rejects request if newTier is missing or invalid", async () => {
    const req1 = {
      body: {},
      headers: {},
      auth: { user: { id: "user_1", tier: "FREE" } }
    };
    const res1 = mockRes();
    await handleChangeTier(req1, res1);
    assert.equal(res1.statusCode, 400);

    const req2 = {
      body: { newTier: "SUPER_ULTRA_TIER" },
      headers: {},
      auth: { user: { id: "user_1", tier: "FREE" } }
    };
    const res2 = mockRes();
    await handleChangeTier(req2, res2);
    assert.equal(res2.statusCode, 400);
  });

  test("echoes back if target tier is identical to current tier", async () => {
    const req = {
      body: { newTier: "FREE" },
      headers: {},
      auth: {
        user: { id: "user_1", tier: "FREE" }
      }
    };
    const res = mockRes();
    await handleChangeTier(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.data?.changed, false);
    assert.equal(res.data?.currentTier, "FREE");
  });
});
