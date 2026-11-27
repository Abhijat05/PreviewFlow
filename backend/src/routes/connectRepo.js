// backend/src/routes/connectRepo.js
import express from "express";
import crypto from "crypto";
import axios from "axios";
import { prisma } from "../db.js";
import { requireSubscription, assertRepoQuota } from "../middleware/subscription.js";
import { encryptSecret, serializeProjectSafe } from "../services/cryptoService.js";
import { isValidRepoCoordinates } from "../utils/validation.js";
import { logger } from "../utils/logger.js";
import { recordHttpAudit } from "../services/auditService.js";

const router = express.Router();

const WEBHOOK_TIERS = ["PRO", "ENTERPRISE"];

async function defaultRepoAccessVerifier({ repoOwner, repoName, accessToken }) {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json"
        },
        timeout: 5000
      }
    );
    const perms = res.data?.permissions || {};
    return Boolean(perms.admin || perms.push || perms.maintain);
  } catch {
    return false;
  }
}

let repoAccessVerifier = defaultRepoAccessVerifier;

export function setRepoAccessVerifier(fn) {
  repoAccessVerifier = fn || defaultRepoAccessVerifier;
}

export function resetRepoAccessVerifier() {
  repoAccessVerifier = defaultRepoAccessVerifier;
}

export async function handleConnectRepo(req, res) {
  try {
    const { user, tier = "FREE", accessToken } = req.sub;
    const { repoOwner, repoName } = req.body || {};

    // 1. Input validation & slug containment
    if (typeof repoOwner !== "string" || typeof repoName !== "string") {
      return res.status(400).json({ error: "invalid_input_format" });
    }

    const cleanOwner = repoOwner.trim();
    const cleanRepo = repoName.trim();

    if (!cleanOwner || !cleanRepo) {
      return res.status(400).json({ error: "missing_repo_details" });
    }

    if (!isValidRepoCoordinates(cleanOwner, cleanRepo)) {
      return res.status(400).json({ error: "invalid_repo_identifier" });
    }

    // 2. Enforce repo quota
    try {
      await assertRepoQuota(user);
    } catch (e) {
      return res.status(429).json({ error: e.message, code: e.code });
    }

    // 3. Duplicate project check (return masked DTO)
    const existing = await prisma.project.findFirst({
      where: { userId: user.id, repoOwner: cleanOwner, repoName: cleanRepo }
    });

    if (existing) {
      return res.status(200).json({
        success: true,
        project: serializeProjectSafe(existing),
        note: "already_connected"
      });
    }

    // 4. Verify authenticated user has write/admin access on GitHub repository
    if (accessToken) {
      const hasAccess = await repoAccessVerifier({
        repoOwner: cleanOwner,
        repoName: cleanRepo,
        accessToken
      });
      if (!hasAccess) {
        await recordHttpAudit(req, {
          actorUserId: user.id,
          action: "PROJECT_CONNECT_DENIED",
          resourceType: "Project",
          resourceId: `${cleanOwner}/${cleanRepo}`,
          status: "DENIED",
          metadata: { reason: "insufficient_repo_permissions" }
        });
        return res.status(403).json({
          error: "insufficient_repo_permissions",
          message: "You must have push or admin access to connect this repository."
        });
      }
    } else if (process.env.NODE_ENV === "production") {
      return res.status(401).json({ error: "missing_github_token" });
    }

    // 5. Generate webhook secret & encrypt sensitive credentials at rest
    const plainWebhookSecret = crypto.randomBytes(32).toString("hex");
    const encryptedWebhookSecret = encryptSecret(plainWebhookSecret);
    const encryptedAccessToken = accessToken ? encryptSecret(accessToken) : null;

    // 6. DB write storing encrypted secrets
    const project = await prisma.project.create({
      data: {
        userId: user.id,
        repoOwner: cleanOwner,
        repoName: cleanRepo,
        webhookSecret: encryptedWebhookSecret,
        accessToken: encryptedAccessToken
      }
    });

    // 7. Automatic webhook registration for PRO / ENTERPRISE (using plaintext webhook secret)
    let webhookCreated = false;
    if (WEBHOOK_TIERS.includes(tier.toUpperCase()) && accessToken && process.env.PUBLIC_WEBHOOK_URL) {
      try {
        const webhookURL = `${process.env.PUBLIC_WEBHOOK_URL.replace(/\/+$/, "")}/webhooks/github`;

        const hookRes = await axios.post(
          `https://api.github.com/repos/${encodeURIComponent(cleanOwner)}/${encodeURIComponent(cleanRepo)}/hooks`,
          {
            name: "web",
            active: true,
            events: ["pull_request"],
            config: {
              url: webhookURL,
              content_type: "json",
              secret: plainWebhookSecret
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
        logger.warn("Auto webhook creation failed", {
          projectId: project.id,
          err: hookErr?.response?.data || hookErr
        });
      }
    }

    await recordHttpAudit(req, {
      actorUserId: user.id,
      action: "PROJECT_CONNECTED",
      resourceType: "Project",
      resourceId: project.id,
      status: "SUCCESS",
      metadata: {
        repoOwner: cleanOwner,
        repoName: cleanRepo,
        webhookCreated
      }
    });

    return res.json({
      success: true,
      project: serializeProjectSafe(project),
      webhookCreated
    });
  } catch (err) {
    logger.error("Failed to connect repository", { err });
    return res.status(500).json({ success: false, error: "connection_failed" });
  }
}

router.post("/connect-repo", requireSubscription, handleConnectRepo);

export default router;
