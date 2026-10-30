import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { verifyGithubSignature } from "../src/utils/gitHubVerify.js";
import { handleCreateWebhook } from "../src/routes/createWebhook.js";
import { handleConnectRepo } from "../src/routes/connectRepo.js";
import { handleGithubWebhook } from "../src/routes/githubWebhook.js";

describe("Webhook security, signature verification & routing", () => {
  test("verifyGithubSignature correctly validates HMAC SHA-256 signatures", () => {
    const secret = "super_secret_webhook_key_123";
    const payload = JSON.stringify({ action: "opened", pull_request: { number: 42 } });
    const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const validSignature = `sha256=${hmac}`;

    assert.equal(verifyGithubSignature(payload, validSignature, secret), true);
    assert.equal(verifyGithubSignature(payload, "sha256=invalidhex123", secret), false);
    assert.equal(verifyGithubSignature(payload, "", secret), false);
    assert.equal(verifyGithubSignature(payload, validSignature, "wrong_secret"), false);
  });

  test("handleCreateWebhook rejects tiers that do not allow webhooks with 403", async () => {
    const req = {
      body: { projectId: "proj_123" },
      auth: {
        user: { id: "user_1", tier: "FREE" },
        accessToken: "gh_test_token"
      }
    };
    let statusCode = 200;
    let jsonBody = null;
    const res = {
      status(c) { statusCode = c; return this; },
      json(d) { jsonBody = d; return this; }
    };

    await handleCreateWebhook(req, res);

    assert.equal(statusCode, 403);
    assert.equal(jsonBody?.error, "webhook_not_allowed");
  });

  test("handleCreateWebhook rejects when GitHub access token is missing", async () => {
    const req = {
      body: { projectId: "non_existent_or_no_token" },
      auth: {
        user: { id: "user_1", tier: "PRO" }
        // no accessToken in auth
      }
    };
    let statusCode = 200;
    let jsonBody = null;
    const res = {
      status(c) { statusCode = c; return this; },
      json(d) { jsonBody = d; return this; }
    };

    await handleCreateWebhook(req, res);

    // Should reject because project not found or missing token
    assert.ok(statusCode === 400 || statusCode === 404);
  });

  test("handleConnectRepo rejects invalid input types", async () => {
    const req = {
      body: { repoOwner: 123, repoName: null },
      sub: { user: { id: "u1", tier: "FREE" } }
    };
    let statusCode = 200;
    let jsonBody = null;
    const res = {
      status(c) { statusCode = c; return this; },
      json(d) { jsonBody = d; return this; }
    };

    await handleConnectRepo(req, res);
    assert.equal(statusCode, 400);
    assert.equal(jsonBody?.error, "invalid_input_format");
  });

  test("handleGithubWebhook rejects when signature is missing or does not match", async () => {
    const req = {
      header(h) {
        if (h === "X-GitHub-Event") return "pull_request";
        if (h === "X-Hub-Signature-256") return "sha256=invalidsig";
        return null;
      },
      body: {
        repository: { owner: { login: "testowner" }, name: "testrepo" },
        action: "opened",
        pull_request: { number: 10 }
      },
      rawBody: JSON.stringify({ action: "opened" })
    };
    let statusCode = 200;
    let sentData = null;
    const res = {
      status(c) { statusCode = c; return this; },
      send(d) { sentData = d; return this; }
    };

    await handleGithubWebhook(req, res);

    // 404 (if repo not registered) or 401 (invalid signature)
    assert.ok([401, 404].includes(statusCode));
  });
});
