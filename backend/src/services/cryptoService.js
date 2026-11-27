// backend/src/services/cryptoService.js
import crypto from "crypto";

const ENCRYPTED_PREFIX = "enc:v1:";

function deriveAesKey(rawSecret) {
  return crypto.createHash("sha256").update(String(rawSecret), "utf8").digest();
}

function parsePreviousKeys() {
  const raw = process.env.ENCRYPTION_KEY_PREVIOUS;
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length >= 32)
    .map(deriveAesKey);
}

/**
 * Resolves the 32-byte AES-256 encryption key.
 * In production, requires explicit ENCRYPTION_KEY (>= 32 chars) or throws.
 * In non-production / test environments, derives a deterministic key if ENCRYPTION_KEY is omitted.
 */
export function resolveEncryptionKey(keyOverride = null) {
  if (keyOverride) {
    if (typeof keyOverride === "string") {
      if (keyOverride.length < 32 && process.env.NODE_ENV === "production") {
        throw new Error("Encryption key override must be at least 32 characters in production");
      }
      return deriveAesKey(keyOverride);
    }
    if (Buffer.isBuffer(keyOverride) && keyOverride.length === 32) {
      return keyOverride;
    }
    throw new Error("Invalid encryption key override");
  }

  const configured = process.env.ENCRYPTION_KEY;
  if (configured && configured.length >= 32) {
    return deriveAesKey(configured);
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("ENCRYPTION_KEY (minimum 32 characters) is required in production");
  }

  const fallbackSeed = process.env.JWT_SECRET || "previewflow_local_dev_encryption_seed_v1";
  return crypto.createHash("sha256").update(`pf-enc:${fallbackSeed}`, "utf8").digest();
}

/**
 * Resolves active key followed by configured ENCRYPTION_KEY_PREVIOUS keys for zero-downtime rotation.
 */
export function resolveDecryptionKeys(keyOverride = null) {
  const primary = resolveEncryptionKey(keyOverride);
  if (keyOverride) return [primary];
  return [primary, ...parsePreviousKeys()];
}

export function isEncryptedSecret(value) {
  return typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Encrypts a plaintext secret using AES-256-GCM.
 * Returns encrypted string (`enc:v1:<iv>:<tag>:<ciphertext>`).
 * Idempotent if input is already encrypted (unless forceKeyRotation / explicit keyOverride via reencryptSecret).
 */
export function encryptSecret(plaintext, { keyOverride = null } = {}) {
  if (plaintext === null || plaintext === undefined || plaintext === "") {
    return null;
  }

  const str = String(plaintext);
  if (!keyOverride && isEncryptedSecret(str)) {
    return str;
  }

  const key = resolveEncryptionKey(keyOverride);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(str, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptWithSingleKey(ivHex, tagHex, ciphertextHex, key) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

/**
 * Decrypts an `enc:v1:...` secret across active ENCRYPTION_KEY and optional ENCRYPTION_KEY_PREVIOUS fallbacks.
 * Gracefully returns legacy plaintext values unchanged to allow zero-downtime migration.
 */
export function decryptSecret(stored, { keyOverride = null, fallbackKeys = null } = {}) {
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
  const candidateKeys = [
    ...resolveDecryptionKeys(keyOverride),
    ...(Array.isArray(fallbackKeys) ? fallbackKeys.map(resolveEncryptionKey) : [])
  ];

  let lastError = null;
  for (const key of candidateKeys) {
    try {
      return decryptWithSingleKey(ivHex, tagHex, ciphertextHex, key);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Unable to decrypt secret with configured keys");
}

/**
 * Re-encrypts an existing plaintext or old-key ciphertext under a target new key.
 * Returns { rotated: boolean, value: string|null, alreadyCurrent: boolean }.
 */
export function reencryptSecret(stored, { fromKey = null, toKey = null } = {}) {
  if (stored === null || stored === undefined || stored === "") {
    return { rotated: false, value: null, alreadyCurrent: true };
  }

  const targetKey = resolveEncryptionKey(toKey);

  // If already decryptable cleanly with targetKey (and encrypted), avoid unnecessary churn unless legacy plaintext
  if (isEncryptedSecret(stored)) {
    try {
      const payload = stored.slice(ENCRYPTED_PREFIX.length).split(":");
      if (payload.length === 3) {
        decryptWithSingleKey(payload[0], payload[1], payload[2], targetKey);
        return { rotated: false, value: stored, alreadyCurrent: true };
      }
    } catch {
      // Encrypted with previous key -> proceed to decrypt via fromKey / configured fallbacks and re-encrypt
    }
  }

  const plaintext = decryptSecret(stored, {
    keyOverride: fromKey || null,
    fallbackKeys: fromKey ? [resolveEncryptionKey(toKey)] : null
  });

  // Encrypt raw plaintext strictly with targetKey
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", targetKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const reencrypted = `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;

  // Verification gate: prove round-trip decryption succeeds under targetKey before returning
  const checkPlain = decryptSecret(reencrypted, { keyOverride: targetKey });
  if (checkPlain !== plaintext) {
    throw new Error("Re-encryption round-trip verification failed");
  }

  return { rotated: true, value: reencrypted, alreadyCurrent: false };
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
