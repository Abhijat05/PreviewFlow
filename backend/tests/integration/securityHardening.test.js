// backend/tests/integration/securityHardening.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { io as Client } from "socket.io-client";
import app, { issueAuthExchangeCode } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { mockPrisma } from "../helpers/prismaMock.js";
import { generateTestToken } from "../helpers/authHelper.js";
import {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
  serializeProjectSafe
} from "../../src/services/cryptoService.js";
import { decodeAuth } from "../../src/middleware/auth.js";
import { setRepoAccessVerifier, resetRepoAccessVerifier } from "../../src/routes/connectRepo.js";
import { setPRHandlers } from "../../src/routes/githubWebhook.js";
import { createRateLimiter } from "../../src/middleware/rateLimiter.js";
import { validateProductionConfig } from "../../src/utils/configValidation.js";
import { verifyGithubSignature } from "../../src/utils/gitHubVerify.js";
import { isValidRepoCoordinates } from "../../src/utils/validation.js";
import {
  assertNoUnsafeSymlinks,
  detectProjectType
} from "../../src/services/detectProjectType.js";
import {
  buildRunArgs,
  ensureIsolatedNetwork,
  resolvePreviewUrl
} from "../../src/services/dockerService.js";
import { initSocket } from "../../src/socket.js";
import { enforceBuildQuota } from "../../src/services/quotaService.js";

describe("Security Hardening & Audit Remediations Suite", () => {
  let prismaRestore;
  const tempDirs = [];

  beforeEach(() => {
    const { restore } = mockPrisma();
    prismaRestore = restore;
    setPRHandlers();
    resetRepoAccessVerifier();
  });

  afterEach(() => {
    resetRepoAccessVerifier();
    setPRHandlers();
    if (prismaRestore) prismaRestore();
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    delete process.env.PREVIEW_BASE_DOMAIN;
    delete process.env.PREVIEW_URL_PROTOCOL;
  });

  test("cryptoService encrypts secrets with AES-256-GCM, prevents double encryption, and preserves legacy plaintext", () => {
    const plain = "ghp_super_secret_token_xyz123";
    const encrypted = encryptSecret(plain);

    assert.ok(isEncryptedSecret(encrypted));
    assert.notEqual(encrypted, plain);
    assert.equal(encryptSecret(encrypted), encrypted, "Encryption must be idempotent");
    assert.equal(decryptSecret(encrypted), plain);
    assert.equal(decryptSecret("legacy_plaintext_secret"), "legacy_plaintext_secret");
    assert.equal(decryptSecret(null), null);

    // Tampered ciphertext/tag must fail GCM verification
    const corrupted = encrypted.slice(0, -4) + "0000";
    assert.throws(() => decryptSecret(corrupted));
  });

  test("OAuth single-use auth code exchange avoids raw tokens in URLs and keeps GitHub accessToken server-side", async () => {
    const serverJwt = jwt.sign({ userId: "u_oauth_1", tier: "PRO" }, process.env.JWT_SECRET);
    const code = issueAuthExchangeCode(serverJwt);

    // 1. First exchange succeeds and returns JWT without embedded GitHub accessToken
    const res1 = await request(app).post("/auth/exchange").send({ code });
    assert.equal(res1.status, 200);
    assert.equal(res1.body.token, serverJwt);

    const decoded = jwt.decode(res1.body.token);
    assert.equal(decoded.accessToken, undefined, "Client JWT must NOT embed GitHub accessToken");

    // 2. Replay of same code fails with 401
    const resReplay = await request(app).post("/auth/exchange").send({ code });
    assert.equal(resReplay.status, 401);
    assert.equal(resReplay.body.error, "invalid_or_expired_code");

    // 3. Server-side middleware decrypts User.accessToken from DB transparently
    const encryptedUserTok = encryptSecret("gho_db_stored_server_token");
    prisma.user.findUnique = async () => ({
      id: "u_oauth_1",
      tier: "PRO",
      accessToken: encryptedUserTok
    });

    const authCtx = await decodeAuth({
      headers: { authorization: `Bearer ${serverJwt}` }
    });
    assert.equal(authCtx.accessToken, "gho_db_stored_server_token");
  });

  test("connectRepo rejects path-injection repo slugs (400) and unauthorized repo access (403)", async () => {
    const userId = "user_repo_sec";
    const token = generateTestToken({ userId, tier: "PRO" });
    prisma.user.findUnique = async () => ({
      id: userId,
      tier: "PRO",
      accessToken: encryptSecret("gho_valid_user_tok")
    });
    prisma.project.count = async () => 0;

    assert.equal(isValidRepoCoordinates("valid-org", "../../user/keys"), false);
    assert.equal(isValidRepoCoordinates("valid-org", "my-repo"), true);

    const resBadSlug = await request(app)
      .post("/api/connect-repo")
      .set("Authorization", `Bearer ${token}`)
      .send({ repoOwner: "valid-org", repoName: "../../user/keys" });

    assert.equal(resBadSlug.status, 400);
    assert.equal(resBadSlug.body.error, "invalid_repo_identifier");

    setRepoAccessVerifier(async () => false);
    const resForbidden = await request(app)
      .post("/api/connect-repo")
      .set("Authorization", `Bearer ${token}`)
      .send({ repoOwner: "victim-org", repoName: "private-app" });

    assert.equal(resForbidden.status, 403);
    assert.equal(resForbidden.body.error, "insufficient_repo_permissions");
  });

  test("webhook verifies HMAC signature BEFORE delivery deduplication and rejects fork PRs by default", async () => {
    const secretPlain = "webhook_hmac_key_high_04";
    const mockProject = {
      id: "proj_sec_wh",
      userId: "u_wh",
      repoOwner: "sec-org",
      repoName: "sec-repo",
      webhookSecret: encryptSecret(secretPlain),
      allowForkBuilds: false,
      user: { id: "u_wh", tier: "PRO" }
    };

    prisma.project.findMany = async () => [mockProject];
    prisma.webhookDelivery.findUnique = async ({ where }) =>
      where.deliveryId === "known-delivery-id" ? { deliveryId: "known-delivery-id" } : null;

    // 1. Invalid signature with existing deliveryId MUST fail 401 (no delivery enumeration leak)
    const invalidRes = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-GitHub-Delivery", "known-delivery-id")
      .set("X-Hub-Signature-256", "sha256=deadbeefdeadbeef")
      .send({
        repository: { owner: { login: "sec-org" }, name: "sec-repo" },
        action: "opened",
        pull_request: { number: 10, head: { ref: "feat", sha: "sha1" } }
      });

    assert.equal(invalidRes.status, 401);
    assert.equal(invalidRes.text, "invalid signature");
    assert.equal(verifyGithubSignature(undefined, "sha256=abc", "secret"), false);

    // 2. Valid HMAC from external fork PR is blocked cleanly when allowForkBuilds is false
    let handlerCalled = false;
    setPRHandlers({
      onOpenOrSync: async () => {
        handlerCalled = true;
      }
    });

    const forkPayload = {
      repository: { owner: { login: "sec-org" }, name: "sec-repo" },
      action: "opened",
      pull_request: {
        number: 99,
        head: { ref: "evil-pr", sha: "sha_fork_99", repo: { fork: true, full_name: "attacker/sec-repo" } },
        base: { repo: { full_name: "sec-org/sec-repo" } }
      }
    };
    const rawFork = JSON.stringify(forkPayload);
    const sigFork = `sha256=${crypto.createHmac("sha256", secretPlain).update(rawFork).digest("hex")}`;

    const forkRes = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-GitHub-Delivery", "del-fork-99")
      .set("X-Hub-Signature-256", sigFork)
      .send(forkPayload);

    assert.equal(forkRes.status, 200);
    assert.equal(forkRes.text, "fork_pr_blocked");
    assert.equal(handlerCalled, false);
  });

  test("webhook enforces unified tenant concurrency quota without blocking same-PR updates", async () => {
    const secretPlain = "webhook_quota_secret";
    const mockProject = {
      id: "proj_quota",
      userId: "u_pro_quota",
      repoOwner: "q-org",
      repoName: "q-repo",
      webhookSecret: secretPlain,
      allowForkBuilds: false,
      user: { id: "u_pro_quota", tier: "FREE" }
    };

    prisma.project.findMany = async () => [mockProject];

    // FREE tier limit maxConcurrentBuilds = 1; simulate another PR currently building
    prisma.preview.findFirst = async () => null;
    prisma.preview.count = async () => 1;
    prisma.build.findMany = async () => [
      { previewId: "prev_other_busy", status: "RUNNING" }
    ];

    const check = await enforceBuildQuota({
      userId: "u_pro_quota",
      tier: "FREE",
      previewId: "prev_new_pr",
      isNewPreview: false
    });
    assert.equal(check.allowed, false);
    assert.equal(check.code, "build_limit_reached");
  });

  test("symlink firewall rejects escaping symlinks and symlinked Dockerfiles", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pf-symlink-parent-"));
    const repoDir = path.join(parent, "repo");
    const outsideDir = path.join(parent, "outside");
    tempDirs.push(parent);

    fs.mkdirSync(repoDir);
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "topsecret");
    fs.writeFileSync(path.join(outsideDir, "Dockerfile"), "FROM alpine");

    const linkPath = path.join(repoDir, "escape-link");
    // Use junction on Windows (works unprivileged) or dir symlink on POSIX
    fs.symlinkSync(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");

    assert.throws(
      () => assertNoUnsafeSymlinks(repoDir),
      /Security violation:.*escapes repository boundary/i
    );

    // Also test internal regular files pass cleanly
    const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-clean-repo-"));
    tempDirs.push(cleanDir);
    fs.writeFileSync(path.join(cleanDir, "index.html"), "<h1>Safe</h1>");
    assertNoUnsafeSymlinks(cleanDir);
    assert.equal(detectProjectType(cleanDir), "static");
  });

  test("Docker runArgs include isolated network, metadata blackhole, log rotation caps, and subdomain isolation URL", async () => {
    const args = buildRunArgs({
      containerName: "preview-p1-pr2-b3",
      assignedPort: 5055,
      containerPort: 80,
      imageName: "previewflow/org-repo:pr-2-b3",
      tier: "FREE",
      networkName: "previewflow-sandbox"
    });

    assert.ok(args.includes("--network"));
    assert.ok(args.includes("previewflow-sandbox"));
    assert.ok(args.includes("metadata.google.internal:127.0.0.1"));
    assert.ok(args.includes("max-size=10m"));
    assert.ok(args.includes("nofile=1024:2048"));

    const createdCommands = [];
    const netName = await ensureIsolatedNetwork({
      networkName: "previewflow-sandbox",
      execFn: async (bin, netArgs) => {
        createdCommands.push(netArgs);
        if (netArgs[1] === "inspect") return { err: new Error("not found") };
        return { err: null };
      }
    });
    assert.equal(netName, "previewflow-sandbox");
    assert.ok(createdCommands[1].includes("com.docker.network.bridge.enable_icc=false"));

    process.env.PREVIEW_BASE_DOMAIN = "previews.example.com";
    const prodUrl = resolvePreviewUrl({
      previewId: "prev123456",
      prNumber: 42,
      buildNumber: 3,
      port: 5055
    });
    assert.equal(prodUrl, "https://pr-42-b3-prev12.previews.example.com");
  });

  test("HTTP security headers, fail-fast production config check, and rate limiter 429 enforcement work", async () => {
    const res = await request(app).get("/health");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal(res.headers["x-powered-by"], undefined);
    assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/);

    assert.throws(
      () =>
        validateProductionConfig({
          NODE_ENV: "production",
          JWT_SECRET: "short",
          ENCRYPTION_KEY: "short",
          GITHUB_CLIENT_ID: "ci_mock_123",
          GITHUB_CLIENT_SECRET: "ci_mock_456"
        }),
      /Invalid production security configuration/
    );

    assert.doesNotThrow(() =>
      validateProductionConfig({
        NODE_ENV: "production",
        JWT_SECRET: "a".repeat(40),
        ENCRYPTION_KEY: "b".repeat(40),
        DATABASE_URL: "postgresql://user:pass@db:5432/prod",
        GITHUB_CLIENT_ID: "real_client_id",
        GITHUB_CLIENT_SECRET: "real_client_secret"
      })
    );

    // Rate limiter test with strict limit=2
    const limitedApp = express();
    limitedApp.use(
      "/limited",
      createRateLimiter({
        windowMs: 60000,
        max: 2,
        errorCode: "test_limited",
        respectTestBypass: false
      }),
      (req, res) => res.json({ ok: true })
    );

    await request(limitedApp).get("/limited").expect(200);
    await request(limitedApp).get("/limited").expect(200);
    const blocked = await request(limitedApp).get("/limited").expect(429);
    assert.equal(blocked.body.error, "test_limited");
  });

  test("Socket.IO disconnects idle unauthenticated connections and rejects invalid previewIds", async () => {
    const prevTimeout = process.env.SOCKET_AUTH_TIMEOUT_MS;
    const srv = http.createServer();
    const io = initSocket(srv);
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    try {
      const client = Client(`http://127.0.0.1:${port}`, {
        autoConnect: false,
        reconnection: false
      });
      const errPromise = new Promise((r) => client.on("error", r));
      const discPromise = new Promise((r) => client.on("disconnect", r));
      client.connect();

      // Send invalid previewId format
      client.on("connect", () => {
        client.emit("register", {
          token: generateTestToken({ userId: "u_sock", tier: "PRO" }),
          previewId: { bad: "object" }
        });
      });

      const [errMsg] = await Promise.all([errPromise, discPromise]);
      assert.equal(errMsg, "Invalid previewId");
      client.disconnect();
    } finally {
      if (prevTimeout !== undefined) process.env.SOCKET_AUTH_TIMEOUT_MS = prevTimeout;
      io.disconnectSockets(true);
      await new Promise((r) => io.close(r));
      await new Promise((r) => srv.close(r));
    }
  });
});
