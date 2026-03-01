import express from "express";
import http from "http";
import cors from "cors";
import passport from "./auth.js";
import jwt from "jsonwebtoken";
import bodyParser from "body-parser";
import dotenv from "dotenv";
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

dotenv.config();

const app = express();
const server = http.createServer(app);

app.use(
  cors({
    origin: "http://localhost:5173",
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
        `http://localhost:5173/auth/success?token=${token}`
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

app.use("/", devSim);

initSocket(server);
startStatsWorker();
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

export default app;
