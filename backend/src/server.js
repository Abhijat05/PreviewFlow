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
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
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

initSocket(server);
startStatsWorker();
startPeriodicDiskCleanup();

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

export default app;
