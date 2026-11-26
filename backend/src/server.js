import dotenv from "dotenv";
dotenv.config();

import express from "express";
import http from "http";
import cors from "cors";
import passport from "./auth.js";
import jwt from "jsonwebtoken";
import bodyParser from "body-parser";
import morgan from "morgan";
import { prisma } from "./db.js";
import { initSocket } from "./socket.js";

import githubRepos from "./routes/githubRepos.js";
import connectRepo from "./routes/connectRepo.js";
import createWebhook from "./routes/createWebhook.js";
import githubWebhook from "./routes/githubWebhook.js";
import previewActions from "./routes/previewActions.js";
import projectDashboard from "./routes/projectDashboard.js";
import logsRoute from "./routes/logs.js";
import userRoute from "./routes/user.js";
import accountTier from "./routes/accountTier.js";
import { startStatsWorker } from "./services/statsWorker.js";
import previewMetricsRoutes from "./routes/previewMetrics.js";
import devSim from "./routes/devSimulate.js"; // Development simulation routes
import { startPeriodicDiskCleanup } from "./services/repoService.js";
import { startPeriodicDockerCleanup } from "./services/dockerService.js";
import { createWorkerLoop } from "./services/buildWorker.js";
import { executeBuildJob } from "./services/buildOrchestrator.js";
import { runStartupReconciliation } from "./services/reconciliationService.js";

const app = express();
const server = http.createServer(app);

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

app.use(morgan("dev"));

// Raw-body JSON parser for GitHub webhook HMAC verification
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

app.use(passport.initialize());

// Health check endpoint for uptime monitoring & container orchestrators
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    mode: PREVIEWFLOW_MODE,
    timestamp: new Date().toISOString()
  });
});

// Readiness check verifying PostgreSQL connectivity and worker state
app.get("/health/ready", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({
      status: "ready",
      db: "connected",
      mode: PREVIEWFLOW_MODE,
      workerRunning: Boolean(buildWorkerInstance?.isRunning?.()),
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

app.get("/auth/github", passport.authenticate("github"));

app.get(
  "/auth/github/callback",
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

      const token = jwt.sign(
        {
          userId: freshUser.id,
          accessToken: user.accessToken,
          tier: freshUser.tier,
        },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );

      return res.redirect(
        `${FRONTEND_URL}/auth/success?token=${token}`
      );
    } catch (err) {
      console.error("OAuth callback error:", err);
      return res.status(500).send("auth_failed");
    }
  }
);

app.use("/api", githubRepos);
app.use("/api", connectRepo);
app.use("/api", createWebhook);
app.use("/api", previewActions);
app.use("/api", projectDashboard);
app.use("/api", logsRoute);
app.use("/api/user", userRoute);
app.use("/api/previews", previewMetricsRoutes);
app.use("/api/account", accountTier);

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
  console.error("Unhandled Express error:", err?.message || err);
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
  const shouldRunApi = PREVIEWFLOW_MODE === "all" || PREVIEWFLOW_MODE === "api";
  const shouldRunWorker = PREVIEWFLOW_MODE === "all" || PREVIEWFLOW_MODE === "worker";

  if (shouldRunApi) {
    initSocket(server);
    statsWorkerTimer = startStatsWorker();
    diskCleanupTimer = startPeriodicDiskCleanup();

    const PORT = process.env.PORT || 4000;
    server.listen(PORT, () => {
      console.log(`Backend [mode: ${PREVIEWFLOW_MODE}] running on http://localhost:${PORT}`);
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
          console.warn("[Reconciler] PortAllocation/Build migrations pending; skipped DB reconciliation.");
        } else if (!recReport?.skipped) {
          console.log(
            `[Reconciler] Startup complete: preserved=${recReport.preservedContainers}, pruned=${recReport.prunedContainers}, releasedPorts=${recReport.releasedPorts}, recoveredBuilds=${recReport.staleBuildsRecovered}`
          );
        }
      })
      .catch((err) => {
        console.warn("[Reconciler] Startup reconciliation warning:", err?.message || err);
      })
      .finally(() => {
        buildWorkerInstance.start();
        console.log(`[Worker] Build worker loop started (id: ${buildWorkerInstance.getWorkerId()})`);
      });
  }

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      console.log(`[Server] Received ${sig}, shutting down gracefully...`);
      shutdownServer()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}

export { server, PREVIEWFLOW_MODE };
export default app;
