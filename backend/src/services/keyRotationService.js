// backend/src/services/keyRotationService.js
import { prisma as defaultPrisma } from "../db.js";
import { reencryptSecret } from "./cryptoService.js";
import { recordAuditEvent } from "./auditService.js";
import { logger } from "../utils/logger.js";

async function runInTx(client, fn) {
  if (typeof client?.$transaction === "function") {
    return client.$transaction((tx) => fn(tx));
  }
  return fn(client);
}

/**
 * Validates encryption key strength before permitting database key rotation.
 */
function assertStrongKey(key, label) {
  if (!key || typeof key !== "string" || key.length < 32) {
    throw new Error(`${label} must be at least 32 characters`);
  }
}

/**
 * Re-encrypts User.accessToken, Project.accessToken, and Project.webhookSecret
 * from `oldKey` (or configured fallbacks / legacy plaintext) to `newKey`.
 * Supports dry-run auditing and executes atomically per batch without logging secrets.
 */
export async function rotateDatabaseSecrets({
  oldKey = null,
  newKey,
  dryRun = false,
  client = defaultPrisma
} = {}) {
  assertStrongKey(newKey, "newKey");
  if (oldKey !== null && oldKey !== undefined && oldKey !== "") {
    assertStrongKey(oldKey, "oldKey");
    if (oldKey === newKey) {
      throw new Error("newKey must differ from oldKey");
    }
  }

  const report = {
    dryRun: Boolean(dryRun),
    usersScanned: 0,
    usersRotated: 0,
    projectsScanned: 0,
    projectsRotated: 0,
    fieldsRotated: 0,
    skippedAlreadyCurrent: 0,
    errors: []
  };

  const users = (await client.user.findMany({})) || [];
  const userUpdates = [];

  for (const user of users) {
    report.usersScanned++;
    if (!user.accessToken) continue;

    try {
      const res = reencryptSecret(user.accessToken, { fromKey: oldKey, toKey: newKey });
      if (res.rotated) {
        report.usersRotated++;
        report.fieldsRotated++;
        userUpdates.push({ id: user.id, data: { accessToken: res.value } });
      } else if (res.alreadyCurrent) {
        report.skippedAlreadyCurrent++;
      }
    } catch (err) {
      report.errors.push({ model: "User", id: user.id, field: "accessToken", reason: err.message });
    }
  }

  const projects = (await client.project.findMany({})) || [];
  const projectUpdates = [];

  for (const project of projects) {
    report.projectsScanned++;
    const patch = {};

    if (project.webhookSecret) {
      try {
        const res = reencryptSecret(project.webhookSecret, { fromKey: oldKey, toKey: newKey });
        if (res.rotated) {
          patch.webhookSecret = res.value;
          report.fieldsRotated++;
        } else if (res.alreadyCurrent) {
          report.skippedAlreadyCurrent++;
        }
      } catch (err) {
        report.errors.push({ model: "Project", id: project.id, field: "webhookSecret", reason: err.message });
      }
    }

    if (project.accessToken) {
      try {
        const res = reencryptSecret(project.accessToken, { fromKey: oldKey, toKey: newKey });
        if (res.rotated) {
          patch.accessToken = res.value;
          report.fieldsRotated++;
        } else if (res.alreadyCurrent) {
          report.skippedAlreadyCurrent++;
        }
      } catch (err) {
        report.errors.push({ model: "Project", id: project.id, field: "accessToken", reason: err.message });
      }
    }

    if (Object.keys(patch).length > 0) {
      report.projectsRotated++;
      projectUpdates.push({ id: project.id, data: patch });
    }
  }

  if (report.errors.length > 0) {
    logger.error("Key rotation encountered decryption errors; aborting writes", {
      dryRun: report.dryRun,
      errorCount: report.errors.length
    });
    const err = new Error(`Key rotation failed for ${report.errors.length} record field(s)`);
    err.report = report;
    throw err;
  }

  if (!dryRun && (userUpdates.length > 0 || projectUpdates.length > 0)) {
    await runInTx(client, async (tx) => {
      for (const u of userUpdates) {
        await tx.user.update({ where: { id: u.id }, data: u.data });
      }
      for (const p of projectUpdates) {
        await tx.project.update({ where: { id: p.id }, data: p.data });
      }
    });
  }

  if (!dryRun) {
    await recordAuditEvent(
      {
        actorType: "SYSTEM",
        action: "KEYS_ROTATED",
        resourceType: "EncryptionKey",
        status: "SUCCESS",
        metadata: {
          usersRotated: report.usersRotated,
          projectsRotated: report.projectsRotated,
          fieldsRotated: report.fieldsRotated,
          skippedAlreadyCurrent: report.skippedAlreadyCurrent
        }
      },
      { client }
    );
  }

  logger.info("Database key rotation finished", report);
  return report;
}
