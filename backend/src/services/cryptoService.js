// backend/src/services/cryptoService.js
import crypto from "crypto";

const ENCRYPTED_PREFIX = "enc:v1:";

/**
 * Resolves the 32-byte AES-256 encryption key.
 * In production, requires explicit ENCRYPTION_KEY (>= 32 chars) or throws.
 * In non-production / test environments, derives a deterministic key if ENCRYPTION_KEY is omitted.
 */
export function resolveEncryptionKey() {
  const configured = process.env.ENCRYPTION_KEY;
  if (configured && configured.length >= 32) {
    return crypto.createHash("sha256").update(configured, "utf8").digest();
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("ENCRYPTION_KEY (minimum 32 characters) is required in production");
  }

  const fallbackSeed = process.env.JWT_SECRET || "previewflow_local_dev_encryption_seed_v1";
  return crypto.createHash("sha256").update(`pf-enc:${fallbackSeed}`, "utf8").digest();
}

export function isEncryptedSecret(value) {
  return typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Encrypts a plaintext secret using AES-256-GCM.
 * Returns encrypted string (`enc:v1:<iv>:<tag>:<ciphertext>`).
 * Idempotent if input is already encrypted.
 */
export function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") {
    return null;
  }

  const str = String(plaintext);
  if (isEncryptedSecret(str)) {
    return str;
  }

  const key = resolveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(str, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts an `enc:v1:...` secret. Gracefully returns legacy plaintext values unchanged
 * to allow zero-downtime migration.
 */
export function decryptSecret(stored) {
  if (stored === null || stored === undefined || stored === "") {
    return null;
  }

  const str = String(stored);
  if (!isEncryptedSecret(str)) {
    return str;
  }

  const payload = str.slice(ENCRYPTED_PREFIX.length);
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted secret format");
  }

  const [ivHex, tagHex, ciphertextHex] = parts;
  const key = resolveEncryptionKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

/**
 * Strips sensitive fields (`webhookSecret`, `accessToken`) from Project objects
 * before returning JSON responses to clients.
 */
export function serializeProjectSafe(project) {
  if (!project || typeof project !== "object") return project;

  const { webhookSecret: _ws, accessToken: _at, ...safeFields } = project;
  return {
    ...safeFields,
    hasWebhook: Boolean(project.webhookId),
    allowForkBuilds: Boolean(project.allowForkBuilds)
  };
}
