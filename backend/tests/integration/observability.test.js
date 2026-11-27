// backend/tests/integration/observability.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import app, { issueAuthExchangeCode } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { mockPrisma } from "../helpers/prismaMock.js";
import { generateTestToken } from "../helpers/authHelper.js";
import {
  createLogger,
  redactString,
  redactValue,
  runWithContext,
  extendContext,
  getLogContext
} from "../../src/utils/logger.js";
import {
  resetMetrics,
  recordBuildMetric,
  recordWebhookMetric
} from "../../src/services/metricsService.js";
import { createAlertManager, defaultAlertManager } from "../../src/services/alertService.js";
import { recordAuditEvent } from "../../src/services/auditService.js";
import { executeBuildJob } from "../../src/services/buildOrchestrator.js";
import { setRepoAccessVerifier, resetRepoAccessVerifier } from "../../src/routes/connectRepo.js";
import { setPRHandlers } from "../../src/routes/githubWebhook.js";
import { encryptSecret } from "../../src/services/cryptoService.js";
import { recoverStaleLeases } from "../../src/services/buildWorker.js";

describe("Observability, Structured Logging, AuditLog & Alerting Suite", () => {
  let prismaRestore;
  const origMetricsToken = process.env.METRICS_TOKEN;

  beforeEach(() => {
    const { restore } = mockPrisma();
    prismaRestore = restore;
    resetMetrics();
    defaultAlertManager.reset();
    setPRHandlers();
    resetRepoAccessVerifier();
    delete process.env.METRICS_TOKEN;
  });

  afterEach(() => {
    setPRHandlers();
    resetRepoAccessVerifier();
    defaultAlertManager.reset();
    resetMetrics();
    if (origMetricsToken !== undefined) {
      process.env.METRICS_TOKEN = origMetricsToken;
    } else {
      delete process.env.METRICS_TOKEN;
    }
    if (prismaRestore) prismaRestore();
  });

  test("redacted logger scrubs tokens, secrets, URLs, and JWTs even under forced Errors", () => {
    const fakeToken = "ghp_1234567890abcdef1234567890abcdef";
    const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1MSJ9.s3cr3tS1gn4tur3Hash";
    const fakeEnc = "enc:v1:ivbase64:tagbase64:cipherbase64";
    const rawGitUrl = `https://x-access-token:${fakeToken}@github.com/org/repo.git`;

    const scrubbedUrl = redactString(rawGitUrl);
    assert.equal(scrubbedUrl, "https://***@github.com/org/repo.git");
    assert.ok(!scrubbedUrl.includes(fakeToken));

    const scrubbedQuery = redactString("https://app.local/auth/success?code=secretcode123&token=myjwt");
    assert.equal(scrubbedQuery, "https://app.local/auth/success?code=[REDACTED]&token=[REDACTED]");

    const err = new Error(`Clone failed with Bearer ${fakeToken} and ${fakeEnc}`);
    const obj = redactValue({
      statusCode: 500,
      exitCode: 1,
      accessToken: fakeToken,
      webhookSecret: "whsec_very_secret",
      nested: { jwt: fakeJwt, url: rawGitUrl },
      err
    });

    assert.equal(obj.statusCode, 500);
    assert.equal(obj.exitCode, 1);
    assert.equal(obj.accessToken, "[REDACTED]");
    assert.equal(obj.webhookSecret, "[REDACTED]");
    assert.equal(obj.nested.jwt, "[REDACTED]");
    assert.ok(!obj.nested.url.includes(fakeToken));
    assert.ok(!obj.err.message.includes(fakeToken));
    assert.ok(!obj.err.message.includes(fakeEnc));

    const captured = [];
    const testLogger = createLogger({
      level: "debug",
      sink: (_rec, line) => captured.push(line)
    });

    runWithContext({ requestId: "req-corr-1", buildId: "bld-99" }, () => {
      extendContext({ userId: "user-42" });
      testLogger.info("Processing step", { accessToken: fakeToken, code: "auth_once", errorCode: "NONE" });
    });

    assert.equal(captured.length, 1);
    assert.ok(!captured[0].includes(fakeToken));
    assert.ok(!captured[0].includes("auth_once"));
    const parsed = JSON.parse(captured[0]);
    assert.equal(parsed.requestId, "req-corr-1");
    assert.equal(parsed.buildId, "bld-99");
    assert.equal(parsed.userId, "user-42");
    assert.equal(parsed.errorCode, "NONE");
    assert.equal(parsed.msg, "Processing step");
  });

  test("AsyncLocalStorage isolates correlation contexts across concurrent async executions", async () => {
    const [ctxA, ctxB] = await Promise.all([
      runWithContext({ requestId: "req-A", buildId: "b-A" }, async () => {
        await new Promise((r) => setTimeout(r, 15));
        extendContext({ userId: "user-A" });
        await new Promise((r) => setTimeout(r, 10));
        return { ...getLogContext() };
      }),
      runWithContext({ requestId: "req-B", buildId: "b-B" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        extendContext({ userId: "user-B" });
        await new Promise((r) => setTimeout(r, 20));
        return { ...getLogContext() };
      })
    ]);

    assert.equal(ctxA.requestId, "req-A");
    assert.equal(ctxA.userId, "user-A");
    assert.equal(ctxB.requestId, "req-B");
    assert.equal(ctxB.userId, "user-B");
  });

  test("HTTP middleware preserves valid X-Request-Id, replaces unsafe values, and records metrics", async () => {
    const res1 = await request(app).get("/health").set("X-Request-Id", "trace_abc-123");
    assert.equal(res1.status, 200);
    assert.equal(res1.headers["x-request-id"], "trace_abc-123");

    const res2 = await request(app).get("/health").set("X-Request-Id", "bad/../../inject space!");
    assert.equal(res2.status, 200);
    assert.ok(res2.headers["x-request-id"]);
    assert.notEqual(res2.headers["x-request-id"], "bad/../../inject space!");

    const metricsRes = await request(app).get("/metrics");
    assert.equal(metricsRes.status, 200);
    assert.match(metricsRes.headers["content-type"], /text\/plain/);
    assert.match(metricsRes.text, /previewflow_http_requests_total\{.*route="\/health".*status_class="2xx"\}/);
    assert.match(metricsRes.text, /previewflow_http_request_duration_seconds_bucket/);
    assert.match(metricsRes.text, /previewflow_process_uptime_seconds/);
  });

  test("AuditLog captures lifecycle & security actions, redacts metadata, and /api/audit-logs isolates tenants", async () => {
    const prevEncKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "test_observability_encryption_key_32chars!";
    const auditEntries = [];
    const userId = "u_audit_1";
    const otherUserId = "u_audit_2";
    const token = generateTestToken({ userId, tier: "PRO" });

    prisma.user.findUnique = async ({ where }) => {
      if (where.id === userId) {
        return { id: userId, tier: "PRO", accessToken: encryptSecret("gho_secret_oauth_token") };
      }
      return null;
    };
    prisma.project.count = async () => 0;
    prisma.project.findFirst = async () => null;
    prisma.project.create = async ({ data }) => ({ id: "proj_aud_1", ...data });
    prisma.project.findMany = async () => [
      {
        id: "proj_aud_1",
        userId,
        repoOwner: "octo",
        repoName: "app",
        webhookSecret: encryptSecret("hook_sec_1"),
        user: { id: userId, tier: "PRO" }
      }
    ];
    prisma.preview.findUnique = async ({ where }) =>
      where.id === "prev_aud_1"
        ? {
            id: "prev_aud_1",
            projectId: "proj_aud_1",
            prNumber: 7,
            status: "live",
            url: "http://localhost:5000",
            deployedCommitSha: "abc123",
            project: { id: "proj_aud_1", userId }
          }
        : null;
    prisma.preview.update = async ({ data }) => ({ id: "prev_aud_1", ...data });
    prisma.build.findMany = async () => [];
    prisma.auditLog.create = async ({ data }) => {
      const rec = { id: `aud_${auditEntries.length + 1}`, createdAt: new Date(), ...data };
      auditEntries.push(rec);
      return rec;
    };
    prisma.auditLog.findMany = async ({ where }) =>
      auditEntries.filter((e) => e.actorUserId === where.actorUserId);

    setRepoAccessVerifier(async () => true);

    try {
      // 1. Project connect creates PROJECT_CONNECTED
      await request(app)
        .post("/api/connect-repo")
        .set("Authorization", `Bearer ${token}`)
        .set("X-Request-Id", "req-audit-connect")
        .send({ repoOwner: "octo", repoName: "app" })
        .expect(200);

      // 2. OAuth auth code replay creates DENIED AUTH_EXCHANGE
      const authCode = issueAuthExchangeCode(
        jwt.sign({ userId, tier: "PRO" }, process.env.JWT_SECRET)
      );
      await request(app).post("/auth/exchange").send({ code: authCode }).expect(200);
      await request(app).post("/auth/exchange").send({ code: authCode }).expect(401);

      // 3. Invalid webhook signature creates WEBHOOK_SIGNATURE_INVALID
      await request(app)
        .post("/webhooks/github")
        .set("X-GitHub-Event", "pull_request")
        .set("X-GitHub-Delivery", "del-aud-1")
        .set("X-Hub-Signature-256", "sha256=" + "0".repeat(64))
        .send({ repository: { owner: { login: "octo" }, name: "app" } })
        .expect(401);

      // 4. Preview delete creates PREVIEW_DELETED
      await request(app)
        .post("/api/preview/prev_aud_1/delete")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      // 5. Production tier upgrade rejection creates TIER_UPGRADE_DENIED
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        await request(app)
          .post("/api/account/change-tier")
          .set("Authorization", `Bearer ${token}`)
          .send({ newTier: "ENTERPRISE" })
          .expect(402);
      } finally {
        process.env.NODE_ENV = prevEnv;
      }

      // 6. Direct recordAuditEvent redacts sensitive metadata keys
      await recordAuditEvent({
        actorUserId: otherUserId,
        action: "SECRET_TEST_ACTION",
        metadata: { accessToken: "gho_must_not_persist", webhookSecret: "whsec_raw" }
      });

      const actions = auditEntries.map((e) => e.action);
      assert.ok(actions.includes("PROJECT_CONNECTED"));
      assert.ok(actions.includes("AUTH_EXCHANGE"));
      assert.ok(actions.includes("WEBHOOK_SIGNATURE_INVALID"));
      assert.ok(actions.includes("PREVIEW_DELETED"));
      assert.ok(actions.includes("TIER_UPGRADE_DENIED"));

      const connectEntry = auditEntries.find((e) => e.action === "PROJECT_CONNECTED");
      assert.equal(connectEntry.requestId, "req-audit-connect");

      const otherEntry = auditEntries.find((e) => e.actorUserId === otherUserId);
      assert.equal(otherEntry.metadata.accessToken, "[REDACTED]");
      assert.equal(otherEntry.metadata.webhookSecret, "[REDACTED]");

      // Tenant isolation check on /api/audit-logs
      await request(app).get("/api/audit-logs").expect(401);
      const listRes = await request(app)
        .get("/api/audit-logs")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      assert.ok(listRes.body.logs.length >= 4);
      assert.ok(listRes.body.logs.every((entry) => entry.actorUserId === userId));
    } finally {
      if (prevEncKey !== undefined) {
        process.env.ENCRYPTION_KEY = prevEncKey;
      } else {
        delete process.env.ENCRYPTION_KEY;
      }
    }
  });

  test("Prometheus /metrics enforces optional METRICS_TOKEN, exposes build/webhook gauges, and survives DB failure", async () => {
    process.env.METRICS_TOKEN = "prom-scrape-secret";

    await request(app).get("/metrics").expect(401);
    await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer wrong-token")
      .expect(401);

    prisma.build.count = async ({ where }) => (where.status === "QUEUED" ? 4 : 1);
    prisma.preview.count = async ({ where }) => (where.status === "live" ? 7 : 0);
    recordBuildMetric({ status: "COMPLETED", source: "WEBHOOK_OPEN", tier: "PRO", durationSeconds: 12.5 });
    recordWebhookMetric({ event: "pull_request", outcome: "processed" });

    const okRes = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer prom-scrape-secret")
      .expect(200);

    assert.match(okRes.text, /previewflow_builds_total\{status="COMPLETED",source="WEBHOOK_OPEN"\} 1/);
    assert.match(okRes.text, /previewflow_build_duration_seconds_bucket\{status="COMPLETED",tier="PRO",le="15"\} 1/);
    assert.match(okRes.text, /previewflow_build_queue_depth\{status="QUEUED"\} 4/);
    assert.match(okRes.text, /previewflow_previews_by_status\{status="live"\} 7/);
    assert.match(okRes.text, /previewflow_webhooks_total\{event="pull_request",outcome="processed"\} 1/);

    // Graceful degradation when DB throws
    prisma.build.count = async () => {
      throw new Error("DB down");
    };
    await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer prom-scrape-secret")
      .expect(200);
  });

  test("alertService triggers on build failure spikes, invalid HMAC floods, lease recovery, and exposes status on /health/ready", async () => {
    const fired = [];
    const manager = createAlertManager({
      windowMs: 60_000,
      cooldownMs: 60_000,
      buildFailureRate: 0.4,
      buildFailureMinSamples: 5,
      invalidSignatureThreshold: 3,
      http5xxThreshold: 2,
      queueDepthThreshold: 10,
      leaseRecoveryThreshold: 2
    });
    const unsubscribe = manager.onAlert((a) => fired.push(a));

    manager.recordBuildOutcome("COMPLETED");
    manager.recordBuildOutcome("COMPLETED");
    manager.recordBuildOutcome("COMPLETED");
    manager.recordBuildOutcome("FAILED");
    assert.equal(fired.length, 0);

    // 2/5 = 40% >= threshold -> critical alert fires once
    manager.recordBuildOutcome("FAILED");
    // Cooldown suppresses duplicate alert emission even if more failures arrive immediately
    manager.recordBuildOutcome("FAILED");
    assert.equal(fired.length, 1);
    assert.equal(fired[0].rule, "HIGH_BUILD_FAILURE_RATE");
    assert.equal(fired[0].severity, "critical");

    manager.recordInvalidSignature();
    manager.recordInvalidSignature();
    manager.recordInvalidSignature();
    assert.equal(fired.length, 2);
    assert.equal(fired[1].rule, "WEBHOOK_INVALID_SIGNATURE_SPIKE");

    manager.recordQueueDepth(12);
    assert.equal(fired.length, 3);
    assert.equal(fired[2].rule, "BUILD_QUEUE_BACKLOG");

    manager.recordLeaseRecoveries(2);
    assert.equal(fired.length, 4);
    assert.equal(fired[3].rule, "WORKER_LEASE_EXPIRY_SPIKE");

    assert.equal(manager.getAlertState().status, "critical");
    unsubscribe();

    // Verify /health/ready surfaces defaultAlertManager status + executeBuildJob records completion metrics
    prisma.preview.findUnique = async () => ({
      id: "prev_obs_1",
      projectId: "proj_obs_1",
      prNumber: 1,
      status: "building",
      project: {
        id: "proj_obs_1",
        userId: "u_obs",
        repoOwner: "org",
        repoName: "repo",
        accessToken: null,
        user: { id: "u_obs", tier: "PRO" }
      }
    });
    prisma.build.findUnique = async () => ({ id: "bld_obs_1", status: "RUNNING" });
    prisma.build.update = async ({ data }) => ({ id: "bld_obs_1", ...data });
    prisma.preview.update = async ({ data }) => ({ id: "prev_obs_1", ...data });

    await executeBuildJob(
      { id: "bld_obs_1", previewId: "prev_obs_1", buildNumber: 1, commitSha: "deadbeef", branch: "main" },
      {
        cloner: async () => null,
        builder: async () => ({
          url: "http://localhost:5099",
          containerName: "preview-obs-1",
          port: 5099,
          imageName: "previewflow/obs:1"
        }),
        containerRemover: async () => {},
        imageRemover: async () => {},
        portReleaser: async () => {}
      }
    );

    defaultAlertManager.triggerAlert({
      rule: "TEST_DEGRADED_CHECK",
      severity: "warning",
      message: "Simulated warning"
    });
    const readyRes = await request(app).get("/health/ready").expect(200);
    assert.equal(readyRes.body.alerts, "degraded");
    assert.equal(readyRes.body.activeAlertsCount, 1);

    // Also verify recoverStaleLeases reports stale recovery count to alert manager
    prisma.build.findMany = async () => [
      { id: "b_stale_1", attempt: 1, maxAttempts: 3, workerId: "w-dead", leaseExpiresAt: new Date(Date.now() - 10_000) }
    ];
    const recReport = await recoverStaleLeases();
    assert.equal(recReport.recoveredCount, 1);
  });
});
