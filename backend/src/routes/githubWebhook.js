// backend/src/routes/githubWebhook.js
import express from "express";
import { prisma } from "../db.js";
import { verifyGithubSignature } from "../utils/gitHubVerify.js";
import { handlePROpenOrSync, handlePRClosed } from "../services/prHandlers.js";
import {
  isDuplicateDelivery,
  recordDelivery,
  markDeliveryProcessed
} from "../services/webhookDeliveryService.js";
import { decryptSecret } from "../services/cryptoService.js";
import { enforceBuildQuota } from "../services/quotaService.js";
import { isValidRepoCoordinates } from "../utils/validation.js";

const router = express.Router();

let openOrSyncHandler = handlePROpenOrSync;
let closedHandler = handlePRClosed;

export function setPRHandlers({ onOpenOrSync, onClosed } = {}) {
  openOrSyncHandler = onOpenOrSync || handlePROpenOrSync;
  closedHandler = onClosed || handlePRClosed;
}

export async function handleGithubWebhook(req, res) {
  const deliveryId = req.header("X-GitHub-Delivery");
  const event = req.header("X-GitHub-Event");
  const signature = req.header("X-Hub-Signature-256");
  const payload = req.body;
  const raw = req.rawBody;

  try {
    const repoOwner = payload?.repository?.owner?.login;
    const repoName = payload?.repository?.name;
    if (!repoOwner || !repoName) return res.status(400).send("no repo");
    if (!isValidRepoCoordinates(repoOwner, repoName)) {
      return res.status(400).send("invalid repo");
    }

    // 1. Multi-tenant safe project resolution & HMAC authentication FIRST
    //    (Never leak deliveryId existence or mutate WebhookDelivery before signature passes)
    const candidateProjects = await prisma.project.findMany({
      where: { repoOwner, repoName },
      include: { user: true }
    });

    if (!candidateProjects.length) return res.status(404).send("project not registered");

    const project = candidateProjects.find((p) => {
      const secret = decryptSecret(p.webhookSecret);
      return verifyGithubSignature(raw, signature, secret);
    });

    if (!project) return res.status(401).send("invalid signature");

    // 2. Deduplication check AFTER authentic HMAC verification
    if (deliveryId) {
      const isDup = await isDuplicateDelivery(deliveryId);
      if (isDup) {
        return res.status(200).send("duplicate");
      }

      await recordDelivery({
        deliveryId,
        eventType: event || "unknown",
        action: payload?.action || null,
        projectId: project.id,
        prNumber: payload?.pull_request?.number || null,
        commitSha: payload?.pull_request?.head?.sha || null
      });
    }

    if (event !== "pull_request") {
      if (deliveryId) {
        await markDeliveryProcessed(deliveryId, { status: "IGNORED" });
      }
      return res.status(200).send("ignored");
    }

    const action = payload.action;
    const prNumber = payload.pull_request?.number;
    const headRef = payload.pull_request?.head?.ref;
    const headSha = payload.pull_request?.head?.sha;

    if (!prNumber) {
      if (deliveryId) {
        await markDeliveryProcessed(deliveryId, { status: "FAILED", errorMessage: "missing pr number" });
      }
      return res.status(400).send("missing pr number");
    }

    const tier = project.user?.tier || "FREE";

    if (["opened", "synchronize", "reopened"].includes(action)) {
      if (tier === "FREE") {
        if (deliveryId) {
          await markDeliveryProcessed(deliveryId, { status: "IGNORED", errorMessage: "free_tier_blocked" });
        }
        return res.status(200).send("free_tier_blocked");
      }

      if (tier === "HOBBY" && action !== "opened") {
        if (deliveryId) {
          await markDeliveryProcessed(deliveryId, { status: "IGNORED", errorMessage: "hobby_sync_ignored" });
        }
        return res.status(200).send("hobby_sync_ignored");
      }

      // 3. Untrusted fork-PR gate: prevent arbitrary Dockerfile/build code execution from external forks unless explicitly enabled
      const headFullName = payload.pull_request?.head?.repo?.full_name;
      const baseFullName = payload.pull_request?.base?.repo?.full_name;
      const isForkPR =
        Boolean(payload.pull_request?.head?.repo?.fork) ||
        Boolean(headFullName && baseFullName && headFullName !== baseFullName);

      if (isForkPR && !project.allowForkBuilds) {
        if (deliveryId) {
          await markDeliveryProcessed(deliveryId, { status: "IGNORED", errorMessage: "fork_pr_blocked" });
        }
        return res.status(200).send("fork_pr_blocked");
      }

      // 4. Unified tenant concurrency & preview quota enforcement
      let existingPreview = null;
      try {
        existingPreview = await prisma.preview.findFirst({
          where: { projectId: project.id, prNumber }
        });
      } catch {
        existingPreview = null;
      }

      const quota = await enforceBuildQuota({
        userId: project.userId,
        tier,
        previewId: existingPreview?.id || null,
        isNewPreview: !existingPreview || existingPreview.status === "deleted"
      });

      if (!quota.allowed) {
        if (deliveryId) {
          await markDeliveryProcessed(deliveryId, { status: "IGNORED", errorMessage: quota.code });
        }
        return res.status(200).send("quota_exceeded");
      }

      const actionToSource = {
        opened: "WEBHOOK_OPEN",
        synchronize: "WEBHOOK_SYNC",
        reopened: "WEBHOOK_REOPEN"
      };

      await openOrSyncHandler({
        project,
        prNumber,
        ref: headRef || headSha,
        commitSha: headSha,
        user: project.user,
        source: actionToSource[action] || "WEBHOOK_SYNC",
        commitMessage: payload.pull_request?.title || null,
        asyncQueue: true
      });

      if (deliveryId) {
        await markDeliveryProcessed(deliveryId, { status: "PROCESSED" });
      }
    } else if (action === "closed" || action === "deleted") {
      await closedHandler({ project, prNumber });

      if (deliveryId) {
        await markDeliveryProcessed(deliveryId, { status: "PROCESSED" });
      }
    } else {
      if (deliveryId) {
        await markDeliveryProcessed(deliveryId, { status: "IGNORED" });
      }
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("github webhook error:", err);
    if (deliveryId) {
      await markDeliveryProcessed(deliveryId, { status: "FAILED", errorMessage: err.message }).catch(() => {});
    }
    return res.status(500).send("error");
  }
}

router.post("/webhooks/github", handleGithubWebhook);

export default router;
