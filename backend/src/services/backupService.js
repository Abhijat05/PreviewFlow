// backend/src/services/backupService.js
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { prisma as defaultPrisma } from "../db.js";
import { resolveEncryptionKey } from "./cryptoService.js";
import { recordAuditEvent } from "./auditService.js";
import { logger, redactString } from "../utils/logger.js";

export const BACKUP_FORMAT_VERSION = "previewflow-backup-v1";
export const BACKUP_SCHEMA_VERSION = "2026-11-27";
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MAX_BACKUPS = 20;

const FORWARD_TABLES = [
  "user",
  "project",
  "preview",
  "build",
  "previewMetric",
  "webhookDelivery",
  "portAllocation",
  "auditLog"
];

const REVERSE_TABLES = [...FORWARD_TABLES].reverse();

function defaultExec(bin, args, options = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { maxBuffer: 50 * 1024 * 1024, ...options },
      (err, stdout, stderr) => {
        resolve({ err, stdout: stdout || "", stderr: stderr || "" });
      }
    );
    if (options.stdinData !== undefined && child.stdin) {
      child.stdin.write(options.stdinData);
      child.stdin.end();
    }
  });
}

async function runInTx(client, fn) {
  if (typeof client?.$transaction === "function") {
    return client.$transaction((tx) => fn(tx));
  }
  return fn(client);
}

/**
 * Strips password credentials from PostgreSQL connection strings before calling CLI args,
 * returning sanitized URL plus isolated PGPASSWORD env variable.
 */
export function buildPgConnectionConfig(databaseUrl) {
  if (!databaseUrl || typeof databaseUrl !== "string") {
    throw new Error("DATABASE_URL is required for PostgreSQL CLI backup/restore");
  }
  const parsed = new URL(databaseUrl);
  const password = decodeURIComponent(parsed.password || "");
  parsed.password = "";
  return {
    sanitizedUrl: parsed.toString(),
    env: password ? { ...process.env, PGPASSWORD: password } : { ...process.env }
  };
}

/**
 * Recursively encodes Prisma BigInt and Date values into typed JSON markers for lossless snapshot restore.
 */
export function encodeSnapshotValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") {
    return { __pfType: "BigInt", value: value.toString() };
  }
  if (value instanceof Date) {
    return { __pfType: "Date", value: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map(encodeSnapshotValue);
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) {
        out[k] = encodeSnapshotValue(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * Decodes snapshot JSON markers back to native JavaScript Date and BigInt instances.
 */
export function decodeSnapshotValue(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(decodeSnapshotValue);
  }
  if (typeof value === "object") {
    if (value.__pfType === "BigInt" && typeof value.value === "string") {
      return BigInt(value.value);
    }
    if (value.__pfType === "Date" && typeof value.value === "string") {
      return new Date(value.value);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = decodeSnapshotValue(v);
    }
    return out;
  }
  return value;
}

function resolveBackupKey(encryptionKey = null) {
  const raw = encryptionKey || process.env.BACKUP_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || null;
  return resolveEncryptionKey(raw);
}

async function canUsePgBinary(bin, execFn) {
  try {
    const { err } = await execFn(bin, ["--version"], { timeout: 3000 });
    return !err;
  } catch {
    return false;
  }
}

async function exportPrismaSnapshot(client) {
  const tables = {};
  const tableCounts = {};

  for (const model of FORWARD_TABLES) {
    if (typeof client?.[model]?.findMany === "function") {
      const rows = (await client[model].findMany({})) || [];
      tables[model] = encodeSnapshotValue(rows);
      tableCounts[model] = rows.length;
    } else {
      tables[model] = [];
      tableCounts[model] = 0;
    }
  }

  return {
    payloadBuffer: Buffer.from(JSON.stringify({ schemaVersion: BACKUP_SCHEMA_VERSION, tables }), "utf8"),
    tableCounts
  };
}

/**
 * Prunes backup archives exceeding maxBackups count or maxAgeDays threshold cleanly.
 */
export function pruneOldBackups({
  outputDir,
  maxAgeDays = DEFAULT_RETENTION_DAYS,
  maxBackups = DEFAULT_MAX_BACKUPS
} = {}) {
  if (!outputDir || !fs.existsSync(outputDir)) {
    return { deletedFiles: [] };
  }

  const cutoffMs = Date.now() - Math.max(maxAgeDays, 0) * 24 * 60 * 60 * 1000;
  const entries = fs
    .readdirSync(outputDir)
    .filter((f) => f.endsWith(".pfbackup"))
    .map((filename) => {
      const fullPath = path.join(outputDir, filename);
      const stat = fs.statSync(fullPath);
      return { filename, fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const deletedFiles = [];
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    const overLimit = maxBackups > 0 && i >= maxBackups;
    const expired = maxAgeDays > 0 && item.mtimeMs < cutoffMs;

    if (overLimit || expired) {
      try {
        fs.unlinkSync(item.fullPath);
        const manifestPath = `${item.fullPath}.manifest.json`;
        if (fs.existsSync(manifestPath)) {
          fs.unlinkSync(manifestPath);
        }
        deletedFiles.push(item.filename);
      } catch {
        // ignore individual file cleanup errors
      }
    }
  }

  return { deletedFiles };
}

/**
 * Creates a compressed, SHA-256 checksummed, AES-256-GCM encrypted database backup archive.
 * Supports PostgreSQL `pg_dump` or Prisma logical snapshot (`auto` falls back safely when `pg_dump` is absent).
 */
export async function createEncryptedBackup({
  outputDir,
  databaseUrl = process.env.DATABASE_URL,
  encryptionKey = null,
  mode = "auto",
  retentionDays = DEFAULT_RETENTION_DAYS,
  maxBackups = DEFAULT_MAX_BACKUPS,
  client = defaultPrisma,
  execFn = defaultExec
} = {}) {
  if (!outputDir || typeof outputDir !== "string") {
    throw new Error("outputDir is required to store encrypted backup archive");
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const key = resolveBackupKey(encryptionKey);

  let resolvedMode = mode;
  if (mode === "auto") {
    const pgAvailable = databaseUrl ? await canUsePgBinary("pg_dump", execFn) : false;
    resolvedMode = pgAvailable ? "pg_dump" : "prisma_snapshot";
  }

  let payloadBuffer;
  let tableCounts = {};

  if (resolvedMode === "pg_dump") {
    const { sanitizedUrl, env } = buildPgConnectionConfig(databaseUrl);
    const { err, stdout, stderr } = await execFn(
      "pg_dump",
      ["--format=plain", "--no-owner", "--no-acl", sanitizedUrl],
      { env }
    );
    if (err) {
      throw new Error(`pg_dump failed: ${redactString(stderr || err.message)}`);
    }
    payloadBuffer = Buffer.from(stdout, "utf8");
  } else if (resolvedMode === "prisma_snapshot") {
    const snap = await exportPrismaSnapshot(client);
    payloadBuffer = snap.payloadBuffer;
    tableCounts = snap.tableCounts;
  } else {
    throw new Error(`Unsupported backup mode: ${mode}`);
  }

  const createdAt = new Date().toISOString();
  const sha256 = crypto.createHash("sha256").update(payloadBuffer).digest("hex");
  const compressed = zlib.gzipSync(payloadBuffer);

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = {
    format: BACKUP_FORMAT_VERSION,
    mode: resolvedMode,
    createdAt,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    sha256,
    uncompressedBytes: payloadBuffer.length,
    compressedBytes: compressed.length,
    tableCounts
  };

  const envelope = {
    ...header,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: ciphertext.toString("base64")
  };

  const safeStamp = createdAt.replace(/[:.]/g, "-");
  const randSuffix = crypto.randomBytes(3).toString("hex");
  const filename = `previewflow-backup-${safeStamp}-${randSuffix}.pfbackup`;
  const archivePath = path.join(outputDir, filename);
  const tmpPath = `${archivePath}.tmp`;

  fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, archivePath);
  fs.writeFileSync(`${archivePath}.manifest.json`, JSON.stringify(header, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });

  const pruneReport = pruneOldBackups({
    outputDir,
    maxAgeDays: retentionDays,
    maxBackups
  });

  await recordAuditEvent(
    {
      actorType: "SYSTEM",
      action: "BACKUP_CREATED",
      resourceType: "BackupArchive",
      resourceId: filename,
      status: "SUCCESS",
      metadata: {
        mode: resolvedMode,
        sha256,
        uncompressedBytes: payloadBuffer.length,
        tableCounts,
        prunedCount: pruneReport.deletedFiles.length
      }
    },
    { client }
  );

  logger.info("Encrypted database backup created", {
    filename,
    mode: resolvedMode,
    sha256,
    uncompressedBytes: payloadBuffer.length,
    prunedCount: pruneReport.deletedFiles.length
  });

  return {
    ...header,
    archivePath,
    filename,
    prunedFiles: pruneReport.deletedFiles
  };
}

function decryptAndValidateArchive({ archivePath, encryptionKey = null }) {
  if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error(`Backup archive not found: ${archivePath}`);
  }

  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(archivePath, "utf8"));
  } catch (err) {
    throw new Error(`Corrupted backup archive JSON: ${err.message}`);
  }

  if (envelope?.format !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported backup archive format: ${envelope?.format || "unknown"}`);
  }

  if (!envelope.iv || !envelope.tag || !envelope.ciphertext || !envelope.sha256) {
    throw new Error("Backup archive missing required cryptographic fields");
  }

  const key = resolveBackupKey(encryptionKey);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "hex"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));

  const compressed = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final()
  ]);

  const payloadBuffer = zlib.gunzipSync(compressed);
  const actualSha256 = crypto.createHash("sha256").update(payloadBuffer).digest("hex");

  if (actualSha256 !== envelope.sha256) {
    throw new Error("Backup archive SHA-256 checksum mismatch");
  }

  let parsedSnapshot = null;
  if (envelope.mode === "prisma_snapshot") {
    parsedSnapshot = JSON.parse(payloadBuffer.toString("utf8"));
    if (!parsedSnapshot?.tables || typeof parsedSnapshot.tables !== "object") {
      throw new Error("Invalid prisma_snapshot payload structure");
    }
  }

  return {
    header: {
      valid: true,
      format: envelope.format,
      mode: envelope.mode,
      createdAt: envelope.createdAt,
      schemaVersion: envelope.schemaVersion,
      sha256: actualSha256,
      uncompressedBytes: payloadBuffer.length,
      tableCounts: envelope.tableCounts || {}
    },
    payloadBuffer,
    parsedSnapshot
  };
}

/**
 * Verifies cryptographic authenticity, decompression integrity, and SHA-256 checksum
 * of an encrypted backup archive without exposing raw record contents.
 */
export function verifyBackupArchive({ archivePath, encryptionKey = null } = {}) {
  const { header } = decryptAndValidateArchive({ archivePath, encryptionKey });
  return header;
}

/**
 * Verifies and restores an encrypted backup archive into PostgreSQL or Prisma database.
 * Requires explicit `confirm: true` safeguard to prevent accidental data loss.
 */
export async function restoreBackupArchive({
  archivePath,
  databaseUrl = process.env.DATABASE_URL,
  encryptionKey = null,
  confirm = false,
  cleanBeforeRestore = true,
  client = defaultPrisma,
  execFn = defaultExec
} = {}) {
  if (confirm !== true) {
    throw new Error("Restore aborted: explicit confirm=true is required for destructive recovery");
  }

  const { header, payloadBuffer, parsedSnapshot } = decryptAndValidateArchive({
    archivePath,
    encryptionKey
  });

  const restoredCounts = {};

  if (header.mode === "pg_dump") {
    const { sanitizedUrl, env } = buildPgConnectionConfig(databaseUrl);
    const sqlInput = payloadBuffer.toString("utf8");
    const { err, stderr } = await execFn(
      "psql",
      ["--set", "ON_ERROR_STOP=1", sanitizedUrl],
      { env, stdinData: sqlInput }
    );
    if (err) {
      throw new Error(`psql restore failed: ${redactString(stderr || err.message)}`);
    }
  } else if (header.mode === "prisma_snapshot") {
    const tables = parsedSnapshot.tables;

    await runInTx(client, async (tx) => {
      if (cleanBeforeRestore) {
        for (const model of REVERSE_TABLES) {
          if (typeof tx?.[model]?.deleteMany === "function") {
            await tx[model].deleteMany({});
          }
        }
      }

      // Defer Preview.activeBuildId FK until Build rows are inserted cleanly
      const deferredActiveBuilds = [];

      for (const model of FORWARD_TABLES) {
        const rows = Array.isArray(tables[model]) ? tables[model] : [];
        let inserted = 0;

        for (const rawRow of rows) {
          const row = decodeSnapshotValue(rawRow);
          if (model === "preview" && row.activeBuildId) {
            deferredActiveBuilds.push({ id: row.id, activeBuildId: row.activeBuildId });
            row.activeBuildId = null;
          }
          if (typeof tx?.[model]?.create === "function") {
            await tx[model].create({ data: row });
            inserted++;
          }
        }
        restoredCounts[model] = inserted;
      }

      for (const link of deferredActiveBuilds) {
        if (typeof tx?.preview?.update === "function") {
          await tx.preview.update({
            where: { id: link.id },
            data: { activeBuildId: link.activeBuildId }
          });
        }
      }
    });
  } else {
    throw new Error(`Unsupported restore mode: ${header.mode}`);
  }

  await recordAuditEvent(
    {
      actorType: "SYSTEM",
      action: "BACKUP_RESTORED",
      resourceType: "BackupArchive",
      resourceId: path.basename(archivePath),
      status: "SUCCESS",
      metadata: {
        mode: header.mode,
        sha256: header.sha256,
        restoredCounts
      }
    },
    { client }
  );

  logger.info("Encrypted database backup restored", {
    archive: path.basename(archivePath),
    mode: header.mode,
    restoredCounts
  });

  return {
    restored: true,
    mode: header.mode,
    sha256: header.sha256,
    restoredCounts
  };
}
