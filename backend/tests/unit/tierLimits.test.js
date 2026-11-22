// backend/tests/unit/tierLimits.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  TIER_LIMITS,
  normalizeTier,
  getTierLimits,
  compareTier
} from "../../src/middleware/tierLimits.js";
import {
  assertRepoQuota,
  assertPreviewQuota,
  getPortPoolForTier,
  tierPortPools
} from "../../src/middleware/subscription.js";
import { enforceBuildLimit } from "../../src/routes/previewActions.js";
import { prisma } from "../../src/db.js";

describe("4.6 User Tier & Build Limits Unit Tests", () => {
  let originalProjectCount;
  let originalPreviewCount;

  beforeEach(() => {
    originalProjectCount = prisma.project.count;
    originalPreviewCount = prisma.preview.count;
  });

  afterEach(() => {
    prisma.project.count = originalProjectCount;
    prisma.preview.count = originalPreviewCount;
  });

  test("defines correct limits matching business specification for all four tiers", () => {
    assert.deepEqual(TIER_LIMITS.FREE, {
      maxProjects: 1,
      maxConcurrentBuilds: 1,
      maxPreviews: 1,
      allowWebhooks: false
    });

    assert.deepEqual(TIER_LIMITS.HOBBY, {
      maxProjects: 2,
      maxConcurrentBuilds: 1,
      maxPreviews: 5,
      allowWebhooks: false
    });

    assert.deepEqual(TIER_LIMITS.PRO, {
      maxProjects: Infinity,
      maxConcurrentBuilds: 3,
      maxPreviews: Infinity,
      allowWebhooks: true
    });

    assert.deepEqual(TIER_LIMITS.ENTERPRISE, {
      maxProjects: Infinity,
      maxConcurrentBuilds: 10,
      maxPreviews: Infinity,
      allowWebhooks: true
    });
  });

  test("normalizeTier defaults missing, lowercase, or unknown tiers to FREE", () => {
    assert.equal(normalizeTier(null), "FREE");
    assert.equal(normalizeTier(undefined), "FREE");
    assert.equal(normalizeTier(""), "FREE");
    assert.equal(normalizeTier("free"), "FREE");
    assert.equal(normalizeTier("hobby"), "HOBBY");
    assert.equal(normalizeTier("pro"), "PRO");
    assert.equal(normalizeTier("enterprise"), "ENTERPRISE");
    assert.equal(normalizeTier("UNKNOWN_TIER"), "FREE");
  });

  test("compareTier correctly ranks tier hierarchy", () => {
    // Current vs Target
    assert.equal(compareTier("FREE", "PRO"), 1, "FREE to PRO is an upgrade (1)");
    assert.equal(compareTier("PRO", "FREE"), -1, "PRO to FREE is a downgrade (-1)");
    assert.equal(compareTier("PRO", "PRO"), 0, "Same tier returns 0");
    assert.equal(compareTier("HOBBY", "ENTERPRISE"), 1);
    assert.equal(compareTier("ENTERPRISE", "HOBBY"), -1);
  });

  test("assertRepoQuota enforces project count limits", async () => {
    // FREE: max 1
    prisma.project.count = async () => 0;
    const allowed = await assertRepoQuota({ id: "u1", tier: "FREE" });
    assert.equal(allowed, true);

    prisma.project.count = async () => 1;
    await assert.rejects(
      async () => assertRepoQuota({ id: "u1", tier: "FREE" }),
      (err) => {
        assert.equal(err.code, "REPO_QUOTA_EXCEEDED");
        assert.match(err.message, /allows max 1/);
        return true;
      }
    );

    // HOBBY: max 2
    prisma.project.count = async () => 1;
    assert.equal(await assertRepoQuota({ id: "u2", tier: "HOBBY" }), true);

    prisma.project.count = async () => 2;
    await assert.rejects(
      async () => assertRepoQuota({ id: "u2", tier: "HOBBY" }),
      (err) => {
        assert.equal(err.code, "REPO_QUOTA_EXCEEDED");
        return true;
      }
    );

    // PRO: unlimited
    let countCalled = false;
    prisma.project.count = async () => { countCalled = true; return 1000; };
    assert.equal(await assertRepoQuota({ id: "u3", tier: "PRO" }), true);
    assert.equal(countCalled, false, "Should not query DB for Infinite quota");
  });

  test("assertPreviewQuota enforces live preview limits", async () => {
    // FREE: max 1
    prisma.preview.count = async () => 0;
    assert.equal(await assertPreviewQuota({ id: "u1", tier: "FREE" }), true);

    prisma.preview.count = async () => 1;
    await assert.rejects(
      async () => assertPreviewQuota({ id: "u1", tier: "FREE" }),
      (err) => {
        assert.equal(err.code, "PREVIEW_QUOTA_EXCEEDED");
        assert.match(err.message, /allows max 1 live previews/);
        return true;
      }
    );

    // HOBBY: max 5
    prisma.preview.count = async () => 4;
    assert.equal(await assertPreviewQuota({ id: "u2", tier: "HOBBY" }), true);

    prisma.preview.count = async () => 5;
    await assert.rejects(
      async () => assertPreviewQuota({ id: "u2", tier: "HOBBY" }),
      (err) => {
        assert.equal(err.code, "PREVIEW_QUOTA_EXCEEDED");
        assert.match(err.message, /allows max 5 live previews/);
        return true;
      }
    );

    // ENTERPRISE: unlimited
    assert.equal(await assertPreviewQuota({ id: "u4", tier: "ENTERPRISE" }), true);
  });

  test("enforceBuildLimit verifies concurrent build limit for each tier", async () => {
    // PRO tier allows 3 concurrent builds
    prisma.preview.count = async () => 2;
    const proAllowed = await enforceBuildLimit("u_pro", "PRO");
    assert.equal(proAllowed.allowed, true);

    prisma.preview.count = async () => 3;
    const proBlocked = await enforceBuildLimit("u_pro", "PRO");
    assert.equal(proBlocked.allowed, false);
    assert.match(proBlocked.message, /allows only 3 concurrent build/);

    // ENTERPRISE allows 10 concurrent builds
    prisma.preview.count = async () => 9;
    assert.equal((await enforceBuildLimit("u_ent", "ENTERPRISE")).allowed, true);

    prisma.preview.count = async () => 10;
    assert.equal((await enforceBuildLimit("u_ent", "ENTERPRISE")).allowed, false);
  });

  test("getPortPoolForTier assigns distinct exclusive ranges for paid tiers", () => {
    const freePool = getPortPoolForTier("FREE");
    const proPool = getPortPoolForTier("PRO");
    const entPool = getPortPoolForTier("ENTERPRISE");

    assert.equal(freePool.exclusive, false);
    assert.equal(proPool.exclusive, true);
    assert.equal(proPool.min, 5000);
    assert.equal(entPool.exclusive, true);
    assert.equal(entPool.min, 4001);
  });
});
