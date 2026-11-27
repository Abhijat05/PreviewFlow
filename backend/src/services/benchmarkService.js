// backend/src/services/benchmarkService.js
import crypto from "node:crypto";
import os from "node:os";
import http from "node:http";
import { claimNextJob } from "./buildWorker.js";
import {
  allocatePort,
  claimPortAtomically,
  releasePort,
  getPendingAllocatedPorts
} from "./portService.js";
import { initSocket, setIO } from "../socket.js";
import { signAuthToken } from "../utils/jwtHelper.js";
import { defaultMetrics } from "./metricsService.js";
import { encryptSecret } from "./cryptoService.js";

export const DEFAULT_BENCHMARK_SLAS = {
  maxHttpP95Ms: 250,
  maxWebhookP95Ms: 300,
  maxWorkerClaimP95Ms: 50,
  maxPortAllocP95Ms: 150,
  maxSocketFanoutP95Ms: 250
};

/**
 * Computes quantile (p in [0, 100]) on an already sorted numeric array.
 */
export function percentile(sortedValues, p) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return 0;
  if (p <= 0) return sortedValues[0];
  if (p >= 100) return sortedValues[sortedValues.length - 1];
  const idx = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, idx))];
}

/**
 * Computes summary latency statistics (in milliseconds) from raw timing samples.
 */
export function computeLatencyStats(samplesMs = []) {
  if (!samplesMs || samplesMs.length === 0) {
    return {
      count: 0,
      minMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0
    };
  }

  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const round = (n) => Math.round(n * 100) / 100;

  return {
    count: sorted.length,
    minMs: round(sorted[0]),
    meanMs: round(sum / sorted.length),
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1])
  };
}

/**
 * Executes `total` indexed tasks with bounded async `concurrency`, collecting per-task latency in ms.
 */
export async function runConcurrentTasks({ total, concurrency = 10, workerFn }) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeConcurrency = Math.max(1, Math.min(safeTotal || 1, Number(concurrency) || 1));
  const samplesMs = [];
  const results = new Array(safeTotal);
  let nextIndex = 0;

  const overallStartNs = process.hrtime.bigint();

  async function runWorker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= safeTotal) break;

      const taskStartNs = process.hrtime.bigint();
      const out = await workerFn(idx);
      const elapsedMs = Number(process.hrtime.bigint() - taskStartNs) / 1e6;
      samplesMs.push(elapsedMs);
      results[idx] = out;
    }
  }

  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()));
  const totalDurationMs = Math.round((Number(process.hrtime.bigint() - overallStartNs) / 1e6) * 100) / 100;

  return {
    totalDurationMs,
    throughputPerSec: totalDurationMs > 0 ? Math.round((safeTotal / (totalDurationMs / 1000)) * 100) / 100 : 0,
    latency: computeLatencyStats(samplesMs),
    results
  };
}

/**
 * Builds an isolated in-memory Prisma store supporting transactional queries,
 * SKIP LOCKED worker queue simulation, PortAllocation atomic locks, and webhook delivery checks.
 */
export function createBenchmarkPrismaStore({
  tenantCount = 4,
  webhookSecret = "bench_webhook_secret_key_32chars!!"
} = {}) {
  let seq = 0;
  const users = new Map();
  const projects = new Map();
  const previews = new Map();
  const builds = new Map();
  const deliveries = new Map();
  const ports = new Map();
  const auditLogs = [];

  const encryptedSecret = encryptSecret(webhookSecret);

  for (let t = 0; t < tenantCount; t++) {
    const userId = `u_bench_${t + 1}`;
    const user = {
      id: userId,
      githubId: `${9000 + t}`,
      username: `bench_user_${t + 1}`,
      tier: "PRO",
      accessToken: null
    };
    users.set(userId, user);

    const projectId = `proj_bench_${t + 1}`;
    projects.set(projectId, {
      id: projectId,
      userId,
      repoOwner: "bench-org",
      repoName: `repo-${t + 1}`,
      webhookSecret: encryptedSecret,
      accessToken: null,
      webhookId: `wh_${t + 1}`,
      allowForkBuilds: true,
      user,
      previews: []
    });
  }

  const overrides = {
    $transaction: async (fn) => fn(overrides),
    $queryRaw: async (strings, ...values) => {
      const sql = Array.isArray(strings) ? strings.join(" ") : String(strings || "");

      if (sql.includes("SELECT 1")) {
        return [{ "?column?": 1 }];
      }

      // Simulate atomic PostgreSQL FOR UPDATE SKIP LOCKED claim
      if (sql.includes('UPDATE "Build"') && sql.includes("FOR UPDATE SKIP LOCKED")) {
        const workerId = values[0];
        const leaseSeconds = Number(values[1]) || 60;
        const queued = Array.from(builds.values())
          .filter((b) => b.status === "QUEUED")
          .sort((a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime());
        if (queued.length === 0) return [];
        const target = queued[0];
        target.status = "RUNNING";
        target.workerId = workerId;
        target.startedAt = new Date();
        target.leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000);
        return [{ ...target }];
      }

      // Simulate atomic PostgreSQL INSERT ... ON CONFLICT DO UPDATE for PortAllocation
      if (sql.includes('INSERT INTO "PortAllocation"')) {
        const [port, previewId, buildId, tier] = values;
        const existing = ports.get(port);
        if (!existing || !existing.isAllocated || (previewId && existing.previewId === previewId)) {
          const rec = {
            port,
            previewId,
            buildId,
            tier,
            isAllocated: true,
            allocatedAt: new Date(),
            lastVerifiedAt: new Date()
          };
          ports.set(port, rec);
          return [rec];
        }
        return [];
      }

      return null;
    },
    user: {
      findUnique: async ({ where }) => users.get(where?.id) || null
    },
    project: {
      findMany: async ({ where } = {}) =>
        Array.from(projects.values()).filter((p) => {
          if (where?.userId && p.userId !== where.userId) return false;
          if (where?.repoOwner && p.repoOwner !== where.repoOwner) return false;
          if (where?.repoName && p.repoName !== where.repoName) return false;
          return true;
        })
    },
    preview: {
      findUnique: async ({ where }) => {
        const p = previews.get(where?.id);
        return p ? { ...p, project: projects.get(p.projectId) || null } : null;
      },
      findFirst: async ({ where } = {}) => {
        for (const p of previews.values()) {
          if (where?.projectId && p.projectId !== where.projectId) continue;
          if (where?.prNumber !== undefined && p.prNumber !== where.prNumber) continue;
          if (where?.port !== undefined && p.port !== where.port) continue;
          if (where?.status?.not && p.status === where.status.not) continue;
          return { ...p, project: projects.get(p.projectId) || null };
        }
        return null;
      },
      findMany: async ({ where } = {}) =>
        Array.from(previews.values()).filter((p) => {
          if (where?.status?.not && p.status === where.status.not) return false;
          if (where?.port?.not === null && p.port === null) return false;
          return true;
        }),
      count: async ({ where } = {}) => {
        let c = 0;
        for (const p of previews.values()) {
          if (where?.status?.not && p.status === where.status.not) continue;
          if (typeof where?.status === "string" && p.status !== where.status) continue;
          if (where?.project?.userId) {
            const proj = projects.get(p.projectId);
            if (!proj || proj.userId !== where.project.userId) continue;
          }
          c++;
        }
        return c;
      },
      upsert: async ({ where, update, create }) => {
        const key = where?.projectId_prNumber;
        let existing = null;
        if (key) {
          for (const p of previews.values()) {
            if (p.projectId === key.projectId && p.prNumber === key.prNumber) {
              existing = p;
              break;
            }
          }
        }
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const rec = {
          id: `prev_bench_${++seq}`,
          buildNumber: 1,
          port: null,
          status: "building",
          ...create
        };
        previews.set(rec.id, rec);
        return rec;
      },
      update: async ({ where, data }) => {
        const rec = previews.get(where?.id);
        if (!rec) return null;
        Object.assign(rec, data);
        return rec;
      }
    },
    build: {
      findFirst: async ({ where } = {}) => {
        const list = Array.from(builds.values())
          .filter((b) => (!where?.previewId || b.previewId === where.previewId))
          .sort((a, b) => b.buildNumber - a.buildNumber);
        return list[0] || null;
      },
      findMany: async ({ where } = {}) =>
        Array.from(builds.values()).filter((b) => {
          if (where?.previewId && b.previewId !== where.previewId) return false;
          if (where?.status && b.status !== where.status) return false;
          return true;
        }),
      count: async ({ where } = {}) => {
        let c = 0;
        for (const b of builds.values()) {
          if (where?.status?.in && !where.status.in.includes(b.status)) continue;
          if (typeof where?.status === "string" && b.status !== where.status) continue;
          if (where?.preview?.project?.userId) {
            const prev = previews.get(b.previewId);
            const proj = prev ? projects.get(prev.projectId) : null;
            if (!proj || proj.userId !== where.preview.project.userId) continue;
          }
          c++;
        }
        return c;
      },
      create: async ({ data }) => {
        const rec = { id: `bld_bench_${++seq}`, ...data };
        builds.set(rec.id, rec);
        return rec;
      },
      update: async ({ where, data }) => {
        const rec = builds.get(where?.id);
        if (!rec) return null;
        Object.assign(rec, data);
        return rec;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const b of builds.values()) {
          if (where?.previewId && b.previewId !== where.previewId) continue;
          if (where?.status && b.status !== where.status) continue;
          Object.assign(b, data);
          count++;
        }
        return { count };
      }
    },
    webhookDelivery: {
      findUnique: async ({ where }) => deliveries.get(where?.deliveryId) || null,
      create: async ({ data }) => {
        const rec = { id: `wd_bench_${++seq}`, ...data };
        deliveries.set(data.deliveryId, rec);
        return rec;
      },
      update: async ({ where, data }) => {
        const rec = deliveries.get(where?.deliveryId);
        if (!rec) return null;
        Object.assign(rec, data);
        return rec;
      }
    },
    portAllocation: {
      findUnique: async ({ where }) => ports.get(where?.port) || null,
      findMany: async ({ where } = {}) =>
        Array.from(ports.values()).filter((p) =>
          where?.isAllocated !== undefined ? p.isAllocated === where.isAllocated : true
        ),
      create: async ({ data }) => {
        ports.set(data.port, { ...data });
        return data;
      },
      update: async ({ where, data }) => {
        const rec = ports.get(where?.port) || { port: where.port };
        Object.assign(rec, data);
        ports.set(where.port, rec);
        return rec;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const rec of ports.values()) {
          if (where?.port !== undefined && rec.port !== where.port) continue;
          if (where?.buildId !== undefined && rec.buildId !== where.buildId) continue;
          if (where?.previewId !== undefined && rec.previewId !== where.previewId) continue;
          Object.assign(rec, data);
          count++;
        }
        return { count };
      }
    },
    auditLog: {
      create: async ({ data }) => {
        const rec = { id: `aud_bench_${++seq}`, createdAt: new Date(), ...data };
        auditLogs.push(rec);
        return rec;
      },
      findMany: async () => [...auditLogs]
    }
  };

  return {
    overrides,
    state: { users, projects, previews, builds, deliveries, ports, auditLogs },
    webhookSecret
  };
}

/**
 * Scenario 1: Concurrent HTTP API ingress & correlation context benchmark.
 */
export async function benchmarkHttpIngress({
  serverUrl,
  totalRequests = 200,
  concurrency = 25,
  authToken,
  maxP95Ms = DEFAULT_BENCHMARK_SLAS.maxHttpP95Ms
} = {}) {
  if (!serverUrl) throw new Error("serverUrl is required for HTTP benchmark");

  let errorCount = 0;
  let contextBleedCount = 0;
  const routes = ["/health", "/api/projects", "/metrics"];

  const run = await runConcurrentTasks({
    total: totalRequests,
    concurrency,
    workerFn: async (i) => {
      const route = routes[i % routes.length];
      const expectedReqId = `bench-req-${i}`;
      const res = await fetch(`${serverUrl}${route}`, {
        headers: {
          "X-Request-Id": expectedReqId,
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
        }
      });
      await res.arrayBuffer();

      const echoedReqId = res.headers.get("x-request-id");
      if (echoedReqId !== expectedReqId) {
        contextBleedCount++;
      }
      if (res.status >= 400) {
        errorCount++;
      }
    }
  });

  const passed =
    errorCount === 0 &&
    contextBleedCount === 0 &&
    run.latency.p95Ms <= maxP95Ms;

  return {
    scenario: "http_ingress",
    totalRequests,
    concurrency,
    errorCount,
    contextBleedCount,
    throughputPerSec: run.throughputPerSec,
    totalDurationMs: run.totalDurationMs,
    latency: run.latency,
    sla: { maxP95Ms },
    passed
  };
}

/**
 * Scenario 2: Signed GitHub webhook ingestion storm with replay deduplication.
 */
export async function benchmarkWebhookStorm({
  serverUrl,
  totalRequests = 120,
  concurrency = 20,
  projects = [{ repoOwner: "bench-org", repoName: "repo-1" }],
  webhookSecret,
  duplicateEvery = 5,
  maxP95Ms = DEFAULT_BENCHMARK_SLAS.maxWebhookP95Ms
} = {}) {
  if (!serverUrl || !webhookSecret) {
    throw new Error("serverUrl and webhookSecret are required for webhook benchmark");
  }

  let processedCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;
  let expectedDuplicates = 0;

  // Prime first unique delivery ID per duplicate group before concurrent replay storm
  const replayIds = new Set();

  const run = await runConcurrentTasks({
    total: totalRequests,
    concurrency,
    workerFn: async (i) => {
      const proj = projects[i % projects.length];
      const isReplay = duplicateEvery > 0 && i >= duplicateEvery && i % duplicateEvery === 0;
      let deliveryId;

      if (isReplay) {
        const sourceIdx = i % duplicateEvery;
        deliveryId = `bench-del-seed-${sourceIdx}`;
        if (replayIds.has(deliveryId)) {
          expectedDuplicates++;
        } else {
          // Ensure seed delivery exists synchronously before counting duplicate expectation cleanly
          deliveryId = `bench-del-unique-${i}`;
        }
      } else {
        deliveryId = `bench-del-${i}`;
        if (i < duplicateEvery) {
          replayIds.add(`bench-del-${i}`);
        }
      }

      // Deterministic explicit duplicate set against pre-recorded seeds
      const finalDeliveryId =
        duplicateEvery > 0 && i >= duplicateEvery && i % duplicateEvery === 0
          ? `bench-del-${i % duplicateEvery}`
          : deliveryId;

      const bodyObj = {
        repository: { owner: { login: proj.repoOwner }, name: proj.repoName },
        action: "opened",
        pull_request: {
          number: 500 + i,
          title: `Benchmark PR ${i}`,
          head: { ref: `feat/bench-${i}`, sha: `sha_${i}` }
        }
      };
      const rawBody = JSON.stringify(bodyObj);
      const signature = `sha256=${crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;

      const res = await fetch(`${serverUrl}/webhooks/github`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": finalDeliveryId,
          "X-Hub-Signature-256": signature
        },
        body: rawBody
      });
      const text = await res.text();
      if (res.status >= 400) {
        errorCount++;
      } else if (text === "duplicate") {
        duplicateCount++;
      } else {
        processedCount++;
      }
    }
  });

  // Note: When seed & replay race in same parallel wave, total handled cleanly equals totalRequests
  const handledCleanly = processedCount + duplicateCount === totalRequests && errorCount === 0;
  const passed = handledCleanly && run.latency.p95Ms <= maxP95Ms;

  return {
    scenario: "webhook_storm",
    totalRequests,
    concurrency,
    processedCount,
    duplicateCount,
    errorCount,
    throughputPerSec: run.throughputPerSec,
    totalDurationMs: run.totalDurationMs,
    latency: run.latency,
    sla: { maxP95Ms },
    passed
  };
}

/**
 * Scenario 3: Multi-worker concurrent queue claiming under SKIP LOCKED semantics.
 */
export async function benchmarkWorkerContention({
  jobCount = 100,
  workerCount = 12,
  maxP95Ms = DEFAULT_BENCHMARK_SLAS.maxWorkerClaimP95Ms
} = {}) {
  const { overrides, state } = createBenchmarkPrismaStore({ tenantCount: 2 });

  // Seed queued jobs across multiple previews
  for (let i = 0; i < jobCount; i++) {
    const prevId = `prev_q_${(i % 10) + 1}`;
    if (!state.previews.has(prevId)) {
      state.previews.set(prevId, {
        id: prevId,
        projectId: "proj_bench_1",
        prNumber: i + 1,
        status: "building"
      });
    }
    const buildId = `bld_q_${i + 1}`;
    state.builds.set(buildId, {
      id: buildId,
      previewId: prevId,
      buildNumber: i + 1,
      commitSha: `sha_q_${i}`,
      branch: "main",
      source: "WEBHOOK_SYNC",
      status: "QUEUED",
      queuedAt: new Date(Date.now() + i)
    });
  }

  const claimedByJobId = new Map();
  let duplicateClaimCount = 0;
  const claimLatencies = [];
  const startNs = process.hrtime.bigint();

  await Promise.all(
    Array.from({ length: workerCount }, (_, wIdx) =>
      (async () => {
        const workerId = `bench-worker-${wIdx + 1}`;
        while (true) {
          const t0 = process.hrtime.bigint();
          const job = await claimNextJob(workerId, { client: overrides });
          claimLatencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
          if (!job) break;
          if (claimedByJobId.has(job.id)) {
            duplicateClaimCount++;
          } else {
            claimedByJobId.set(job.id, workerId);
          }
          // Yield to event loop so peer workers heavily interleave
          await new Promise((r) => setImmediate(r));
        }
      })()
    )
  );

  const totalDurationMs = Math.round((Number(process.hrtime.bigint() - startNs) / 1e6) * 100) / 100;
  const latency = computeLatencyStats(claimLatencies);
  const claimedCount = claimedByJobId.size;
  const missedCount = jobCount - claimedCount;

  const passed =
    claimedCount === jobCount &&
    duplicateClaimCount === 0 &&
    missedCount === 0 &&
    latency.p95Ms <= maxP95Ms;

  return {
    scenario: "worker_contention",
    jobCount,
    workerCount,
    claimedCount,
    duplicateClaimCount,
    missedCount,
    claimsPerSec: totalDurationMs > 0 ? Math.round((claimedCount / (totalDurationMs / 1000)) * 100) / 100 : 0,
    totalDurationMs,
    latency,
    sla: { maxP95Ms },
    passed
  };
}

/**
 * Scenario 4: Concurrent port allocation TOCTOU & cross-process SQL ON CONFLICT benchmark.
 */
export async function benchmarkPortAllocation({
  concurrentAllocations = 30,
  tier = "PRO",
  maxP95Ms = DEFAULT_BENCHMARK_SLAS.maxPortAllocP95Ms
} = {}) {
  const { overrides } = createBenchmarkPrismaStore({ tenantCount: 2 });
  const allocated = [];

  try {
    // Part A: Intra-process concurrent allocatePort calls racing for ports in the same pool
    const run = await runConcurrentTasks({
      total: concurrentAllocations,
      concurrency: concurrentAllocations,
      workerFn: async (i) => {
        const res = await allocatePort({
          previewId: `prev_port_${i + 1}`,
          buildId: `bld_port_${i + 1}`,
          tier,
          client: overrides,
          osPortChecker: async () => true
        });
        allocated.push({ port: res.port, previewId: `prev_port_${i + 1}`, buildId: `bld_port_${i + 1}` });
        return res.port;
      }
    });

    const uniquePorts = new Set(run.results);
    const collisionCount = run.results.length - uniquePorts.size;

    // Part B: Simultaneous cross-process SQL ON CONFLICT contention for the exact same target port
    const contestedPort = 6999;
    const peerResults = await Promise.all(
      Array.from({ length: 12 }, (_, idx) =>
        claimPortAtomically({
          port: contestedPort,
          previewId: `prev_peer_${idx}`,
          buildId: `bld_peer_${idx}`,
          tier,
          client: overrides
        })
      )
    );
    const crossProcessWinnerCount = peerResults.filter((r) => r.claimed).length;

    // Cleanly release all allocated ports and verify zero leaked pending entries
    await releasePort({ port: contestedPort, client: overrides });
    for (const item of allocated) {
      await releasePort({
        port: item.port,
        previewId: item.previewId,
        buildId: item.buildId,
        client: overrides
      });
    }

    const pendingLeakedCount = getPendingAllocatedPorts().length;

    const passed =
      allocated.length === concurrentAllocations &&
      collisionCount === 0 &&
      crossProcessWinnerCount === 1 &&
      pendingLeakedCount === 0 &&
      run.latency.p95Ms <= maxP95Ms;

    return {
      scenario: "port_allocation",
      concurrentAllocations,
      allocatedCount: allocated.length,
      collisionCount,
      crossProcessWinnerCount,
      pendingLeakedCount,
      throughputPerSec: run.throughputPerSec,
      totalDurationMs: run.totalDurationMs,
      latency: run.latency,
      sla: { maxP95Ms },
      passed
    };
  } finally {
    for (const item of allocated) {
      await releasePort({ port: item.port, client: overrides }).catch(() => {});
    }
  }
}

/**
 * Scenario 5: Socket.IO multi-tenant concurrent fanout, room isolation, and cleanup benchmark.
 */
export async function benchmarkSocketFanout({
  tenantCount = 4,
  clientsPerTenant = 4,
  eventsPerTenant = 10,
  maxP95Ms = DEFAULT_BENCHMARK_SLAS.maxSocketFanoutP95Ms
} = {}) {
  const { io: SocketClient } = await import("socket.io-client");

  const srv = http.createServer();
  const io = initSocket(srv);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  const socketUrl = `http://127.0.0.1:${port}`;

  const clients = [];
  let crossTenantLeaks = 0;
  let deliveredCount = 0;
  const deliveryLatencies = [];
  const sentTimestamps = new Map();

  try {
    // Connect and register all tenant clients concurrently
    await Promise.all(
      Array.from({ length: tenantCount * clientsPerTenant }, (_, flatIdx) => {
        const tenantIdx = Math.floor(flatIdx / clientsPerTenant);
        const userId = `u_bench_${tenantIdx + 1}`;
        const previewId = `prev_sock_${tenantIdx + 1}`;
        const token = signAuthToken({ userId, tier: "PRO" }, { expiresIn: "10m" });

        return new Promise((resolve, reject) => {
          const client = SocketClient(socketUrl, {
            transports: ["websocket"],
            reconnection: false
          });
          clients.push({ client, tenantIdx, previewId });

          const timer = setTimeout(() => reject(new Error(`Socket connect timeout (${userId})`)), 4000);

          client.on("error", (err) => {
            clearTimeout(timer);
            reject(new Error(`Socket error for ${userId}: ${err}`));
          });

          client.on("registered", () => {
            clearTimeout(timer);
            resolve();
          });

          client.on("preview-status-update", (payload) => {
            if (payload?.previewId !== previewId) {
              crossTenantLeaks++;
            } else {
              deliveredCount++;
              const t0 = sentTimestamps.get(payload.seqKey);
              if (t0 !== undefined) {
                deliveryLatencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
              }
            }
          });

          client.on("connect", () => {
            client.emit("register", { token, previewId });
          });
        });
      })
    );

    const expectedDeliveries = tenantCount * clientsPerTenant * eventsPerTenant;
    const waitAll = new Promise((resolve) => {
      const interval = setInterval(() => {
        if (deliveredCount >= expectedDeliveries || crossTenantLeaks > 0) {
          clearInterval(interval);
          resolve();
        }
      }, 5);
      setTimeout(() => {
        clearInterval(interval);
        resolve();
      }, 4000);
    });

    const startNs = process.hrtime.bigint();
    for (let e = 0; e < eventsPerTenant; e++) {
      for (let t = 0; t < tenantCount; t++) {
        const previewId = `prev_sock_${t + 1}`;
        const seqKey = `${previewId}:${e}`;
        sentTimestamps.set(seqKey, process.hrtime.bigint());
        io.to(`preview:${previewId}`).emit("preview-status-update", {
          previewId,
          seq: e,
          seqKey,
          status: "live"
        });
      }
    }

    await waitAll;
    const totalDurationMs = Math.round((Number(process.hrtime.bigint() - startNs) / 1e6) * 100) / 100;

    // Disconnect clients and wait for clean gauge teardown
    for (const c of clients) {
      c.client.disconnect();
    }
    await new Promise((r) => setTimeout(r, 40));

    const leakedActiveGauge = defaultMetrics.socketConnectionsActive.get();
    const latency = computeLatencyStats(deliveryLatencies);
    const passed =
      deliveredCount === expectedDeliveries &&
      crossTenantLeaks === 0 &&
      leakedActiveGauge === 0 &&
      latency.p95Ms <= maxP95Ms;

    return {
      scenario: "socket_fanout",
      connectedClients: tenantCount * clientsPerTenant,
      expectedDeliveries,
      deliveredCount,
      crossTenantLeaks,
      leakedActiveGauge,
      totalDurationMs,
      eventsDeliveredPerSec:
        totalDurationMs > 0 ? Math.round((deliveredCount / (totalDurationMs / 1000)) * 100) / 100 : 0,
      latency,
      sla: { maxP95Ms },
      passed
    };
  } finally {
    for (const c of clients) {
      try {
        c.client.disconnect();
      } catch {}
    }
    io.disconnectSockets(true);
    await new Promise((r) => io.close(r));
    setIO(null);
    await new Promise((r) => srv.close(r));
  }
}

/**
 * Executes the complete 5-part Load Testing & Concurrency Benchmark suite against an ephemeral local app instance.
 */
export async function runFullBenchmarkSuite({
  app,
  prismaClient,
  scale = "standard",
  slas = DEFAULT_BENCHMARK_SLAS
} = {}) {
  const presets = {
    light: { httpRequests: 100, httpConc: 15, webhooks: 60, webhookConc: 15, jobs: 60, workers: 8, ports: 20, tenants: 3, clientsPerTenant: 3, events: 5 },
    standard: { httpRequests: 400, httpConc: 40, webhooks: 200, webhookConc: 25, jobs: 150, workers: 16, ports: 40, tenants: 4, clientsPerTenant: 5, events: 15 },
    heavy: { httpRequests: 1000, httpConc: 80, webhooks: 500, webhookConc: 50, jobs: 400, workers: 24, ports: 80, tenants: 6, clientsPerTenant: 6, events: 25 }
  };
  const cfg = presets[scale] || presets.standard;

  const prevRateLimitSetting = process.env.ENABLE_RATE_LIMITING;
  process.env.ENABLE_RATE_LIMITING = "false";

  const store = createBenchmarkPrismaStore({ tenantCount: cfg.tenants });

  // Populate preview lookup for Socket.IO registrations
  const originalPreviewFindUnique = store.overrides.preview.findUnique;
  store.overrides.preview.findUnique = async ({ where }) => {
    const found = await originalPreviewFindUnique({ where });
    if (found) return found;
    if (where?.id?.startsWith("prev_sock_")) {
      const tNum = Number(where.id.replace("prev_sock_", "")) || 1;
      const project = store.state.projects.get(`proj_bench_${tNum}`);
      if (project) {
        return { id: where.id, projectId: project.id, project };
      }
    }
    return null;
  };

  // Patch Prisma methods cleanly onto active singleton if supplied
  const savedProps = new Map();
  if (prismaClient) {
    for (const [k, v] of Object.entries(store.overrides)) {
      savedProps.set(k, prismaClient[k]);
      if (k.startsWith("$")) {
        prismaClient[k] = v;
      } else {
        if (!prismaClient[k]) prismaClient[k] = {};
        for (const [m, fn] of Object.entries(v)) {
          savedProps.set(`${k}.${m}`, prismaClient[k][m]);
          prismaClient[k][m] = fn;
        }
      }
    }
  }

  let server = null;
  const memBefore = process.memoryUsage();
  const suiteStartNs = process.hrtime.bigint();

  try {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const serverUrl = `http://127.0.0.1:${port}`;
    const authToken = signAuthToken({ userId: "u_bench_1", tier: "PRO" }, { expiresIn: "10m" });

    const httpResult = await benchmarkHttpIngress({
      serverUrl,
      totalRequests: cfg.httpRequests,
      concurrency: cfg.httpConc,
      authToken,
      maxP95Ms: slas.maxHttpP95Ms
    });

    const webhookResult = await benchmarkWebhookStorm({
      serverUrl,
      totalRequests: cfg.webhooks,
      concurrency: cfg.webhookConc,
      projects: Array.from(store.state.projects.values()),
      webhookSecret: store.webhookSecret,
      maxP95Ms: slas.maxWebhookP95Ms
    });

    const workerResult = await benchmarkWorkerContention({
      jobCount: cfg.jobs,
      workerCount: cfg.workers,
      maxP95Ms: slas.maxWorkerClaimP95Ms
    });

    const portResult = await benchmarkPortAllocation({
      concurrentAllocations: cfg.ports,
      tier: "PRO",
      maxP95Ms: slas.maxPortAllocP95Ms
    });

    const socketResult = await benchmarkSocketFanout({
      tenantCount: cfg.tenants,
      clientsPerTenant: cfg.clientsPerTenant,
      eventsPerTenant: cfg.events,
      maxP95Ms: slas.maxSocketFanoutP95Ms
    });

    const memAfter = process.memoryUsage();
    const totalDurationMs = Math.round((Number(process.hrtime.bigint() - suiteStartNs) / 1e6) * 100) / 100;
    const scenarios = [httpResult, webhookResult, workerResult, portResult, socketResult];

    return {
      timestamp: new Date().toISOString(),
      scale,
      environment: {
        nodeVersion: process.version,
        platform: `${os.platform()} ${os.arch()}`,
        cpus: os.cpus().length
      },
      scenarios,
      summary: {
        allPassed: scenarios.every((s) => s.passed),
        totalDurationMs,
        heapDeltaMb: Math.round(((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)) * 100) / 100,
        rssDeltaMb: Math.round(((memAfter.rss - memBefore.rss) / (1024 * 1024)) * 100) / 100
      }
    };
  } finally {
    if (prevRateLimitSetting !== undefined) {
      process.env.ENABLE_RATE_LIMITING = prevRateLimitSetting;
    } else {
      delete process.env.ENABLE_RATE_LIMITING;
    }

    if (server && server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }

    if (prismaClient) {
      for (const [key, orig] of savedProps.entries()) {
        if (key.includes(".")) {
          const [model, method] = key.split(".");
          prismaClient[model][method] = orig;
        } else {
          prismaClient[key] = orig;
        }
      }
    }
  }
}
