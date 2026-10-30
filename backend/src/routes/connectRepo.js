import express from "express";
import crypto from "crypto";
import axios from "axios";
import { prisma } from "../db.js";
import { requireSubscription, assertRepoQuota } from "../middleware/subscription.js";

const router = express.Router();

const WEBHOOK_TIERS = ["PRO", "ENTERPRISE"];

export async function handleConnectRepo(req, res) {
  try {
    const { user, tier = "FREE", accessToken } = req.sub;
    const { repoOwner, repoName } = req.body || {};

    // 1️⃣ Input validation
    if (typeof repoOwner !== "string" || typeof repoName !== "string") {
      return res.status(400).json({ error: "invalid_input_format" });
    }

    if (!repoOwner.trim() || !repoName.trim()) {
      return res.status(400).json({ error: "missing_repo_details" });
    }

    // 2️⃣ Enforce repo quota
    try {
      await assertRepoQuota(user);
    } catch (e) {
      return res.status(429).json({ error: e.message, code: e.code });
    }

    // 3️⃣ Duplicate project check
    const existing = await prisma.project.findFirst({
      where: { userId: user.id, repoOwner, repoName }
    });

    if (existing) {
      return res.status(200).json({ success: true, project: existing, note: "already_connected" });
    }

    // 4️⃣ Generate webhook secret
    const webhookSecret = crypto.randomBytes(32).toString("hex");

    // 5️⃣ DB write preserving accessToken
    const project = await prisma.project.create({
      data: {
        userId: user.id,
        repoOwner,
        repoName,
        webhookSecret,
        accessToken: accessToken || null
      }
    });

    // 6️⃣ Automatic webhook registration for PRO / ENTERPRISE
    let webhookCreated = false;
    if (WEBHOOK_TIERS.includes(tier.toUpperCase()) && accessToken && process.env.PUBLIC_WEBHOOK_URL) {
      try {
        const webhookURL = `${process.env.PUBLIC_WEBHOOK_URL.replace(/\/+$/, "")}/webhooks/github`;

        const hookRes = await axios.post(
          `https://api.github.com/repos/${repoOwner}/${repoName}/hooks`,
          {
            name: "web",
            active: true,
            events: ["pull_request"],
            config: {
              url: webhookURL,
              content_type: "json",
              secret: webhookSecret
            }
          },
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (hookRes.data?.id) {
          const webhookId = String(hookRes.data.id);
          await prisma.project.update({
            where: { id: project.id },
            data: { webhookId }
          });
          project.webhookId = webhookId;
          webhookCreated = true;
        }
      } catch (hookErr) {
        console.warn("Auto webhook creation warning (non-fatal):", hookErr?.response?.data || hookErr.message);
      }
    }

    return res.json({ success: true, project, webhookCreated });

  } catch (err) {
    console.error("connect-repo error:", err);
    return res.status(500).json({ success: false, error: "connection_failed" });
  }
}

router.post("/connect-repo", requireSubscription, handleConnectRepo);

export default router;
