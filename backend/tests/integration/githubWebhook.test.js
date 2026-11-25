// backend/tests/integration/githubWebhook.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import request from "supertest";
import app from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { setPRHandlers } from "../../src/routes/githubWebhook.js";

describe("5.2 GitHub Webhook API Integration Tests", () => {
  let originalFindMany;

  const webhookSecret = "test_webhook_secret_key_42";
  const mockProject = {
    id: "proj_webhook_1",
    userId: "user_owner_1",
    repoOwner: "testorg",
    repoName: "testrepo",
    webhookSecret,
    user: { id: "user_owner_1", tier: "PRO" }
  };

  beforeEach(() => {
    originalFindMany = prisma.project.findMany;
  });

  afterEach(() => {
    prisma.project.findMany = originalFindMany;
    setPRHandlers(); // restores default handlers
  });

  function signPayload(body, secret = webhookSecret) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const hmac = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    return { raw, signature: `sha256=${hmac}` };
  }

  test("rejects webhook request missing repository details with 400", async () => {
    const res = await request(app)
      .post("/webhooks/github")
      .send({ action: "opened" });

    assert.equal(res.status, 400);
    assert.equal(res.text, "no repo");
  });

  test("rejects webhook request when project is not registered in database with 404", async () => {
    prisma.project.findMany = async () => [];

    const payload = {
      repository: { owner: { login: "unknown-org" }, name: "unknown-repo" },
      action: "opened"
    };

    const res = await request(app)
      .post("/webhooks/github")
      .send(payload);

    assert.equal(res.status, 404);
    assert.equal(res.text, "project not registered");
  });

  test("rejects webhook request with invalid HMAC signature with 401", async () => {
    prisma.project.findMany = async () => [mockProject];

    const payload = {
      repository: { owner: { login: "testorg" }, name: "testrepo" },
      action: "opened",
      pull_request: { number: 10 }
    };

    const res = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", "sha256=invalid_signature_hash")
      .send(payload);

    assert.equal(res.status, 401);
    assert.equal(res.text, "invalid signature");
  });

  test("ignores non-pull_request events with 200 ignored", async () => {
    prisma.project.findMany = async () => [mockProject];

    const payload = {
      repository: { owner: { login: "testorg" }, name: "testrepo" }
    };
    const { signature } = signPayload(payload);

    const res = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "push")
      .set("X-Hub-Signature-256", signature)
      .send(payload);

    assert.equal(res.status, 200);
    assert.equal(res.text, "ignored");
  });

  test("rejects pull_request event missing PR number with 400", async () => {
    prisma.project.findMany = async () => [mockProject];

    const payload = {
      repository: { owner: { login: "testorg" }, name: "testrepo" },
      action: "opened"
    };
    const { signature } = signPayload(payload);

    const res = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", signature)
      .send(payload);

    assert.equal(res.status, 400);
    assert.equal(res.text, "missing pr number");
  });

  test("blocks PR build on FREE tier with 200 free_tier_blocked", async () => {
    const freeProject = {
      ...mockProject,
      user: { id: "user_owner_1", tier: "FREE" }
    };
    prisma.project.findMany = async () => [freeProject];

    const payload = {
      repository: { owner: { login: "testorg" }, name: "testrepo" },
      action: "opened",
      pull_request: { number: 1, head: { ref: "main", sha: "abc1" } }
    };
    const { signature } = signPayload(payload);

    const res = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", signature)
      .send(payload);

    assert.equal(res.status, 200);
    assert.equal(res.text, "free_tier_blocked");
  });

  test("blocks PR synchronize on HOBBY tier with 200 hobby_sync_ignored", async () => {
    const hobbyProject = {
      ...mockProject,
      user: { id: "user_owner_1", tier: "HOBBY" }
    };
    prisma.project.findMany = async () => [hobbyProject];

    const payload = {
      repository: { owner: { login: "testorg" }, name: "testrepo" },
      action: "synchronize",
      pull_request: { number: 2, head: { ref: "feat-1", sha: "abc2" } }
    };
    const { signature } = signPayload(payload);

    const res = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", signature)
      .send(payload);

    assert.equal(res.status, 200);
    assert.equal(res.text, "hobby_sync_ignored");
  });

  test("executes build on PRO tier for opened, synchronize, and reopened actions", async () => {
    prisma.project.findMany = async () => [mockProject];

    for (const action of ["opened", "synchronize", "reopened"]) {
      let openSyncCalled = false;
      setPRHandlers({
        onOpenOrSync: async ({ project, prNumber, ref }) => {
          openSyncCalled = true;
          assert.equal(project.id, mockProject.id);
          assert.equal(prNumber, 42);
          assert.equal(ref, "feat/pr-branch");
        }
      });

      const payload = {
        repository: { owner: { login: "testorg" }, name: "testrepo" },
        action,
        pull_request: {
          number: 42,
          head: { ref: "feat/pr-branch", sha: "sha42" }
        }
      };
      const { signature } = signPayload(payload);

      const res = await request(app)
        .post("/webhooks/github")
        .set("X-GitHub-Event", "pull_request")
        .set("X-Hub-Signature-256", signature)
        .send(payload);

      assert.equal(res.status, 200);
      assert.equal(res.text, "ok");
      assert.equal(openSyncCalled, true, `onOpenOrSync must be called for action: ${action}`);
    }
  });

  test("executes cleanup when action is closed", async () => {
    prisma.project.findMany = async () => [mockProject];

    let closeCalled = false;
    setPRHandlers({
      onClosed: async ({ project, prNumber }) => {
        closeCalled = true;
        assert.equal(project.id, mockProject.id);
        assert.equal(prNumber, 99);
      }
    });

    const payload = {
      repository: { owner: { login: "testorg" }, name: "testrepo" },
      action: "closed",
      pull_request: { number: 99, head: { ref: "main", sha: "sha99" } }
    };
    const { signature } = signPayload(payload);

    const res = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", signature)
      .send(payload);

    assert.equal(res.status, 200);
    assert.equal(res.text, "ok");
    assert.equal(closeCalled, true);
  });

  test("rejects duplicate webhook delivery with 200 duplicate when X-GitHub-Delivery was already recorded", async () => {
    prisma.project.findMany = async () => [mockProject];

    let handlerCalls = 0;
    setPRHandlers({
      onOpenOrSync: async () => {
        handlerCalls++;
      }
    });

    const deliveryId = "del-uuid-unique-12345";
    const payload = {
      repository: { owner: { login: "testorg" }, name: "testrepo" },
      action: "opened",
      pull_request: { number: 7, head: { ref: "feature/test", sha: "sha777" } }
    };
    const { signature } = signPayload(payload);

    // Mock prisma for webhookDelivery: first call is not duplicate, second call is duplicate
    const deliveryStore = new Set();
    prisma.webhookDelivery.findUnique = async ({ where }) => {
      if (deliveryStore.has(where.deliveryId)) {
        return { deliveryId: where.deliveryId, status: "PROCESSED" };
      }
      return null;
    };
    prisma.webhookDelivery.create = async ({ data }) => {
      deliveryStore.add(data.deliveryId);
      return { id: "wd_1", ...data };
    };
    prisma.webhookDelivery.update = async ({ where, data }) => ({
      deliveryId: where.deliveryId,
      ...data
    });

    // 1. First delivery
    const res1 = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-GitHub-Delivery", deliveryId)
      .set("X-Hub-Signature-256", signature)
      .send(payload);

    assert.equal(res1.status, 200);
    assert.equal(res1.text, "ok");
    assert.equal(handlerCalls, 1);

    // 2. Duplicate delivery with identical X-GitHub-Delivery
    const res2 = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-GitHub-Delivery", deliveryId)
      .set("X-Hub-Signature-256", signature)
      .send(payload);

    assert.equal(res2.status, 200);
    assert.equal(res2.text, "duplicate");
    assert.equal(handlerCalls, 1, "Handler must NOT be executed for duplicate webhook delivery");
  });

  test("extracts immutable commitSha and passes it to onOpenOrSync handler", async () => {
    prisma.project.findMany = async () => [mockProject];

    let capturedArgs = null;
    setPRHandlers({
      onOpenOrSync: async (args) => {
        capturedArgs = args;
      }
    });

    const payload = {
      repository: { owner: { login: "testorg" }, name: "testrepo" },
      action: "synchronize",
      pull_request: {
        number: 88,
        head: { ref: "feature/mutable-branch", sha: "immutable-sha-99999" }
      }
    };
    const { signature } = signPayload(payload);

    prisma.webhookDelivery.findUnique = async () => null;
    prisma.webhookDelivery.create = async ({ data }) => ({ id: "wd_2", ...data });
    prisma.webhookDelivery.update = async ({ where, data }) => ({ deliveryId: where.deliveryId, ...data });

    const res = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-GitHub-Delivery", "del-unique-sha-check")
      .set("X-Hub-Signature-256", signature)
      .send(payload);

    assert.equal(res.status, 200);
    assert.ok(capturedArgs);
    assert.equal(capturedArgs.prNumber, 88);
    assert.equal(capturedArgs.commitSha, "immutable-sha-99999");
    assert.equal(capturedArgs.ref, "feature/mutable-branch");
  });

  test("webhook default orchestrator enqueues durable build without blocking and supersedes prior queued build", async () => {
    const origMockBuildFindMany = prisma.build.findMany;
    const origMockBuildFindFirst = prisma.build.findFirst;
    const origMockBuildCreate = prisma.build.create;
    const origMockBuildUpdateMany = prisma.build.updateMany;
    const origMockPreviewUpsert = prisma.preview.upsert;
    const origMockPreviewUpdate = prisma.preview.update;
    const origMockWdFindUnique = prisma.webhookDelivery.findUnique;
    const origMockWdCreate = prisma.webhookDelivery.create;
    const origMockWdUpdate = prisma.webhookDelivery.update;

    try {
      prisma.project.findMany = async () => [mockProject];
      prisma.webhookDelivery.findUnique = async () => null;
      prisma.webhookDelivery.create = async ({ data }) => ({ id: "wd_q1", ...data });
      prisma.webhookDelivery.update = async ({ where, data }) => ({ deliveryId: where.deliveryId, ...data });

      const enqueuedBuilds = [];
      let supersedeCount = 0;

      prisma.preview.upsert = async ({ create }) => ({
        id: "prev_webhook_queue_1",
        ...create
      });
      prisma.preview.update = async ({ where, data }) => ({ id: where.id, ...data });
      prisma.build.findMany = async () => [];
      prisma.build.findFirst = async () =>
        enqueuedBuilds.length ? enqueuedBuilds[enqueuedBuilds.length - 1] : null;
      prisma.build.updateMany = async ({ data }) => {
        if (data.status === "SUPERSEDED") supersedeCount++;
        return { count: 1 };
      };
      prisma.build.create = async ({ data }) => {
        const b = { id: `build_q_${enqueuedBuilds.length + 1}`, ...data };
        enqueuedBuilds.push(b);
        return b;
      };

      const payload1 = {
        repository: { owner: { login: "testorg" }, name: "testrepo" },
        action: "opened",
        pull_request: {
          number: 51,
          title: "First commit",
          head: { ref: "feat/fast-webhook", sha: "sha_1111" }
        }
      };
      const sig1 = signPayload(payload1).signature;

      const res1 = await request(app)
        .post("/webhooks/github")
        .set("X-GitHub-Event", "pull_request")
        .set("X-GitHub-Delivery", "del-async-1")
        .set("X-Hub-Signature-256", sig1)
        .send(payload1);

      assert.equal(res1.status, 200);
      assert.equal(res1.text, "ok");

      const payload2 = {
        repository: { owner: { login: "testorg" }, name: "testrepo" },
        action: "synchronize",
        pull_request: {
          number: 51,
          title: "Second commit",
          head: { ref: "feat/fast-webhook", sha: "sha_2222" }
        }
      };
      const sig2 = signPayload(payload2).signature;

      const res2 = await request(app)
        .post("/webhooks/github")
        .set("X-GitHub-Event", "pull_request")
        .set("X-GitHub-Delivery", "del-async-2")
        .set("X-Hub-Signature-256", sig2)
        .send(payload2);

      assert.equal(res2.status, 200);
      assert.equal(enqueuedBuilds.length, 2);
      assert.equal(enqueuedBuilds[0].source, "WEBHOOK_OPEN");
      assert.equal(enqueuedBuilds[0].commitSha, "sha_1111");
      assert.equal(enqueuedBuilds[1].source, "WEBHOOK_SYNC");
      assert.equal(enqueuedBuilds[1].commitSha, "sha_2222");
      assert.equal(supersedeCount, 2);
    } finally {
      prisma.build.findMany = origMockBuildFindMany;
      prisma.build.findFirst = origMockBuildFindFirst;
      prisma.build.create = origMockBuildCreate;
      prisma.build.updateMany = origMockBuildUpdateMany;
      prisma.preview.upsert = origMockPreviewUpsert;
      prisma.preview.update = origMockPreviewUpdate;
      prisma.webhookDelivery.findUnique = origMockWdFindUnique;
      prisma.webhookDelivery.create = origMockWdCreate;
      prisma.webhookDelivery.update = origMockWdUpdate;
    }
  });
});
