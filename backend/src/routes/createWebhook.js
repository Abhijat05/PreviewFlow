import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { getTierLimits } from "../middleware/tierLimits.js";
import { prisma } from "../db.js";
import axios from "axios";

const router = express.Router();

export async function handleCreateWebhook(req, res) {
  try {
    const { projectId } = req.body || {};
    const user = req.auth?.user;
    const tier = user?.tier || "FREE";
    const limits = getTierLimits(tier);

    if (!limits.allowWebhooks) {
      return res.status(403).json({
        error: "webhook_not_allowed",
        message: "GitHub webhooks are only available on PRO and ENTERPRISE plans.",
      });
    }

    // Determine access token: check req.auth.accessToken or look up project
    const authAccessToken = req.auth?.accessToken;

    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({ error: "missing_project_id" });
    }

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project || (user?.id && project.userId !== user.id)) {
      return res.status(404).json({ error: "project_not_found" });
    }

    const ghAccessToken = project.accessToken || authAccessToken;
    if (!ghAccessToken) {
      return res.status(400).json({
        error: "missing_github_token",
        message: "No GitHub access token available to register webhook."
      });
    }

    const baseUrl = process.env.PUBLIC_WEBHOOK_URL || process.env.APP_BASE_URL;
    if (!baseUrl) {
      return res.status(500).json({
        error: "missing_webhook_base_url",
        message: "Server configuration missing PUBLIC_WEBHOOK_URL"
      });
    }

    // Standardized webhook endpoint matching server.js & githubWebhook.js
    const webhookUrl = `${baseUrl.replace(/\/+$/, "")}/webhooks/github`;
    const githubApiUrl = `https://api.github.com/repos/${project.repoOwner}/${project.repoName}/hooks`;

    const ghResponse = await axios.post(
      githubApiUrl,
      {
        name: "web",
        config: {
          url: webhookUrl,
          content_type: "json",
          secret: project.webhookSecret,
        },
        events: ["pull_request"],
        active: true,
      },
      {
        headers: {
          Authorization: `Bearer ${ghAccessToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    const webhookId = ghResponse.data?.id ? String(ghResponse.data.id) : null;

    if (webhookId) {
      await prisma.project.update({
        where: { id: projectId },
        data: {
          webhookId,
          accessToken: ghAccessToken
        },
      });
    }

    return res.json({ ok: true, webhook: ghResponse.data });
  } catch (err) {
    console.error("create-webhook error:", err?.response?.data || err?.message || err);
    const ghError = err?.response?.data?.message || err?.message;
    return res.status(500).json({ error: "internal_error", message: ghError });
  }
}

router.post("/create-webhook", requireAuth, handleCreateWebhook);

export default router;
