// backend/src/utils/jwtHelper.js
import jwt from "jsonwebtoken";

function parseSecretsList(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolves configured active and previous JWT verification secrets cleanly
 * to support zero-downtime secret rotation.
 */
export function resolveJwtSecrets() {
  const active = process.env.JWT_SECRET ? String(process.env.JWT_SECRET).trim() : "";
  const previous = parseSecretsList(process.env.JWT_SECRET_PREVIOUS);
  return {
    active,
    all: active ? [active, ...previous.filter((s) => s !== active)] : previous
  };
}

/**
 * Signs an authentication JWT strictly using the active JWT_SECRET.
 */
export function signAuthToken(payload, options = { expiresIn: "7d" }) {
  const { active } = resolveJwtSecrets();
  if (!active) {
    throw new Error("JWT_SECRET is required to sign authentication tokens");
  }
  return jwt.sign(payload, active, options);
}

/**
 * Verifies an authentication JWT against active JWT_SECRET first, then falls back
 * across JWT_SECRET_PREVIOUS when signature validation fails during key rotation.
 */
export function verifyAuthToken(token) {
  const { all } = resolveJwtSecrets();
  if (!all.length) {
    throw new Error("JWT_SECRET is required to verify authentication tokens");
  }

  let lastError = null;
  for (let i = 0; i < all.length; i++) {
    try {
      return jwt.verify(token, all[i]);
    } catch (err) {
      lastError = err;
      // Expired or malformed tokens should fail immediately without testing fallback keys
      if (err?.name === "TokenExpiredError") {
        throw err;
      }
    }
  }

  throw lastError || new Error("Invalid token");
}

export function decodeAuthToken(token) {
  return jwt.decode(token);
}
