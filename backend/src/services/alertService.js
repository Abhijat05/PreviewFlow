// backend/src/services/alertService.js
import { logger } from "../utils/logger.js";
import { recordAlertMetric } from "./metricsService.js";

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Creates a sliding-window anomaly detector and alert dispatcher.
 */
export function createAlertManager(options = {}) {
  const listeners = new Set();
  const activeAlerts = new Map();
  const lastFiredAt = new Map();
  const recentAlerts = [];

  // Sliding-window event buckets
  const buildOutcomes = [];
  const invalidSignatures = [];
  const http5xxEvents = [];
  const leaseRecoveries = [];

  function resolveConfig() {
    return {
      windowMs: options.windowMs ?? envNumber("ALERT_WINDOW_MS", 5 * 60_000),
      cooldownMs: options.cooldownMs ?? envNumber("ALERT_COOLDOWN_MS", 60_000),
      buildFailureRate: options.buildFailureRate ?? envNumber("ALERT_BUILD_FAILURE_RATE", 0.4),
      buildFailureMinSamples:
        options.buildFailureMinSamples ?? envNumber("ALERT_BUILD_FAILURE_MIN_SAMPLES", 5),
      invalidSignatureThreshold:
        options.invalidSignatureThreshold ?? envNumber("ALERT_INVALID_SIGNATURE_THRESHOLD", 10),
      http5xxThreshold: options.http5xxThreshold ?? envNumber("ALERT_HTTP_5XX_THRESHOLD", 10),
      queueDepthThreshold: options.queueDepthThreshold ?? envNumber("ALERT_QUEUE_DEPTH_THRESHOLD", 25),
      leaseRecoveryThreshold:
        options.leaseRecoveryThreshold ?? envNumber("ALERT_LEASE_RECOVERY_THRESHOLD", 3)
    };
  }

  function pruneWindow(arr, windowMs, now = Date.now()) {
    const cutoff = now - windowMs;
    while (arr.length > 0 && arr[0].ts < cutoff) {
      arr.shift();
    }
  }

  function dispatchWebhook(alert) {
    const url = process.env.ALERT_WEBHOOK_URL;
    if (!url) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    if (timer.unref) timer.unref();

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(alert),
      signal: controller.signal
    })
      .catch((err) => {
        logger.warn("Failed to post alert webhook", { rule: alert.rule, err });
      })
      .finally(() => clearTimeout(timer));
  }

  function triggerAlert({ rule, severity = "warning", message, details = {} }) {
    const cfg = resolveConfig();
    const now = Date.now();
    const prev = lastFiredAt.get(rule) || 0;

    const alertRecord = {
      rule,
      severity,
      message,
      details,
      triggeredAt: new Date(now).toISOString(),
      triggeredAtMs: now
    };

    // Keep active alert refreshed even within cooldown
    activeAlerts.set(rule, alertRecord);

    if (now - prev < cfg.cooldownMs) {
      return null;
    }

    lastFiredAt.set(rule, now);
    recentAlerts.unshift(alertRecord);
    if (recentAlerts.length > 100) {
      recentAlerts.pop();
    }

    recordAlertMetric({ rule, severity });
    logger.error("Operational alert triggered", {
      eventType: "alert_triggered",
      rule,
      severity,
      alertMessage: message,
      details
    });

    for (const fn of listeners) {
      try {
        fn(alertRecord);
      } catch (err) {
        logger.warn("Alert listener threw error", { rule, err });
      }
    }

    dispatchWebhook(alertRecord);
    return alertRecord;
  }

  function recordBuildOutcome(status) {
    if (status !== "COMPLETED" && status !== "FAILED") return null;
    const cfg = resolveConfig();
    const now = Date.now();
    buildOutcomes.push({ ts: now, failed: status === "FAILED" });
    pruneWindow(buildOutcomes, cfg.windowMs, now);

    if (buildOutcomes.length >= cfg.buildFailureMinSamples) {
      const failures = buildOutcomes.filter((x) => x.failed).length;
      const ratio = failures / buildOutcomes.length;
      if (ratio >= cfg.buildFailureRate) {
        return triggerAlert({
          rule: "HIGH_BUILD_FAILURE_RATE",
          severity: "critical",
          message: `Build failure rate ${(ratio * 100).toFixed(1)}% exceeded threshold ${(cfg.buildFailureRate * 100).toFixed(1)}%`,
          details: { failures, total: buildOutcomes.length, ratio: Number(ratio.toFixed(3)) }
        });
      }
    }
    return null;
  }

  function recordInvalidSignature(meta = {}) {
    const cfg = resolveConfig();
    const now = Date.now();
    invalidSignatures.push({ ts: now, ...meta });
    pruneWindow(invalidSignatures, cfg.windowMs, now);

    if (invalidSignatures.length >= cfg.invalidSignatureThreshold) {
      return triggerAlert({
        rule: "WEBHOOK_INVALID_SIGNATURE_SPIKE",
        severity: "warning",
        message: `${invalidSignatures.length} invalid webhook signatures observed in window`,
        details: { count: invalidSignatures.length, threshold: cfg.invalidSignatureThreshold }
      });
    }
    return null;
  }

  function recordHttpStatus(statusCode, meta = {}) {
    if (Number(statusCode) < 500) return null;
    const cfg = resolveConfig();
    const now = Date.now();
    http5xxEvents.push({ ts: now, statusCode, ...meta });
    pruneWindow(http5xxEvents, cfg.windowMs, now);

    if (http5xxEvents.length >= cfg.http5xxThreshold) {
      return triggerAlert({
        rule: "HTTP_5XX_SPIKE",
        severity: "critical",
        message: `${http5xxEvents.length} HTTP 5xx responses observed in window`,
        details: { count: http5xxEvents.length, threshold: cfg.http5xxThreshold }
      });
    }
    return null;
  }

  function recordQueueDepth(queuedCount) {
    const cfg = resolveConfig();
    if (Number(queuedCount) >= cfg.queueDepthThreshold) {
      return triggerAlert({
        rule: "BUILD_QUEUE_BACKLOG",
        severity: "warning",
        message: `Queued build depth (${queuedCount}) exceeded threshold (${cfg.queueDepthThreshold})`,
        details: { queuedCount, threshold: cfg.queueDepthThreshold }
      });
    }
    return null;
  }

  function recordLeaseRecoveries(recoveredCount) {
    const count = Number(recoveredCount) || 0;
    if (count <= 0) return null;
    const cfg = resolveConfig();
    const now = Date.now();
    leaseRecoveries.push({ ts: now, count });
    pruneWindow(leaseRecoveries, cfg.windowMs, now);

    const totalRecovered = leaseRecoveries.reduce((sum, x) => sum + x.count, 0);
    if (totalRecovered >= cfg.leaseRecoveryThreshold) {
      return triggerAlert({
        rule: "WORKER_LEASE_EXPIRY_SPIKE",
        severity: "warning",
        message: `${totalRecovered} stale worker build leases recovered in window`,
        details: { count: totalRecovered, threshold: cfg.leaseRecoveryThreshold }
      });
    }
    return null;
  }

  function onAlert(fn) {
    if (typeof fn === "function") {
      listeners.add(fn);
    }
    return () => listeners.delete(fn);
  }

  function getAlertState() {
    const cfg = resolveConfig();
    const now = Date.now();
    pruneWindow(buildOutcomes, cfg.windowMs, now);
    pruneWindow(invalidSignatures, cfg.windowMs, now);
    pruneWindow(http5xxEvents, cfg.windowMs, now);
    pruneWindow(leaseRecoveries, cfg.windowMs, now);

    for (const [rule, entry] of activeAlerts.entries()) {
      if (now - entry.triggeredAtMs > cfg.windowMs) {
        activeAlerts.delete(rule);
      }
    }

    const active = Array.from(activeAlerts.values()).map(({ triggeredAtMs: _ignore, ...rest }) => rest);
    const hasCritical = active.some((a) => a.severity === "critical");
    const status = hasCritical ? "critical" : active.length > 0 ? "degraded" : "healthy";

    return {
      status,
      activeAlerts: active,
      recentAlertsCount: recentAlerts.length,
      windowCounters: {
        buildsInWindow: buildOutcomes.length,
        failedBuildsInWindow: buildOutcomes.filter((x) => x.failed).length,
        invalidSignaturesInWindow: invalidSignatures.length,
        http5xxInWindow: http5xxEvents.length,
        leaseRecoveriesInWindow: leaseRecoveries.reduce((s, x) => s + x.count, 0)
      }
    };
  }

  function reset() {
    activeAlerts.clear();
    lastFiredAt.clear();
    recentAlerts.length = 0;
    buildOutcomes.length = 0;
    invalidSignatures.length = 0;
    http5xxEvents.length = 0;
    leaseRecoveries.length = 0;
  }

  return {
    triggerAlert,
    recordBuildOutcome,
    recordInvalidSignature,
    recordHttpStatus,
    recordQueueDepth,
    recordLeaseRecoveries,
    onAlert,
    getAlertState,
    reset
  };
}

export const defaultAlertManager = createAlertManager();
