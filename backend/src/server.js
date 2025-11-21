import express from "express";
import http from "http";
import session from "express-session";
import bodyParser from "body-parser";
import cors from "cors";
import passport from "./auth.js";
import jwt from "jsonwebtoken";
import morgan from "morgan";
import dotenv from "dotenv";
dotenv.config();

import githubRepos from "./routes/githubRepos.js";
import connectRepo from "./routes/connectRepo.js";
import createWebhook from "./routes/createWebhook.js";
import githubWebhook from "./routes/githubWebhook.js";
import devSim from "./routes/devSimulate.js";
import projectDashboard from "./routes/projectDashboard.js";
import previewActions from "./routes/previewActions.js";
import logsRoute from "./routes/logs.js";

import { initSocket } from "./socket.js";

const app = express();

// CORS and logging
app.use(cors({ origin: "http://localhost:5173", credentials: true }));
app.use(morgan("dev"));

// IMPORTANT: Use raw-body parser first (for webhook signature verification)
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Session & passport
app.use(session({
  secret: process.env.JWT_SECRET,
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// Auth routes
app.get("/auth/github", passport.authenticate("github"));
app.get("/auth/github/callback",
  passport.authenticate("github", { failureRedirect: "/" }),
  (req, res) => {
    const token = jwt.sign({
      userId: req.user.id,
      accessToken: req.user.accessToken
    }, process.env.JWT_SECRET);

    res.redirect(`http://localhost:5173/auth/success?token=${token}`);
  }
);

// API & webhook routes
app.use("/api", githubRepos);
app.use("/api", connectRepo);
app.use("/api", createWebhook);
app.use("/api", projectDashboard);
app.use("/api", logsRoute);
app.use("/api", previewActions);

// webhook route (must accept raw body)
app.use("/", githubWebhook);

// dev-sim
app.use("/", devSim);

// create HTTP server & attach socket.io
const server = http.createServer(app);
initSocket(server);

// start server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Backend running at http://localhost:${PORT}`));
