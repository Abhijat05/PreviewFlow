import express from "express";
import { prisma } from "../db.js";
import { verifyGithubSignature } from "../utils/gitHubVerify.js";
import { handlePROpenOrSync, handlePRClosed } from "../services/prHandlers.js";
import {
  isDuplicateDelivery,
  recordDelivery,
  markDeliveryProcessed
} from "../services/webhookDeliveryService.js";

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
    // 1. Deduplication check: if X-GitHub-Delivery was already recorded, acknowledge and skip
    if (deliveryId) {
      const isDup = await isDuplicateDelivery(deliveryId);
      if (isDup) {
        return res.status(200).send("duplicate");
      }
    }

    const repoOwner = payload?.repository?.owner?.login;
    const repoName = payload?.repository?.name;
    if (!repoOwner || !repoName) return res.status(400).send("no repo");

    // Multi-tenant safe project resolution:
    // Multiple users can connect the same repo or fork.
    // We fetch all candidate projects for repoOwner & repoName,
    // and find the one whose webhookSecret matches the HMAC signature!
    const candidateProjects = await prisma.project.findMany({
      where: { repoOwner, repoName },
      include: { user: true }
    });

    if (!candidateProjects.length) return res.status(404).send("project not registered");

    const project = candidateProjects.find((p) =>
      verifyGithubSignature(raw, signature, p.webhookSecret)
    );

    if (!project) return res.status(401).send("invalid signature");

    // Record incoming delivery once signature is verified
    if (deliveryId) {
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

    const tier = project.user.tier;

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

      await openOrSyncHandler({
        project,
        prNumber,
        ref: headRef || headSha,
        commitSha: headSha,
        user: project.user
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
