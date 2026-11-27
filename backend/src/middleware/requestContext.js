// backend/src/middleware/requestContext.js
import crypto from "node:crypto";
import { logger, redactString, runWithContext } from "../utils/logger.js";
import { recordHttpRequest } from "../services/metricsService.js";
import { defaultAlertManager } from "../services/alertService.js";

const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const KNOWN_UNPARAMETERIZED_ROUTES = new Set([
  "/health",
  "/health/ready",
  "/metrics",
  "/auth/github",
  "/auth/github/callback",
  "/auth/exchange",
  "/webhooks/github",
  "/dev/sim-pr"
]);

/**
 * Resolves a bounded-cardinality route pattern for Prometheus metrics labels.
 */
export function resolveMetricRouteLabel(req) {
  if (req.route?.path) {
    return `${req.baseUrl || ""}${req.route.path}`;
  }
  const rawPath = (req.path || "/").split("?")[0];
  if (KNOWN_UNPARAMETERIZED_ROUTES.has(rawPath)) {
    return rawPath;
  }
  return "/unmatched";
}

/**
 * Express middleware that attaches correlation IDs (X-Request-Id), propagates AsyncLocalStorage context,
 * records latency & status metrics, triggers 5xx alerts, and emits redacted structured access logs.
 */
export function requestContextMiddleware(req, res, next) {
  const incomingId = req.header("X-Request-Id");
  const requestId =
    incomingId && SAFE_REQUEST_ID_RE.test(incomingId.trim())
      ? incomingId.trim()
      : crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  const startNs = process.hrtime.bigint();
  const safePath = redactString(req.originalUrl || req.url || "/");

  return runWithContext(
    {
      requestId,
      method: req.method,
      path: safePath
    },
    () => {
      res.on("finish", () => {
        const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
        const durationMs = Math.round(durationSeconds * 1000 * 100) / 100;
        const routeLabel = resolveMetricRouteLabel(req);
        const statusCode = res.statusCode;

        recordHttpRequest({
          method: req.method,
          route: routeLabel,
          statusCode,
          durationSeconds
        });

        defaultAlertManager.recordHttpStatus(statusCode, {
          requestId,
          method: req.method,
          route: routeLabel
        });

        const logMeta = {
          eventType: "http_request",
          route: routeLabel,
          statusCode,
          durationMs
        };

        if (statusCode >= 500) {
          logger.error("HTTP request failed with 5xx", logMeta);
        } else if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
          logger.warn("HTTP request rejected", logMeta);
        } else {
          logger.info("HTTP request completed", logMeta);
        }
      });

      next();
    }
  );
}
