// backend/src/utils/networkConfig.js

/**
 * Resolves a hardened Express `trust proxy` configuration from TRUST_PROXY.
 * Avoids overly permissive boolean `true` while trusting bounded reverse-proxy hops in production.
 */
export function resolveTrustProxySetting(env = process.env) {
  const raw = env.TRUST_PROXY !== undefined ? String(env.TRUST_PROXY).trim() : "";

  if (!raw) {
    return env.NODE_ENV === "production" ? 1 : false;
  }

  const lower = raw.toLowerCase();
  if (lower === "false" || lower === "0" || lower === "off") {
    return false;
  }

  if (lower === "true" || lower === "on") {
    return 1;
  }

  if (/^\d+$/.test(raw)) {
    return Number.parseInt(raw, 10);
  }

  return raw;
}

/**
 * Computes normalized allowed CORS origins from FRONTEND_URL and comma-separated ALLOWED_ORIGINS.
 */
export function resolveAllowedOrigins(env = process.env) {
  const origins = new Set();

  if (env.FRONTEND_URL && String(env.FRONTEND_URL).trim()) {
    origins.add(String(env.FRONTEND_URL).trim().replace(/\/+$/, ""));
  }

  if (env.ALLOWED_ORIGINS && typeof env.ALLOWED_ORIGINS === "string") {
    for (const entry of env.ALLOWED_ORIGINS.split(",")) {
      const cleaned = entry.trim().replace(/\/+$/, "");
      if (cleaned) origins.add(cleaned);
    }
  }

  if (env.NODE_ENV !== "production") {
    origins.add("http://localhost:5173");
  } else if (origins.size === 0) {
    origins.add("http://localhost:5173");
  }

  return Array.from(origins);
}

/**
 * Returns a strict CORS origin callback matching configured exact origins cleanly.
 */
export function createCorsOriginCallback(allowedOrigins) {
  const originSet = new Set(allowedOrigins || []);
  return (origin, callback) => {
    // Allow requests without Origin header (same-origin, curl, healthchecks, GitHub webhooks)
    if (!origin || originSet.has(origin.replace(/\/+$/, ""))) {
      return callback(null, true);
    }
    return callback(null, false);
  };
}
