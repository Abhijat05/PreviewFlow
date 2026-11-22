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
});
