// backend/tests/integration/productionReadiness.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import app, { shutdownServer } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { mockPrisma } from "../helpers/prismaMock.js";
import { generateTestToken } from "../helpers/authHelper.js";
import { createWorkerLoop } from "../../src/services/buildWorker.js";
import { executeBuildJob } from "../../src/services/buildOrchestrator.js";
import { runStartupReconciliation } from "../../src/services/reconciliationService.js";
import { allocatePort, releasePortInMemory, getPendingAllocatedPorts } from "../../src/services/portService.js";
import { setPRHandlers } from "../../src/routes/githubWebhook.js";

describe("Production Readiness & End-to-End Failure Simulations", () => {
  let prismaRestore;
  let store;
  let seq;
  let tempDirs;

  const ownerId = "user_prod_owner";
  const otherId = "user_prod_other";
  const ownerToken = generateTestToken({ userId: ownerId, tier: "PRO" });
  const otherToken = generateTestToken({ userId: otherId, tier: "PRO" });
  const webhookSecret = "prod_readiness_secret_key";

  const baseProject = {
    id: "proj_prod_1",
    userId: ownerId,
    repoOwner: "acme-corp",
    repoName: "frontend-app",
    webhookSecret,
    accessToken: "ghp_prod_mock",
    user: { id: ownerId, tier: "PRO" }
  };

  function signWebhook(body) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const sig = crypto.createHmac("sha256", webhookSecret).update(raw).digest("hex");
    return `sha256=${sig}`;
  }

  beforeEach(() => {
    const { restore } = mockPrisma();
    prismaRestore = restore;
    setPRHandlers();
    seq = 0;
    tempDirs = [];

    store = {
      users: new Map([
        [ownerId, { id: ownerId, tier: "PRO", username: "acme_owner" }],
        [otherId, { id: otherId, tier: "PRO", username: "other_user" }]
      ]),
      projects: new Map([[baseProject.id, baseProject]]),
      previews: new Map(),
      builds: new Map(),
      deliveries: new Map(),
      ports: new Map()
    };

    prisma.user.findUnique = async ({ where }) => store.users.get(where.id) || null;
    prisma.project.findMany = async ({ where }) =>
      Array.from(store.projects.values()).filter(
        (p) => (!where?.repoOwner || p.repoOwner === where.repoOwner) && (!where?.repoName || p.repoName === where.repoName)
      );

    prisma.webhookDelivery.findUnique = async ({ where }) => store.deliveries.get(where.deliveryId) || null;
    prisma.webhookDelivery.create = async ({ data }) => {
      const rec = { id: `wd_${++seq}`, ...data };
      store.deliveries.set(data.deliveryId, rec);
      return rec;
    };
    prisma.webhookDelivery.update = async ({ where, data }) => {
      const prev = store.deliveries.get(where.deliveryId);
      const updated = { ...prev, ...data };
      store.deliveries.set(where.deliveryId, updated);
      return updated;
    };

    prisma.preview.upsert = async ({ where, update, create }) => {
      const existing = Array.from(store.previews.values()).find(
        (p) =>
          p.projectId === where.projectId_prNumber.projectId &&
          p.prNumber === where.projectId_prNumber.prNumber
      );
      if (existing) {
        const updated = { ...existing, ...update };
        store.previews.set(existing.id, updated);
        return updated;
      }
      const rec = {
        id: `prev_${++seq}`,
        buildNumber: 1,
        activeBuildId: null,
        latestBuildId: null,
        desiredCommitSha: null,
        deployedCommitSha: null,
        url: null,
        containerName: null,
        port: null,
        ...create,
        project: baseProject
      };
      store.previews.set(rec.id, rec);
      return rec;
    };

    prisma.preview.findUnique = async ({ where }) => {
      const p = store.previews.get(where.id);
      return p ? { ...p, project: baseProject } : null;
    };

    prisma.preview.findFirst = async ({ where } = {}) => {
      for (const p of store.previews.values()) {
        if (where?.id && p.id !== where.id) continue;
        if (where?.projectId && p.projectId !== where.projectId) continue;
        if (where?.prNumber !== undefined && p.prNumber !== where.prNumber) continue;
        if (where?.port !== undefined && p.port !== where.port) continue;
        if (where?.status?.not && p.status === where.status.not) continue;
        return { ...p, project: baseProject };
      }
      return null;
    };

    prisma.preview.findMany = async ({ where } = {}) =>
      Array.from(store.previews.values())
        .filter((p) => {
          if (where?.status === "building") return p.status === "building";
          if (where?.status?.not) return p.status !== where.status.not;
          return true;
        })
        .map((p) => ({ ...p, project: baseProject }));

    prisma.preview.update = async ({ where, data }) => {
      const p = store.previews.get(where.id);
      if (!p) throw new Error(`Preview ${where.id} not found`);
      const updated = { ...p, ...data };
      store.previews.set(where.id, updated);
      return updated;
    };

    prisma.build.create = async ({ data }) => {
      const rec = { id: `build_${++seq}`, ...data };
      store.builds.set(rec.id, rec);
      return rec;
    };

    prisma.build.findUnique = async ({ where }) => store.builds.get(where.id) || null;

    prisma.build.findFirst = async ({ where, orderBy } = {}) => {
      const list = Array.from(store.builds.values()).filter(
        (b) => !where?.previewId || b.previewId === where.previewId
      );
      if (orderBy?.buildNumber === "desc") list.sort((a, b) => b.buildNumber - a.buildNumber);
      return list[0] || null;
    };

    prisma.build.findMany = async ({ where, orderBy, take, skip = 0 } = {}) => {
      let list = Array.from(store.builds.values()).filter((b) => {
        if (where?.previewId && b.previewId !== where.previewId) return false;
        if (where?.status && b.status !== where.status) return false;
        return true;
      });
      if (orderBy?.buildNumber === "desc") list.sort((a, b) => b.buildNumber - a.buildNumber);
      if (take !== undefined) list = list.slice(skip, skip + take);
      return list;
    };

    prisma.build.update = async ({ where, data }) => {
      const b = store.builds.get(where.id);
      if (!b) throw new Error(`Build ${where.id} not found`);
      const updated = { ...b, ...data };
      store.builds.set(where.id, updated);
      return updated;
    };

    prisma.build.updateMany = async ({ where, data }) => {
      let count = 0;
      for (const [id, b] of store.builds.entries()) {
        if (where?.previewId && b.previewId !== where.previewId) continue;
        if (where?.status && b.status !== where.status) continue;
        store.builds.set(id, { ...b, ...data });
        count++;
      }
      return { count };
    };

    prisma.portAllocation.findUnique = async ({ where }) => store.ports.get(where.port) || null;
    prisma.portAllocation.findMany = async ({ where } = {}) =>
      Array.from(store.ports.values()).filter((row) => {
        if (where?.isAllocated !== undefined && row.isAllocated !== where.isAllocated) return false;
        if (where?.previewId && row.previewId !== where.previewId) return false;
        return true;
      });
    prisma.portAllocation.create = async ({ data }) => {
      const r = { ...data };
      store.ports.set(r.port, r);
      return r;
    };
    prisma.portAllocation.update = async ({ where, data }) => {
      const existing = store.ports.get(where.port);
      const updated = { ...existing, ...data };
      store.ports.set(where.port, updated);
      return updated;
    };
    prisma.portAllocation.updateMany = async ({ where, data }) => {
      let count = 0;
      for (const [port, row] of store.ports.entries()) {
        if (where?.port !== undefined) {
          if (typeof where.port === "object" && where.port.not !== undefined) {
            if (port === where.port.not) continue;
          } else if (port !== where.port) continue;
        }
        if (where?.previewId && row.previewId !== where.previewId) continue;
        if (where?.buildId && row.buildId !== where.buildId) continue;
        store.ports.set(port, { ...row, ...data });
        count++;
      }
      return { count };
    };

    // Simulate PostgreSQL raw queries (SKIP LOCKED job claiming, advisory lock, port leasing)
    prisma.$queryRaw = async (strings, ...values) => {
      const sql = strings.join("?");
      if (sql.includes("SELECT 1")) {
        return [{ ok: 1 }];
      }
      if (sql.includes("pg_try_advisory_lock")) {
        return [{ acquired: true }];
      }
      if (sql.includes("pg_advisory_unlock")) {
        return [{ pg_advisory_unlock: true }];
      }
      if (sql.includes('UPDATE "Build"')) {
        const workerIdArg = values[0];
        const leaseSec = Number(values[1]) || 60;
        const queued = Array.from(store.builds.values())
          .filter((b) => b.status === "QUEUED")
          .sort((a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime());
        if (!queued.length) return [];
        const job = queued[0];
        const updated = {
          ...job,
          status: "RUNNING",
          workerId: workerIdArg,
          startedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + leaseSec * 1000)
        };
        store.builds.set(job.id, updated);
        return [updated];
      }
      if (sql.includes('INSERT INTO "PortAllocation"')) {
        const port = values[0];
        const previewId = values[1];
        const buildId = values[2];
        const existing = store.ports.get(port);
        if (existing && existing.isAllocated && existing.previewId !== previewId) {
          return [];
        }
        const row = { port, previewId, buildId, isAllocated: true };
        store.ports.set(port, row);
        return [row];
      }
      return [];
    };
  });

  afterEach(() => {
    for (const p of getPendingAllocatedPorts()) {
      releasePortInMemory(p);
    }
    for (const d of tempDirs) {
      try {
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    setPRHandlers();
    if (prismaRestore) prismaRestore();
  });

  test("Full E2E Lifecycle: Webhook -> Replay Guard -> Worker Build -> Live -> Build History -> PR Closure", async () => {
    const prNumber = 101;
    const sha1 = "sha101aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const webhookPayload = {
      repository: { owner: { login: baseProject.repoOwner }, name: baseProject.repoName },
      action: "opened",
      pull_request: {
        number: prNumber,
        title: "Add user profile page",
        head: { ref: "feat/profile", sha: sha1 }
      }
    };

    // 1. Webhook Ingress (fast enqueue)
    const wh1 = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-GitHub-Delivery", "del-e2e-101")
      .set("X-Hub-Signature-256", signWebhook(webhookPayload))
      .send(webhookPayload);

    assert.equal(wh1.status, 200);
    assert.equal(wh1.text, "ok");
    assert.equal(store.builds.size, 1);

    // 2. Duplicate replay rejected idempotently
    const whDup = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-GitHub-Delivery", "del-e2e-101")
      .set("X-Hub-Signature-256", signWebhook(webhookPayload))
      .send(webhookPayload);

    assert.equal(whDup.status, 200);
    assert.equal(whDup.text, "duplicate");
    assert.equal(store.builds.size, 1);

    const preview = Array.from(store.previews.values())[0];
    const [queuedBuild] = Array.from(store.builds.values());
    assert.equal(queuedBuild.status, "QUEUED");

    // 3. Worker loop claims & executes build through orchestrator & portService
    const removedContainers = [];
    const removedImages = [];

    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "prod-e2e-repo-"));
    tempDirs.push(tempRepo);

    let workerDoneResolve;
    const workerDone = new Promise((r) => {
      workerDoneResolve = r;
    });

    const workerLoop = createWorkerLoop({
      workerId: "worker-e2e-1",
      pollIntervalMs: 30,
      leaseDurationSeconds: 30,
      heartbeatIntervalMs: 200,
      executeJob: async (job, ctx) => {
        await executeBuildJob(job, {
          ...ctx,
          cloner: async ({ commitSha }) => {
            assert.equal(commitSha, sha1);
            return tempRepo;
          },
          builder: async ({ previewId, buildNumber }) => {
            const alloc = await allocatePort({
              previewId,
              buildId: job.id,
              tier: "PRO",
              osPortChecker: async () => true
            });
            return {
              url: `http://localhost:${alloc.port}`,
              containerName: `preview-pprod-pr${prNumber}-b${buildNumber}`,
              port: alloc.port,
              imageName: `previewflow/acme-corp-frontend-app:pr-${prNumber}-b${buildNumber}-sha101a`,
              logs: "Container ready on port " + alloc.port
            };
          },
          containerRemover: async (name) => {
            removedContainers.push(name);
            return true;
          },
          imageRemover: async (img) => {
            removedImages.push(img);
            return true;
          }
        });
        workerDoneResolve();
      }
    });

    workerLoop.start();
    await workerDone;
    workerLoop.stop();

    const livePreview = store.previews.get(preview.id);
    assert.equal(livePreview.status, "live");
    assert.equal(livePreview.activeBuildId, queuedBuild.id);
    assert.equal(livePreview.deployedCommitSha, sha1);
    assert.equal(livePreview.port, 5000);
    assert.equal(livePreview.url, "http://localhost:5000");
    assert.equal(store.ports.get(5000).isAllocated, true);

    // 4. Owner verifies build history via GET /api/preview/:id/builds; non-owner blocked
    const forbiddenHist = await request(app)
      .get(`/api/preview/${preview.id}/builds`)
      .set("Authorization", `Bearer ${otherToken}`);
    assert.equal(forbiddenHist.status, 403);

    const histRes = await request(app)
      .get(`/api/preview/${preview.id}/builds`)
      .set("Authorization", `Bearer ${ownerToken}`);
    assert.equal(histRes.status, 200);
    assert.equal(histRes.body.activeBuildId, queuedBuild.id);
    assert.equal(histRes.body.builds.length, 1);
    assert.equal(histRes.body.builds[0].status, "COMPLETED");

    // 5. PR Closed webhook tears down container, image, and PortAllocation lease
    // Inject containerRemover/imageRemover spy on store deletion check via handlePRClosed default behavior
    const closedPayload = {
      repository: { owner: { login: baseProject.repoOwner }, name: baseProject.repoName },
      action: "closed",
      pull_request: { number: prNumber, head: { ref: "feat/profile", sha: sha1 } }
    };

    const whClose = await request(app)
      .post("/webhooks/github")
      .set("X-GitHub-Event", "pull_request")
      .set("X-GitHub-Delivery", "del-e2e-101-close")
      .set("X-Hub-Signature-256", signWebhook(closedPayload))
      .send(closedPayload);

    assert.equal(whClose.status, 200);
    assert.equal(store.previews.get(preview.id).status, "deleted");
    assert.equal(store.previews.get(preview.id).port, null);
    assert.equal(store.ports.get(5000).isAllocated, false);
  });

  test("Chaos Simulation: Dead worker crash leaves expired lease -> Reconciliation recovers -> Worker B finishes", async () => {
    const preview = await prisma.preview.upsert({
      where: { projectId_prNumber: { projectId: baseProject.id, prNumber: 202 } },
      update: {},
      create: { projectId: baseProject.id, prNumber: 202, status: "building" }
    });

    // Build claimed by worker-dead whose lease expired 2 minutes ago
    const crashedBuild = await prisma.build.create({
      data: {
        previewId: preview.id,
        buildNumber: 1,
        commitSha: "sha_crash_202",
        branch: "fix/crash",
        source: "WEBHOOK_SYNC",
        status: "RUNNING",
        attempt: 1,
        maxAttempts: 3,
        workerId: "worker-dead-1",
        leaseExpiresAt: new Date(Date.now() - 120_000),
        queuedAt: new Date(Date.now() - 130_000)
      }
    });
    await prisma.preview.update({
      where: { id: preview.id },
      data: { latestBuildId: crashedBuild.id, activeBuildId: crashedBuild.id }
    });

    // Startup reconciliation recovers crashed build back to QUEUED
    const recReport = await runStartupReconciliation({
      execFn: async () => ({ err: null, stdout: "" }),
      diskCleanupFn: () => 0
    });

    assert.equal(recReport.staleBuildsRecovered, 1);
    assert.equal(store.builds.get(crashedBuild.id).status, "QUEUED");
    assert.equal(store.builds.get(crashedBuild.id).attempt, 2);

    // Worker B claims attempt 2 and finishes cleanly
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "chaos-repo-"));
    tempDirs.push(tempRepo);

    let done;
    const donePromise = new Promise((r) => {
      done = r;
    });

    const workerB = createWorkerLoop({
      workerId: "worker-healthy-b",
      pollIntervalMs: 25,
      executeJob: async (job, ctx) => {
        await executeBuildJob(job, {
          ...ctx,
          cloner: async () => tempRepo,
          builder: async () => ({
            url: "http://localhost:5020",
            containerName: "preview-recovered-b1",
            port: 5020
          })
        });
        done();
      }
    });

    workerB.start();
    await donePromise;
    workerB.stop();

    assert.equal(store.builds.get(crashedBuild.id).status, "COMPLETED");
    assert.equal(store.builds.get(crashedBuild.id).attempt, 2);
    assert.equal(store.previews.get(preview.id).status, "live");
    assert.equal(store.previews.get(preview.id).url, "http://localhost:5020");
  });

  test("Chaos Simulation: Rapid 3-commit storm aborts Commit A, supersedes Commit B, activates only Commit C", async () => {
    const postCommit = (sha, deliveryId) =>
      request(app)
        .post("/webhooks/github")
        .set("X-GitHub-Event", "pull_request")
        .set("X-GitHub-Delivery", deliveryId)
        .set("X-Hub-Signature-256", signWebhook({
          repository: { owner: { login: baseProject.repoOwner }, name: baseProject.repoName },
          action: "synchronize",
          pull_request: { number: 303, head: { ref: "feat/storm", sha } }
        }))
        .send({
          repository: { owner: { login: baseProject.repoOwner }, name: baseProject.repoName },
          action: "synchronize",
          pull_request: { number: 303, head: { ref: "feat/storm", sha } }
        });

    // Commit A arrives & gets claimed by worker
    await postCommit("sha_storm_A", "del-storm-1");
    const [buildA] = Array.from(store.builds.values());
    const runningA = await prisma.build.update({
      where: { id: buildA.id },
      data: { status: "RUNNING", workerId: "worker-storm" }
    });

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "storm-a-"));
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), "storm-c-"));
    tempDirs.push(dirA, dirC);

    let buildAAborted = false;
    const buildAPromise = executeBuildJob(runningA, {
      cloner: async () => dirA,
      builder: async ({ abortSignal }) => {
        // While Commit A is building, Commit B & C arrive rapidly!
        await postCommit("sha_storm_B", "del-storm-2");
        await postCommit("sha_storm_C", "del-storm-3");

        assert.equal(abortSignal.aborted, true, "Commit A must be aborted on supersession");
        buildAAborted = true;
        const err = new Error("Aborted by newer commit");
        err.name = "AbortError";
        err.isAborted = true;
        throw err;
      }
    });

    const resA = await buildAPromise;
    assert.equal(buildAAborted, true);
    assert.equal(resA.aborted, true);

    const allBuilds = Array.from(store.builds.values()).sort((a, b) => a.buildNumber - b.buildNumber);
    assert.equal(allBuilds.length, 3);
    assert.equal(allBuilds[0].status, "SUPERSEDED"); // A
    assert.equal(allBuilds[1].status, "SUPERSEDED"); // B
    assert.equal(allBuilds[2].status, "QUEUED"); // C

    // Worker executes Commit C
    const claimedC = await prisma.build.update({
      where: { id: allBuilds[2].id },
      data: { status: "RUNNING", workerId: "worker-storm" }
    });

    const resC = await executeBuildJob(claimedC, {
      cloner: async () => dirC,
      builder: async () => ({
        url: "http://localhost:5033",
        containerName: "preview-storm-c",
        port: 5033
      })
    });

    assert.equal(resC.status, "COMPLETED");
    const preview = Array.from(store.previews.values())[0];
    assert.equal(preview.activeBuildId, claimedC.id);
    assert.equal(preview.deployedCommitSha, "sha_storm_C");
    assert.equal(preview.url, "http://localhost:5033");
  });

  test("Readiness endpoint (/health/ready), malformed JSON handler (400), and shutdownServer work safely", async () => {
    const readyRes = await request(app).get("/health/ready");
    assert.equal(readyRes.status, 200);
    assert.equal(readyRes.body.status, "ready");
    assert.equal(readyRes.body.db, "connected");

    // Simulate DB outage -> 503 not_ready
    prisma.$queryRaw = async () => {
      throw new Error("Connection refused");
    };
    const notReadyRes = await request(app).get("/health/ready");
    assert.equal(notReadyRes.status, 503);
    assert.equal(notReadyRes.body.status, "not_ready");

    // Malformed JSON payload returns clean 400 JSON without stack trace
    const badJsonRes = await request(app)
      .post("/webhooks/github")
      .set("Content-Type", "application/json")
      .send("{ broken json :::");
    assert.equal(badJsonRes.status, 400);
    assert.equal(badJsonRes.body.error, "invalid_json");

    // Graceful shutdown executes cleanly in test context
    await shutdownServer({ disconnectDb: false, force: true });
  });
});
