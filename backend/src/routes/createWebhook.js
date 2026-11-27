// backend/src/routes/createWebhook.js
import express from "express";
import axios from "axios";
import { requireAuth } from "../middleware/auth.js";
import { getTierLimits } from "../middleware/tierLimits.js";
import { prisma } from "../db.js";
import { decryptSecret, encryptSecret } from "../services/cryptoService.js";
import { isValidRepoCoordinates } from "../utils/validation.js";
import { logger } from "../utils/logger.js";
import { recordHttpAudit } from "../services/auditService.js";

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
        message: "GitHub webhooks are only available on PRO and ENTERPRISE plans."
      });
    }

    const authAccessToken = req.auth?.accessToken;

    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({ error: "missing_project_id" });
    }

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project || (user?.id && project.userId !== user.id)) {
      return res.status(404).json({ error: "project_not_found" });
    }

    if (!isValidRepoCoordinates(project.repoOwner, project.repoName)) {
      return res.status(400).json({ error: "invalid_repo_identifier" });
    }

    const ghAccessToken = decryptSecret(project.accessToken) || authAccessToken;
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

    const plainWebhookSecret = decryptSecret(project.webhookSecret);
    const webhookUrl = `${baseUrl.replace(/\/+$/, "")}/webhooks/github`;
    const githubApiUrl = `https://api.github.com/repos/${encodeURIComponent(project.repoOwner)}/${encodeURIComponent(project.repoName)}/hooks`;

    const ghResponse = await axios.post(
      githubApiUrl,
      {
        name: "web",
        config: {
          url: webhookUrl,
          content_type: "json",
          secret: plainWebhookSecret
        },
        events: ["pull_request"],
        active: true
      },
      {
        headers: {
          Authorization: `Bearer ${ghAccessToken}`,
          Accept: "application/vnd.github.v3+json"
        }
      }
    );

    const webhookId = ghResponse.data?.id ? String(ghResponse.data.id) : null;

    if (webhookId) {
      await prisma.project.update({
        where: { id: projectId },
        data: {
          webhookId,
          accessToken: encryptSecret(ghAccessToken)
        }
      });
    }

    await recordHttpAudit(req, {
      actorUserId: user?.id || null,
      action: "WEBHOOK_CREATED",
      resourceType: "Project",
      resourceId: projectId,
      status: "SUCCESS",
      metadata: { webhookId }
    });

    return res.json({ ok: true, webhookId });
  } catch (err) {
    logger.error("Webhook creation failed", {
      projectId: req.body?.projectId || null,
      status: err?.response?.status || null,
      err
    });
    await recordHttpAudit(req, {
      actorUserId: req.auth?.user?.id || null,
      action: "WEBHOOK_CREATE_FAILED",
      resourceType: "Project",
      resourceId: req.body?.projectId || null,
      status: "FAILURE",
      metadata: { reason: err?.response?.data?.message || err?.message || "unknown" }
    });
    return res.status(500).json({ error: "webhook_creation_failed" });
  }
}

router.post("/create-webhook", requireAuth, handleCreateWebhook);

export default router;
