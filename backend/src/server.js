import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import crypto from "crypto";
import cors from "cors";
import passport from "./auth.js";
import { signAuthToken, decodeAuthToken } from "./utils/jwtHelper.js";
import bodyParser from "body-parser";
import { prisma } from "./db.js";
import { initSocket } from "./socket.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { requestContextMiddleware } from "./middleware/requestContext.js";
import {
  authRateLimiter,
  webhookRateLimiter,
  rebuildRateLimiter,
  apiRateLimiter
} from "./middleware/rateLimiter.js";
import { validateProductionConfig } from "./utils/configValidation.js";
import { logger, extendContext } from "./utils/logger.js";
import { recordHttpAudit } from "./services/auditService.js";
import { defaultAlertManager } from "./services/alertService.js";

import githubRepos from "./routes/githubRepos.js";
import connectRepo from "./routes/connectRepo.js";
import createWebhook from "./routes/createWebhook.js";
import githubWebhook from "./routes/githubWebhook.js";
import previewActions from "./routes/previewActions.js";
import projectDashboard from "./routes/projectDashboard.js";
import logsRoute from "./routes/logs.js";
import userRoute from "./routes/user.js";
import accountTier from "./routes/accountTier.js";
import metricsRoutes from "./routes/metrics.js";
import auditLogsRoutes from "./routes/auditLogs.js";
import { startStatsWorker } from "./services/statsWorker.js";
import previewMetricsRoutes from "./routes/previewMetrics.js";
import devSim from "./routes/devSimulate.js"; // Development simulation routes
import { startPeriodicDiskCleanup } from "./services/repoService.js";
import { startPeriodicDockerCleanup } from "./services/dockerService.js";
import { createWorkerLoop } from "./services/buildWorker.js";
import { executeBuildJob } from "./services/buildOrchestrator.js";
import { runStartupReconciliation } from "./services/reconciliationService.js";

const app = express();
app.disable("x-powered-by");
app.use(securityHeaders);
const server = http.createServer(app);

app.use(requestContextMiddleware);

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const allowedOrigins = Array.from(new Set([FRONTEND_URL, "http://localhost:5173"]));

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like curl, mobile, or same-origin)
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
  })
);

// Raw-body JSON parser for GitHub webhook HMAC verification with explicit payload size limit
app.use(
  bodyParser.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

app.use(passport.initialize());

// Single-use short-lived OAuth exchange code store (60s TTL)
const pendingAuthCodes = new Map();
const AUTH_CODE_TTL_MS = 60_000;

export function issueAuthExchangeCode(token) {
  if (pendingAuthCodes.size > 10000) {
    // Evict expired entries first under high load
    const now = Date.now();
    for (const [k, v] of pendingAuthCodes.entries()) {
      if (v.expiresAt < now) pendingAuthCodes.delete(k);
    }
  }
  const code = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + AUTH_CODE_TTL_MS;
  pendingAuthCodes.set(code, { token, expiresAt });
  const t = setTimeout(() => pendingAuthCodes.delete(code), AUTH_CODE_TTL_MS);
  if (t.unref) t.unref();
  return code;
}

// Health check endpoint for uptime monitoring & container orchestrators
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    mode: PREVIEWFLOW_MODE,
    timestamp: new Date().toISOString()
  });
});

// Readiness check verifying PostgreSQL connectivity, worker state, and alert health
app.get("/health/ready", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const alertState = defaultAlertManager.getAlertState();
    return res.json({
      status: "ready",
      db: "connected",
      mode: PREVIEWFLOW_MODE,
      workerRunning: Boolean(buildWorkerInstance?.isRunning?.()),
      alerts: alertState.status,
      activeAlertsCount: alertState.activeAlerts.length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return res.status(503).json({
      status: "not_ready",
      db: "disconnected",
      error: process.env.NODE_ENV === "production" ? "database_unavailable" : err.message
    });
  }
});

// Prometheus telemetry metrics endpoint (mounted outside API rate limiter)
app.use("/", metricsRoutes);

app.get("/auth/github", authRateLimiter, passport.authenticate("github"));

app.get(
  "/auth/github/callback",
  authRateLimiter,
  passport.authenticate("github", { session: false, failureRedirect: "/" }),
  async (req, res) => {
    try {
      const user = req.user;

      const freshUser = await prisma.user.findUnique({
        where: { id: user.id },
      });

      if (!freshUser) {
        return res.status(401).send("user_not_found");
      }

      extendContext({ userId: freshUser.id });

      // Never embed GitHub OAuth accessToken inside client-held JWT
      const token = signAuthToken(
        {
          userId: freshUser.id,
          tier: freshUser.tier,
        },
        { expiresIn: "7d" }
      );

      await recordHttpAudit(req, {
        actorUserId: freshUser.id,
        action: "AUTH_LOGIN",
        resourceType: "User",
        resourceId: freshUser.id,
        status: "SUCCESS",
        metadata: { tier: freshUser.tier }
      });

      // Redirect with single-use short-lived code instead of raw JWT in URL
      const code = issueAuthExchangeCode(token);
      return res.redirect(`${FRONTEND_URL}/auth/success?code=${code}`);
    } catch (err) {
      logger.error("OAuth callback error", { err });
      return res.status(500).send("auth_failed");
    }
  }
);

app.post("/auth/exchange", authRateLimiter, async (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "missing_code" });
  }

  const entry = pendingAuthCodes.get(code);
  pendingAuthCodes.delete(code);

  if (!entry || entry.expiresAt < Date.now()) {
    await recordHttpAudit(req, {
      action: "AUTH_EXCHANGE",
      resourceType: "AuthSession",
      status: "DENIED",
      metadata: { reason: "invalid_or_expired_code" }
    });
    return res.status(401).json({ error: "invalid_or_expired_code" });
  }

  const decoded = decodeAuthToken(entry.token);
  await recordHttpAudit(req, {
    actorUserId: decoded?.userId || null,
    action: "AUTH_EXCHANGE",
    resourceType: "User",
    resourceId: decoded?.userId || null,
    status: "SUCCESS"
  });

  return res.json({ token: entry.token });
});

app.use("/api/preview/:id/rebuild", rebuildRateLimiter);
app.use("/api", apiRateLimiter);
app.use("/api", githubRepos);
app.use("/api", connectRepo);
app.use("/api", createWebhook);
app.use("/api", previewActions);
app.use("/api", projectDashboard);
app.use("/api", logsRoute);
app.use("/api", auditLogsRoutes);
app.use("/api/user", userRoute);
app.use("/api/previews", previewMetricsRoutes);
app.use("/api/account", accountTier);

app.use("/webhooks/github", webhookRateLimiter);
app.use("/", githubWebhook);

// Development simulation routes - strictly disabled in production
if (process.env.NODE_ENV !== "production") {
  app.use("/", devSim);
}

// Global JSON error handler preventing stack trace leakage
app.use((err, req, res, _next) => {
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ error: "invalid_json" });
  }
  logger.error("Unhandled Express error", { err, statusCode: err?.status || 500 });
  return res.status(err?.status || 500).json({ error: "internal_error" });
});

const isTest = process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
const PREVIEWFLOW_MODE = (process.env.PREVIEWFLOW_MODE || "all").toLowerCase();

let buildWorkerInstance = null;
let statsWorkerTimer = null;
let diskCleanupTimer = null;
let dockerCleanupTimer = null;
let isShuttingDown = false;

export function getBuildWorkerInstance() {
  return buildWorkerInstance;
}

export function setBuildWorkerInstance(instance) {
  buildWorkerInstance = instance;
}

/**
 * Gracefully stops worker loops, background timers, HTTP server, and database connections.
 */
export async function shutdownServer({ disconnectDb = true, force = false } = {}) {
  if (isShuttingDown && !force) return;
  isShuttingDown = true;

  if (buildWorkerInstance?.stop) {
    buildWorkerInstance.stop();
  }
  if (statsWorkerTimer) {
    clearInterval(statsWorkerTimer);
    statsWorkerTimer = null;
  }
  if (diskCleanupTimer) {
    clearInterval(diskCleanupTimer);
    diskCleanupTimer = null;
  }
  if (dockerCleanupTimer) {
    clearInterval(dockerCleanupTimer);
    dockerCleanupTimer = null;
  }

  if (server.listening) {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  if (disconnectDb && typeof prisma?.$disconnect === "function") {
    await prisma.$disconnect().catch(() => {});
  }
}

if (!isTest) {
  validateProductionConfig();
  const shouldRunApi = PREVIEWFLOW_MODE === "all" || PREVIEWFLOW_MODE === "api";
  const shouldRunWorker = PREVIEWFLOW_MODE === "all" || PREVIEWFLOW_MODE === "worker";

  if (shouldRunApi) {
    initSocket(server);
    statsWorkerTimer = startStatsWorker();
    diskCleanupTimer = startPeriodicDiskCleanup();

    const PORT = process.env.PORT || 4000;
    server.listen(PORT, () => {
      logger.info("Backend server listening", { mode: PREVIEWFLOW_MODE, port: Number(PORT) });
    });
  }

  if (shouldRunWorker) {
    dockerCleanupTimer = startPeriodicDockerCleanup();
    buildWorkerInstance = createWorkerLoop({
      pollIntervalMs: Number(process.env.BUILD_POLL_INTERVAL_MS) || 2000,
      leaseDurationSeconds: Number(process.env.BUILD_LEASE_SECONDS) || 60,
      executeJob: async (job, context) => {
        await executeBuildJob(job, context);
      }
    });

    runStartupReconciliation()
      .then((recReport) => {
        if (recReport?.unmigrated) {
          logger.warn("Startup reconciliation skipped: migrations pending");
        } else if (!recReport?.skipped) {
          logger.info("Startup reconciliation complete", {
            preservedContainers: recReport.preservedContainers,
            prunedContainers: recReport.prunedContainers,
            releasedPorts: recReport.releasedPorts,
            staleBuildsRecovered: recReport.staleBuildsRecovered
          });
        }
      })
      .catch((err) => {
        logger.warn("Startup reconciliation warning", { err });
      })
      .finally(() => {
        buildWorkerInstance.start();
        logger.info("Build worker loop started", { workerId: buildWorkerInstance.getWorkerId() });
      });
  }

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      logger.info("Shutdown signal received", { signal: sig });
      shutdownServer()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}

export { server, PREVIEWFLOW_MODE };
export default app;
