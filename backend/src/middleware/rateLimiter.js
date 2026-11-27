// backend/src/middleware/rateLimiter.js
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

function resolveMax(defaultMax) {
  if (process.env.ENABLE_RATE_LIMITING === "false") {
    return 100000;
  }
  if (process.env.NODE_ENV === "test" && process.env.ENABLE_TEST_RATE_LIMITS !== "true") {
    return 10000;
  }
  return defaultMax;
}

function userOrIpKeyGenerator(req) {
  const userId = req.user?.userId || req.auth?.userId;
  if (userId) return `user:${userId}`;
  return ipKeyGenerator(req.ip || "127.0.0.1");
}

/**
 * Factory creating a configured express-rate-limit middleware.
 */
export function createRateLimiter({
  windowMs = 60 * 1000,
  max = 100,
  errorCode = "rate_limit_exceeded",
  message = "Too many requests, please try again later.",
  keyGenerator = null,
  respectTestBypass = true
} = {}) {
  return rateLimit({
    windowMs,
    max: () => (respectTestBypass ? resolveMax(max) : max),
    standardHeaders: true,
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (req, res) => {
      res.status(429).json({
        error: errorCode,
        message
      });
    }
  });
}

export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH_MAX) || 30,
  errorCode: "auth_rate_limited",
  message: "Too many authentication requests, please try again later."
});

export const webhookRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_WEBHOOK_MAX) || 120,
  errorCode: "webhook_rate_limited",
  message: "Webhook rate limit exceeded."
});

export const rebuildRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_REBUILD_MAX) || 15,
  errorCode: "rebuild_rate_limited",
  message: "Rebuild rate limit exceeded, please wait before triggering another build.",
  keyGenerator: userOrIpKeyGenerator
});

export const apiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_API_MAX) || 300,
  errorCode: "api_rate_limited",
  message: "API rate limit exceeded.",
  keyGenerator: userOrIpKeyGenerator
});
