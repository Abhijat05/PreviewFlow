import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { decodeAuth, requireAuth } from "../src/middleware/auth.js";
import {
  assertRepoQuota,
  assertPreviewQuota,
  requireSubscription
} from "../src/middleware/subscription.js";
import { getTierLimits } from "../src/middleware/tierLimits.js";
import { prisma } from "../src/db.js";

describe("Unified Authentication & Tier Limit Harmonization", () => {
  const originalJwtSecret = process.env.JWT_SECRET || "test_jwt_secret";
  process.env.JWT_SECRET = originalJwtSecret;

  after(() => {
    process.env.JWT_SECRET = originalJwtSecret;
  });

  test("requireSubscription is an alias of requireAuth", () => {
    assert.strictEqual(requireSubscription, requireAuth);
  });

  test("requireAuth rejects missing or malformed authorization header with 401", async () => {
    const req1 = { headers: {} };
    let status1 = 200;
    let json1 = null;
    const res1 = {
      status(c) { status1 = c; return this; },
      json(d) { json1 = d; return this; }
    };

    requireAuth(req1, res1, () => {});
    await new Promise((r) => setImmediate(r));
    assert.equal(status1, 401);
    assert.match(json1?.error, /missing token/i);

    const req2 = { headers: { authorization: "Basic 12345" } };
    let status2 = 200;
    let json2 = null;
    const res2 = {
      status(c) { status2 = c; return this; },
      json(d) { json2 = d; return this; }
    };

    requireAuth(req2, res2, () => {});
    await new Promise((r) => setImmediate(r));
    assert.equal(status2, 401);
  });

  test("decodeAuth overrides stale token tier with fresh database tier", async () => {
    const originalFindUnique = prisma.user.findUnique;
    try {
      prisma.user.findUnique = async ({ where }) => {
        if (where.id === "user_upgrade_123") {
          return {
            id: "user_upgrade_123",
            tier: "PRO", // Fresh DB tier is PRO
            username: "octocat"
          };
        }
        return null;
      };

      // Token generated previously when user was FREE
      const staleToken = jwt.sign(
        { userId: "user_upgrade_123", tier: "FREE", accessToken: "gho_test123" },
        process.env.JWT_SECRET
      );

      const req = {
        headers: { authorization: `Bearer ${staleToken}` }
      };

      const authContext = await decodeAuth(req);
      assert.equal(authContext.userId, "user_upgrade_123");
      assert.equal(authContext.tier, "PRO", "Fresh DB tier PRO should override token's stale FREE tier");
      assert.equal(authContext.user.tier, "PRO");
      assert.equal(authContext.accessToken, "gho_test123");
    } finally {
      prisma.user.findUnique = originalFindUnique;
    }
  });

  test("requireAuth assigns req.auth, req.user, and req.sub uniformly", async () => {
    const originalFindUnique = prisma.user.findUnique;
    try {
      prisma.user.findUnique = async () => ({
        id: "user_uniform",
        tier: "HOBBY",
        username: "dev_user"
      });

      const token = jwt.sign(
        { userId: "user_uniform", tier: "HOBBY", accessToken: "gho_sample" },
        process.env.JWT_SECRET
      );

      const req = {
        headers: { authorization: `Bearer ${token}` }
      };
      let nextCalled = false;
      const res = {
        status() { return this; },
        json() { return this; }
      };

      await new Promise((resolve) => {
        requireAuth(req, res, () => {
          nextCalled = true;
          resolve();
        });
      });

      assert.equal(nextCalled, true);
      assert.ok(req.auth);
      assert.strictEqual(req.auth, req.user);
      assert.strictEqual(req.auth, req.sub);
      assert.equal(req.auth.userId, "user_uniform");
      assert.equal(req.auth.tier, "HOBBY");
    } finally {
      prisma.user.findUnique = originalFindUnique;
    }
  });

  test("getTierLimits provides single source of truth for quotas", () => {
    const freeLimits = getTierLimits("FREE");
    assert.equal(freeLimits.maxProjects, 1);
    assert.equal(freeLimits.maxConcurrentBuilds, 1);
    assert.equal(freeLimits.maxPreviews, 1);

    const hobbyLimits = getTierLimits("HOBBY");
    assert.equal(hobbyLimits.maxProjects, 2);
    assert.equal(hobbyLimits.maxConcurrentBuilds, 1);
    assert.equal(hobbyLimits.maxPreviews, 5);

    const proLimits = getTierLimits("PRO");
    assert.equal(proLimits.maxProjects, Infinity);
    assert.equal(proLimits.maxConcurrentBuilds, 3);
    assert.equal(proLimits.maxPreviews, Infinity);

    const entLimits = getTierLimits("ENTERPRISE");
    assert.equal(entLimits.maxProjects, Infinity);
    assert.equal(entLimits.maxConcurrentBuilds, 10);
    assert.equal(entLimits.maxPreviews, Infinity);
  });

  test("assertRepoQuota allows Infinity for PRO and ENTERPRISE without database query", async () => {
    const proUser = { id: "u_pro", tier: "PRO" };
    const entUser = { id: "u_ent", tier: "ENTERPRISE" };

    const resPro = await assertRepoQuota(proUser);
    const resEnt = await assertRepoQuota(entUser);

    assert.equal(resPro, true);
    assert.equal(resEnt, true);
  });

  test("assertRepoQuota enforces quota on FREE tier", async () => {
    const originalCount = prisma.project.count;
    try {
      prisma.project.count = async () => 1; // Already 1 project
      const freeUser = { id: "u_free", tier: "FREE" };

      await assert.rejects(
        () => assertRepoQuota(freeUser),
        (err) => {
          assert.equal(err.code, "REPO_QUOTA_EXCEEDED");
          assert.match(err.message, /allows max 1/);
          return true;
        }
      );
    } finally {
      prisma.project.count = originalCount;
    }
  });

  test("assertPreviewQuota allows Infinity for PRO and ENTERPRISE without database query", async () => {
    const proUser = { id: "u_pro", tier: "PRO" };
    const entUser = { id: "u_ent", tier: "ENTERPRISE" };

    const resPro = await assertPreviewQuota(proUser);
    const resEnt = await assertPreviewQuota(entUser);

    assert.equal(resPro, true);
    assert.equal(resEnt, true);
  });

  test("assertPreviewQuota enforces quota on HOBBY tier", async () => {
    const originalCount = prisma.preview.count;
    try {
      prisma.preview.count = async () => 5; // HOBBY allows 5 previews
      const hobbyUser = { id: "u_hobby", tier: "HOBBY" };

      await assert.rejects(
        () => assertPreviewQuota(hobbyUser),
        (err) => {
          assert.equal(err.code, "PREVIEW_QUOTA_EXCEEDED");
          assert.match(err.message, /allows max 5/);
          return true;
        }
      );
    } finally {
      prisma.preview.count = originalCount;
    }
  });
});
