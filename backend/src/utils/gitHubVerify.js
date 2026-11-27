// backend/src/utils/gitHubVerify.js
import crypto from "crypto";

export function verifyGithubSignature(rawBody, signature, secret) {
  if (!signature || typeof signature !== "string") return false;
  if (!secret || typeof secret !== "string") return false;
  if (typeof rawBody !== "string" && !Buffer.isBuffer(rawBody)) return false;

  const sigPrefix = "sha256=";
  if (!signature.startsWith(sigPrefix)) return false;

  const expected = sigPrefix + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const signatureBuf = Buffer.from(signature, "utf8");

  if (expectedBuf.length !== signatureBuf.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
  } catch {
    return false;
  }
}
