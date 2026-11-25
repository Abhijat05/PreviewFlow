// backend/tests/e2e/workflows.test.js
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import crypto from "crypto";
import request from "supertest";
import { io as Client } from "socket.io-client";
import app from "../../src/server.js";
import { initSocket } from "../../src/socket.js";
import { prisma } from "../../src/db.js";
import { generateTestToken } from "../helpers/authHelper.js";
import { setPRHandlers } from "../../src/routes/githubWebhook.js";
import * as repoService from "../../src/services/repoService.js";
import * as dockerService from "../../src/services/dockerService.js";
import { handlePROpenOrSync, handlePRClosed } from "../../src/services/prHandlers.js";

describe("9. Critical End-to-End Workflow Tests", () => {
  let server;
  let io;
  let port;
  let originalFindUniqueUser;
  let originalFindUniquePreview;
  let originalFindFirstPreview;
  let originalFindManyPreview;
  let originalFindManyProject;
  let originalUpdatePreview;
  let originalUpsertPreview;
  let originalBuildFindMany;
  let originalBuildUpdate;

  const testUserId = "user_e2e_owner";
  const testUserToken = generateTestToken({ userId: testUserId, tier: "PRO" });
  const webhookSecret = "e2e_secret_token_12345";

  const testProject = {
    id: "proj_e2e_1",
    userId: testUserId,
    repoOwner: "previewflow-org",
    repoName: "sample-app",
    webhookSecret,
    accessToken: "ghp_e2e_mock_token",
    user: { id: testUserId, tier: "PRO" }
  };

  before(async () => {
    server = http.createServer(app);
    io = initSocket(server);

    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    if (io) {
      io.disconnectSockets(true);
      await new Promise((r) => io.close(r));
    }
    if (server) {
      await new Promise((r) => server.close(r));
    }
  });

  beforeEach(() => {
    originalFindUniqueUser = prisma.user.findUnique;
    originalFindUniquePreview = prisma.preview.findUnique;
    originalFindFirstPreview = prisma.preview.findFirst;
    originalFindManyPreview = prisma.preview.findMany;
    originalFindManyProject = prisma.project.findMany;
    originalUpdatePreview = prisma.preview.update;
    originalUpsertPreview = prisma.preview.upsert;
    originalBuildFindMany = prisma.build.findMany;
    originalBuildUpdate = prisma.build.update;

    prisma.build.findMany = async () => [];
    prisma.build.update = async ({ where, data }) => ({ id: where.id, ...data });

    prisma.user.findUnique = async ({ where }) => ({
      id: where.id,
      tier: "PRO",
      username: "e2e_owner"
    });
    prisma.project.findMany = async () => [testProject];
  });

  afterEach(() => {
    prisma.user.findUnique = originalFindUniqueUser;
    prisma.preview.findUnique = originalFindUniquePreview;
    prisma.preview.findFirst = originalFindFirstPreview;
    prisma.preview.findMany = originalFindManyPreview;
    prisma.project.findMany = originalFindManyProject;
    prisma.preview.update = originalUpdatePreview;
    prisma.preview.upsert = originalUpsertPreview;
    prisma.build.findMany = originalBuildFindMany;
    prisma.build.update = originalBuildUpdate;
    setPRHandlers();
  });

  function signPayload(body) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const hmac = crypto.createHmac("sha256", webhookSecret).update(raw).digest("hex");
    return { raw, signature: `sha256=${hmac}` };
  }

  test("Workflow A — Project and Preview Lifecycle (Open PR -> Build -> Live -> Owner View)", async () => {
    let previewRecord = {
      id: "prev_e2e_101",
      projectId: testProject.id,
      prNumber: 42,
      status: "building",
      url: null,
      project: testProject
    };

    prisma.preview.upsert = async () => previewRecord;
    prisma.preview.update = async ({ data }) => {
      previewRecord = { ...previewRecord, ...data };
      return previewRecord;
    };
    prisma.preview.findUnique = async () => previewRecord;

    let buildRan = false;
    setPRHandlers({
      onOpenOrSync: async ({ project, prNumber, ref }) => {
        // Run simulated build pipeline
        await handlePROpenOrSync({
          project,
          prNumber,
          ref,
          cloner: async () => "D:\\dummy\\path",
          builder: async () => {
            buildRan = true;
            return "http://localhost:5055";
          }
        });
      }
    });

    const payload = {
      repository: { owner: { login: testProject.repoOwner }, name: testProject.repoName },
      action: "opened",
      pull_request: { number: 42, head: { ref: "feature/auth-modal", sha: "sha42abc" } }
    };
    const { signature } = signPayload(payload);

    // 1. Simulate GitHub Webhook
    const webhookRes = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", signature)
      .send(payload);

    assert.equal(webhookRes.status, 200);
    assert.equal(webhookRes.text, "ok");
    assert.equal(buildRan, true, "Build operation should have executed");

    // 2. Verify preview status is accessible to authorized owner
    const detailsRes = await request(app)
      .get("/api/preview/prev_e2e_101/logs")
      .set("Authorization", `Bearer ${testUserToken}`);

    assert.equal(detailsRes.status, 200);
  });

  test("Workflow B — Build Failure handling and error propagation", async () => {
    let previewRecord = {
      id: "prev_fail_102",
      projectId: testProject.id,
      prNumber: 50,
      status: "building",
      url: null,
      project: testProject
    };

    prisma.preview.upsert = async () => previewRecord;
    prisma.preview.update = async ({ data }) => {
      previewRecord = { ...previewRecord, ...data };
      return previewRecord;
    };

    let buildFailedCleanly = false;
    setPRHandlers({
      onOpenOrSync: async ({ project, prNumber, ref }) => {
        try {
          await handlePROpenOrSync({
            project,
            prNumber,
            ref,
            cloner: async () => "D:\\dummy\\fail-path",
            builder: async () => {
              throw new Error("Compilation failed: SyntaxError in src/index.js");
            }
          });
        } catch (err) {
          buildFailedCleanly = true;
          assert.match(err.message, /SyntaxError/);
        }
      }
    });

    const payload = {
      repository: { owner: { login: testProject.repoOwner }, name: testProject.repoName },
      action: "synchronize",
      pull_request: { number: 50, head: { ref: "broken-ref", sha: "sha50" } }
    };
    const { signature } = signPayload(payload);

    const res = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", signature)
      .send(payload);

    assert.equal(res.status, 200);
    assert.equal(buildFailedCleanly, true);
  });

  test("Workflow C — Pull Request Closure (Closed PR -> Container cleanup -> Deleted Status)", async () => {
    let containerRemoved = null;
    let previewDeleted = false;

    prisma.preview.findFirst = async () => ({
      id: "prev_to_teardown",
      containerName: "preview-p1-pr42-b1",
      status: "live",
      port: 5055
    });

    prisma.preview.update = async ({ data }) => {
      if (data.status === "deleted") previewDeleted = true;
      return { id: "prev_to_teardown", ...data };
    };

    setPRHandlers({
      onClosed: async ({ project, prNumber }) => {
        await handlePRClosed({
          project,
          prNumber,
          containerRemover: async (name) => {
            containerRemoved = name;
            return true;
          }
        });
      }
    });

    const payload = {
      repository: { owner: { login: testProject.repoOwner }, name: testProject.repoName },
      action: "closed",
      pull_request: { number: 42, head: { ref: "feature/auth-modal", sha: "sha42" } }
    };
    const { signature } = signPayload(payload);

    const res = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", signature)
      .send(payload);

    assert.equal(res.status, 200);
    assert.equal(containerRemoved, "preview-p1-pr42-b1");
    assert.equal(previewDeleted, true);
  });

  test("Workflow D — Realtime Updates (Socket client -> Preview registration -> Live Telemetry Events)", async () => {
    prisma.preview.findUnique = async () => ({
      id: "prev_realtime_104",
      project: testProject
    });

    const client = Client(`http://127.0.0.1:${port}`, {
      autoConnect: false,
      reconnection: false
    });

    let receivedStats = null;
    let receivedLogs = [];

    client.on("connect", () => {
      client.emit("register", { token: testUserToken, previewId: "prev_realtime_104" });
    });
    client.on("preview-stats-update", (data) => {
      receivedStats = data;
    });
    client.on("log", (data) => {
      receivedLogs.push(data.chunk);
    });

    const registeredPromise = new Promise((resolve) => client.on("registered", resolve));
    client.connect();
    await registeredPromise;

    // Simulate server-side build log chunk and container stats update
    io.to("prev_realtime_104").emit("log", { chunk: "Compiling TypeScript bundles...\n" });
    io.to("preview:prev_realtime_104").emit("preview-stats-update", {
      previewId: "prev_realtime_104",
      cpu: 28.5,
      memory: 209715200, // 200 MB
      networkRx: 50000,
      networkTx: 25000,
      uptime: 45
    });

    await new Promise((r) => setTimeout(r, 100));

    assert.equal(receivedLogs[0], "Compiling TypeScript bundles...\n");
    assert.ok(receivedStats);
    assert.equal(receivedStats.cpu, 28.5);
    assert.equal(receivedStats.uptime, 45);

    client.disconnect();
  });
});
