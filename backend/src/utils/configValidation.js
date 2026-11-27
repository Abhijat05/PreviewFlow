// backend/src/utils/configValidation.js
const MOCK_PREFIXES = ["ci_mock_", "changeme", "default_"];

/**
 * Validates required cryptographic secrets and OAuth credentials in production.
 * Fails fast on boot if insecure fallbacks or weak secrets are configured.
 */
export function validateProductionConfig(env = process.env) {
  if (env.NODE_ENV !== "production") {
    return { valid: true, skipped: true };
  }

  const errors = [];

  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    errors.push("JWT_SECRET must be at least 32 characters in production");
  }

  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length < 32) {
    errors.push("ENCRYPTION_KEY must be at least 32 characters in production");
  }

  if (!env.DATABASE_URL) {
    errors.push("DATABASE_URL is required in production");
  }

  if (!env.GITHUB_CLIENT_ID || MOCK_PREFIXES.some((p) => env.GITHUB_CLIENT_ID.startsWith(p))) {
    errors.push("Valid GITHUB_CLIENT_ID is required in production");
  }

  if (!env.GITHUB_CLIENT_SECRET || MOCK_PREFIXES.some((p) => env.GITHUB_CLIENT_SECRET.startsWith(p))) {
    errors.push("Valid GITHUB_CLIENT_SECRET is required in production");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid production security configuration:\n - ${errors.join("\n - ")}`);
  }

  return { valid: true, skipped: false };
}
