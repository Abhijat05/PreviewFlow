// backend/src/routes/metrics.js
import express from "express";
import crypto from "node:crypto";
import { prisma } from "../db.js";
import { formatPrometheusMetrics, refreshDatabaseGauges } from "../services/metricsService.js";
import { defaultAlertManager } from "../services/alertService.js";

const router = express.Router();

function verifyMetricsBearerToken(headerValue, expectedToken) {
  if (!headerValue || !headerValue.startsWith("Bearer ")) return false;
  const provided = headerValue.slice("Bearer ".length).trim();
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expectedToken, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function handleGetMetrics(req, res) {
  const configuredToken = process.env.METRICS_TOKEN;
  if (configuredToken) {
    const authHeader = req.header("Authorization") || "";
    if (!verifyMetricsBearerToken(authHeader, configuredToken)) {
      return res.status(401).json({ error: "unauthorized_metrics_access" });
    }
  }

  // Refresh live DB queue/preview gauges without allowing slow/offline DB to block scraping
  const gaugeSnapshot = await Promise.race([
    refreshDatabaseGauges(prisma),
    new Promise((resolve) => setTimeout(() => resolve({ degraded: true }), 1000))
  ]);

  if (gaugeSnapshot && !gaugeSnapshot.degraded) {
    defaultAlertManager.recordQueueDepth(gaugeSnapshot.queuedCount);
  }

  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(formatPrometheusMetrics());
}

router.get("/metrics", handleGetMetrics);

export default router;
