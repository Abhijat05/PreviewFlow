// backend/src/utils/logger.js
import { AsyncLocalStorage } from "node:async_hooks";

const contextStorage = new AsyncLocalStorage();

const LEVEL_PRIORITY = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

const SENSITIVE_KEY_SUBSTRINGS = [
  "authorization",
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "cookie",
  "set-cookie",
  "jwt",
  "privatekey",
  "private_key",
  "encryption_key",
  "encryptionkey",
  "x-hub-signature",
  "x-admin-token",
  "x-payment-token",
  "credential"
];

const EXACT_SENSITIVE_KEYS = new Set(["code", "authcode", "signature", "auth", "pwd", "pass"]);

function isSensitiveKey(key) {
  const normalized = String(key || "").trim().toLowerCase();
  if (!normalized) return false;
  if (EXACT_SENSITIVE_KEYS.has(normalized)) return true;
  return SENSITIVE_KEY_SUBSTRINGS.some((sub) => normalized.includes(sub));
}

/**
 * Scrubs tokens, credentials, encrypted ciphertexts, JWTs, and sensitive query params from strings.
 */
export function redactString(input) {
  if (input === null || input === undefined) return input;
  let out = String(input);

  // Embedded credentials in HTTP/HTTPS URLs (e.g. git clone URLs)
  out = out.replace(/(https?:\/\/)([^@\s/]+)@([^\s]+)/gi, "$1***@$3");

  // Bearer authentication headers
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");

  // GitHub tokens (classic & fine-grained PATs / OAuth / App)
  out = out.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+\b/g, "[REDACTED]");
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[REDACTED]");

  // PreviewFlow AES-GCM encrypted payload prefix
  out = out.replace(/\benc:v1:[A-Za-z0-9+/=:-]+\b/g, "[REDACTED]");

  // JWT tokens (3 base64url segments starting with JSON header "eyJ")
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    "[REDACTED]"
  );

  // Query parameters carrying sensitive values
  out = out.replace(
    /([?&](?:token|access_token|secret|code|password|api_key|apikey|paymentToken)=)[^&\s#]+/gi,
    "$1[REDACTED]"
  );

  return out;
}

/**
 * Deeply clones and redacts secrets from objects, arrays, and Error instances safely.
 */
export function redactValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Date) return value.toISOString();

  if (depth >= 8) {
    return "[MaxDepth]";
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (value instanceof Error) {
      const serialized = {
        name: value.name || "Error",
        message: redactString(value.message || "")
      };
      if (value.code !== undefined) serialized.code = redactValue(value.code, depth + 1, seen);
      if (value.status !== undefined) serialized.status = value.status;
      if (value.statusCode !== undefined) serialized.statusCode = value.statusCode;
      if (value.stack && process.env.NODE_ENV !== "production") {
        serialized.stack = redactString(value.stack);
      }
      if (value.cause) {
        serialized.cause = redactValue(value.cause, depth + 1, seen);
      }
      seen.delete(value);
      return serialized;
    }

    if (Array.isArray(value)) {
      const arr = value.map((item) => redactValue(item, depth + 1, seen));
      seen.delete(value);
      return arr;
    }

    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) {
        if (v !== undefined && v !== null && v !== "") {
          out[k] = "[REDACTED]";
        }
        continue;
      }
      const cleaned = redactValue(v, depth + 1, seen);
      if (cleaned !== undefined) {
        out[k] = cleaned;
      }
    }
    seen.delete(value);
    return out;
  }

  return String(value);
}

/**
 * Executes a synchronous or async callback within an isolated AsyncLocalStorage correlation scope.
 */
export function runWithContext(initialContext, fn) {
  const parent = contextStorage.getStore() || {};
  const store = { ...parent, ...(initialContext || {}) };
  return contextStorage.run(store, fn);
}

/**
 * Merges additional correlation attributes (e.g. userId, buildId) into the active async context.
 */
export function extendContext(fields) {
  const store = contextStorage.getStore();
  if (!store || !fields || typeof fields !== "object") return;
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) {
      store[k] = v;
    }
  }
}

/**
 * Returns the active correlation context or an empty object.
 */
export function getLogContext() {
  return contextStorage.getStore() || {};
}

function resolveMinLevel(explicitLevel) {
  if (explicitLevel && LEVEL_PRIORITY[explicitLevel] !== undefined) {
    return LEVEL_PRIORITY[explicitLevel];
  }
  const envLevel = (process.env.LOG_LEVEL || "").trim().toLowerCase();
  if (envLevel && LEVEL_PRIORITY[envLevel] !== undefined) {
    return LEVEL_PRIORITY[envLevel];
  }
  const isTest = process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
  return isTest ? LEVEL_PRIORITY.warn : LEVEL_PRIORITY.info;
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      msg: "Failed to serialize structured log payload"
    });
  }
}

/**
 * Creates a structured redacted JSON logger with optional static bindings and custom sink.
 */
export function createLogger({
  service = "previewflow-backend",
  level = null,
  bindings = {},
  sink = null
} = {}) {
  function emit(entryLevel, message, meta) {
    if (LEVEL_PRIORITY[entryLevel] < resolveMinLevel(level)) {
      return null;
    }

    const activeCtx = getLogContext();
    const cleanedBindings = redactValue(bindings) || {};
    const cleanedCtx = redactValue(activeCtx) || {};

    let cleanedMeta = {};
    if (meta instanceof Error) {
      cleanedMeta = { err: redactValue(meta) };
    } else if (meta && typeof meta === "object") {
      cleanedMeta = redactValue(meta);
    } else if (meta !== undefined) {
      cleanedMeta = { detail: redactValue(meta) };
    }

    const record = {
      timestamp: new Date().toISOString(),
      level: entryLevel,
      service,
      ...cleanedCtx,
      ...cleanedBindings,
      msg: redactString(message),
      ...cleanedMeta
    };

    const line = safeJsonStringify(record);

    if (typeof sink === "function") {
      sink(record, line);
    } else if (sink && typeof sink.write === "function") {
      sink.write(`${line}\n`);
    } else if (entryLevel === "error" || entryLevel === "warn") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }

    return record;
  }

  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
    child: (extraBindings = {}) =>
      createLogger({
        service,
        level,
        bindings: { ...bindings, ...extraBindings },
        sink
      })
  };
}

export const logger = createLogger();
export default logger;
