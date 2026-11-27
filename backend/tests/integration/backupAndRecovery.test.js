// backend/tests/integration/backupAndRecovery.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { mockPrisma } from "../helpers/prismaMock.js";
import {
  encryptSecret,
  decryptSecret,
  reencryptSecret,
  isEncryptedSecret
} from "../../src/services/cryptoService.js";
import { signAuthToken, verifyAuthToken } from "../../src/utils/jwtHelper.js";
import { validateProductionConfig } from "../../src/utils/configValidation.js";
import { rotateDatabaseSecrets } from "../../src/services/keyRotationService.js";
import {
  BACKUP_FORMAT_VERSION,
  buildPgConnectionConfig,
  createEncryptedBackup,
  verifyBackupArchive,
  restoreBackupArchive,
  pruneOldBackups
} from "../../src/services/backupService.js";

const KEY_V1 = "v1_encryption_secret_key_must_be_32_chars!";
const KEY_V2 = "v2_rotated_encryption_key_is_32plus_chars!";
const JWT_V1 = "v1_jwt_signing_secret_32plus_characters!!";
const JWT_V2 = "v2_jwt_rotated_secret_32plus_characters!!";

describe("Backup, Restore & Disaster Recovery Suite", () => {
  let prismaRestore;
  const tempDirs = [];
  const origEnv = {
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_SECRET_PREVIOUS: process.env.JWT_SECRET_PREVIOUS,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    ENCRYPTION_KEY_PREVIOUS: process.env.ENCRYPTION_KEY_PREVIOUS
  };

  beforeEach(() => {
    const { restore } = mockPrisma();
    prismaRestore = restore;
  });

  afterEach(() => {
    if (prismaRestore) prismaRestore();
    for (const [k, v] of Object.entries(origEnv)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  test("zero-downtime JWT_SECRET & ENCRYPTION_KEY dual-key verification works and enforces production validation", async () => {
    // Sign session token with old JWT secret v1
    const oldToken = jwt.sign({ userId: "u_rot_1", tier: "PRO" }, JWT_V1, { expiresIn: "1h" });

    // Rotate active secret to v2 while retaining v1 in JWT_SECRET_PREVIOUS
    process.env.JWT_SECRET = JWT_V2;
    process.env.JWT_SECRET_PREVIOUS = JWT_V1;
    process.env.ENCRYPTION_KEY = KEY_V2;
    process.env.ENCRYPTION_KEY_PREVIOUS = KEY_V1;

    // Newly minted tokens sign strictly with active v2
    const freshToken = signAuthToken({ userId: "u_rot_1", tier: "PRO" });
    assert.ok(jwt.verify(freshToken, JWT_V2));
    assert.throws(() => jwt.verify(freshToken, JWT_V1));

    // Old v1 token still authenticates over HTTP /api/user/me and via verifyAuthToken
    assert.equal(verifyAuthToken(oldToken).userId, "u_rot_1");

    const oldEncryptedOAuth = encryptSecret("gho_legacy_oauth_v1", { keyOverride: KEY_V1 });
    prisma.user.findUnique = async ({ where }) =>
      where.id === "u_rot_1"
        ? { id: "u_rot_1", githubId: "99", username: "rot_user", tier: "PRO", accessToken: oldEncryptedOAuth }
        : null;

    const meRes = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${oldToken}`)
      .expect(200);
    assert.equal(meRes.body.id, "u_rot_1");
    assert.equal(decryptSecret(oldEncryptedOAuth), "gho_legacy_oauth_v1");

    // Expired old token must fail immediately without bypassing expiry
    const expiredOldToken = jwt.sign({ userId: "u_rot_1" }, JWT_V1, { expiresIn: -10 });
    assert.throws(() => verifyAuthToken(expiredOldToken), /jwt expired/i);

    // Production config validator rejects weak previous rotation keys
    assert.throws(
      () =>
        validateProductionConfig({
          NODE_ENV: "production",
          JWT_SECRET: JWT_V2,
          JWT_SECRET_PREVIOUS: "too_short",
          ENCRYPTION_KEY: KEY_V2,
          ENCRYPTION_KEY_PREVIOUS: KEY_V1,
          DATABASE_URL: "postgresql://user:pass@db:5432/prod",
          GITHUB_CLIENT_ID: "real_id",
          GITHUB_CLIENT_SECRET: "real_secret"
        }),
      /JWT_SECRET_PREVIOUS must be at least 32 characters/
    );
  });

  test("rotateDatabaseSecrets performs dry-run audit and atomic transactional re-encryption across User and Project secrets", async () => {
    const auditLogs = [];
    const users = [
      { id: "u1", accessToken: encryptSecret("gho_user_1_tok", { keyOverride: KEY_V1 }) },
      { id: "u2", accessToken: "legacy_plaintext_tok" },
      { id: "u3", accessToken: encryptSecret("gho_already_v2", { keyOverride: KEY_V2 }) }
    ];
    const projects = [
      {
        id: "p1",
        webhookSecret: encryptSecret("whsec_p1", { keyOverride: KEY_V1 }),
        accessToken: encryptSecret("ghp_p1_tok", { keyOverride: KEY_V1 })
      },
      {
        id: "p2",
        webhookSecret: encryptSecret("whsec_already_v2", { keyOverride: KEY_V2 }),
        accessToken: null
      }
    ];

    const client = {
      user: {
        findMany: async () => users.map((u) => ({ ...u })),
        update: async ({ where, data }) => {
          const target = users.find((u) => u.id === where.id);
          Object.assign(target, data);
          return target;
        }
      },
      project: {
        findMany: async () => projects.map((p) => ({ ...p })),
        update: async ({ where, data }) => {
          const target = projects.find((p) => p.id === where.id);
          Object.assign(target, data);
          return target;
        }
      },
      auditLog: {
        create: async ({ data }) => {
          auditLogs.push(data);
          return data;
        }
      },
      async $transaction(fn) {
        return fn(this);
      }
    };

    // 1. Dry-run reports exact rotation plan without mutating ciphertexts or emitting audit write
    const dryReport = await rotateDatabaseSecrets({
      oldKey: KEY_V1,
      newKey: KEY_V2,
      dryRun: true,
      client
    });
    assert.equal(dryReport.dryRun, true);
    assert.equal(dryReport.usersRotated, 2);
    assert.equal(dryReport.projectsRotated, 1);
    assert.equal(dryReport.fieldsRotated, 4);
    assert.equal(dryReport.skippedAlreadyCurrent, 2);
    assert.equal(auditLogs.length, 0);
    // Stored u1 token must still only decrypt with KEY_V1 before real rotation
    assert.throws(() => decryptSecret(users[0].accessToken, { keyOverride: KEY_V2 }));

    // 2. Live rotation updates DB atomically & emits KEYS_ROTATED audit log
    const liveReport = await rotateDatabaseSecrets({
      oldKey: KEY_V1,
      newKey: KEY_V2,
      dryRun: false,
      client
    });
    assert.equal(liveReport.dryRun, false);
    assert.equal(liveReport.fieldsRotated, 4);
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].action, "KEYS_ROTATED");

    // 3. Old key is completely retired: every rotated field decrypts cleanly using ONLY KEY_V2
    assert.equal(decryptSecret(users[0].accessToken, { keyOverride: KEY_V2 }), "gho_user_1_tok");
    assert.equal(decryptSecret(users[1].accessToken, { keyOverride: KEY_V2 }), "legacy_plaintext_tok");
    assert.ok(isEncryptedSecret(users[1].accessToken));
    assert.equal(decryptSecret(projects[0].webhookSecret, { keyOverride: KEY_V2 }), "whsec_p1");
    assert.equal(decryptSecret(projects[0].accessToken, { keyOverride: KEY_V2 }), "ghp_p1_tok");
    assert.throws(() => decryptSecret(projects[0].webhookSecret, { keyOverride: KEY_V1 }));

    // 4. Subsequent rotation run is a clean idempotent no-op
    const rerun = await rotateDatabaseSecrets({ oldKey: KEY_V1, newKey: KEY_V2, client });
    assert.equal(rerun.fieldsRotated, 0);
    assert.equal(rerun.skippedAlreadyCurrent, 6);

    // Direct helper test: reencryptSecret refuses tampered input
    assert.throws(() =>
      reencryptSecret("enc:v1:00112233445566778899aabb:0000:deadbeef", { fromKey: KEY_V1, toKey: KEY_V2 })
    );
  });

  test("encrypted backup creation, tamper detection, retention pruning, and full DB recovery drill", async () => {
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-dr-backups-"));
    tempDirs.push(backupDir);

    // In-memory Prisma simulation store preserving FK & BigInt/Date types across simulated data wipe
    let dbState = {
      user: [{ id: "u_dr_1", githubId: "555", username: "dr_alice", tier: "PRO", accessToken: encryptSecret("gho_dr", { keyOverride: KEY_V1 }) }],
      project: [{ id: "proj_dr_1", userId: "u_dr_1", repoOwner: "org", repoName: "repo", webhookSecret: "whsec_dr", allowForkBuilds: true }],
      preview: [{ id: "prev_dr_1", projectId: "proj_dr_1", prNumber: 9, status: "live", activeBuildId: "bld_dr_1", buildStartedAt: new Date("2026-11-27T08:00:00Z") }],
      build: [{ id: "bld_dr_1", previewId: "prev_dr_1", buildNumber: 1, commitSha: "abc123", branch: "main", source: "WEBHOOK_OPEN", status: "COMPLETED", queuedAt: new Date("2026-11-27T07:59:00Z") }],
      previewMetric: [{ id: "met_dr_1", previewId: "prev_dr_1", cpu: 12.5, memory: BigInt(104857600), networkRx: BigInt(2048), networkTx: BigInt(4096), createdAt: new Date("2026-11-27T08:01:00Z") }],
      webhookDelivery: [{ id: "wd_dr_1", deliveryId: "del_dr_1", eventType: "pull_request", projectId: "proj_dr_1", receivedAt: new Date("2026-11-27T07:58:00Z") }],
      portAllocation: [{ port: 5100, previewId: "prev_dr_1", buildId: "bld_dr_1", tier: "PRO", isAllocated: true }],
      auditLog: [{ id: "aud_dr_1", actorUserId: "u_dr_1", action: "PROJECT_CONNECTED", createdAt: new Date("2026-11-27T07:55:00Z") }]
    };

    const createModelMock = (table) => ({
      findMany: async () => dbState[table].map((r) => ({ ...r })),
      deleteMany: async () => {
        const count = dbState[table].length;
        dbState[table] = [];
        return { count };
      },
      create: async ({ data }) => {
        // Enforce Build FK constraint like real PostgreSQL to prove Preview.activeBuildId deferral works
        if (table === "preview" && data.activeBuildId) {
          const exists = dbState.build.some((b) => b.id === data.activeBuildId);
          if (!exists) {
            throw new Error(`FK violation: activeBuildId ${data.activeBuildId} does not exist yet`);
          }
        }
        const row = { id: data.id || `${table}_${dbState[table].length + 1}`, ...data };
        dbState[table].push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const target = dbState[table].find((r) => r.id === where.id);
        if (!target) throw new Error(`Missing row ${where.id} in ${table}`);
        Object.assign(target, data);
        return target;
      }
    });

    const mockDb = {
      user: createModelMock("user"),
      project: createModelMock("project"),
      preview: createModelMock("preview"),
      build: createModelMock("build"),
      previewMetric: createModelMock("previewMetric"),
      webhookDelivery: createModelMock("webhookDelivery"),
      portAllocation: createModelMock("portAllocation"),
      auditLog: createModelMock("auditLog"),
      async $transaction(fn) {
        return fn(this);
      }
    };

    // 1. Create encrypted snapshot archive
    const backup = await createEncryptedBackup({
      outputDir: backupDir,
      encryptionKey: KEY_V1,
      mode: "prisma_snapshot",
      client: mockDb
    });

    assert.equal(backup.format, BACKUP_FORMAT_VERSION);
    assert.equal(backup.mode, "prisma_snapshot");
    assert.ok(fs.existsSync(backup.archivePath));
    assert.ok(fs.existsSync(`${backup.archivePath}.manifest.json`));

    // Verify zero plaintext secret leakage inside encrypted archive file on disk
    const rawArchiveText = fs.readFileSync(backup.archivePath, "utf8");
    assert.ok(!rawArchiveText.includes("whsec_dr"));
    assert.ok(!rawArchiveText.includes("dr_alice"));

    // 2. Cryptographic & checksum verification succeeds with right key, fails with wrong key
    const verified = verifyBackupArchive({ archivePath: backup.archivePath, encryptionKey: KEY_V1 });
    assert.equal(verified.valid, true);
    assert.equal(verified.sha256, backup.sha256);
    assert.equal(verified.tableCounts.previewMetric, 1);

    assert.throws(() =>
      verifyBackupArchive({ archivePath: backup.archivePath, encryptionKey: KEY_V2 })
    );

    // 3. Tamper detection rejects modified ciphertext before touching database
    const tamperedPath = path.join(backupDir, "tampered.pfbackup");
    const parsedEnvelope = JSON.parse(rawArchiveText);
    parsedEnvelope.ciphertext = "AAAA" + parsedEnvelope.ciphertext.slice(4);
    fs.writeFileSync(tamperedPath, JSON.stringify(parsedEnvelope));
    await assert.rejects(
      () =>
        restoreBackupArchive({
          archivePath: tamperedPath,
          encryptionKey: KEY_V1,
          confirm: true,
          client: mockDb
        })
    );

    // 4. Restore requires explicit confirm: true safeguard
    await assert.rejects(
      () =>
        restoreBackupArchive({
          archivePath: backup.archivePath,
          encryptionKey: KEY_V1,
          confirm: false,
          client: mockDb
        }),
      /confirm=true is required/
    );

    // 5. Simulate total DB disaster wipe & execute full verified recovery drill
    for (const key of Object.keys(dbState)) {
      dbState[key] = [];
    }

    const restoreResult = await restoreBackupArchive({
      archivePath: backup.archivePath,
      encryptionKey: KEY_V1,
      confirm: true,
      client: mockDb
    });

    assert.equal(restoreResult.restored, true);
    assert.equal(dbState.user.length, 1);
    assert.equal(dbState.user[0].username, "dr_alice");
    assert.equal(decryptSecret(dbState.user[0].accessToken, { keyOverride: KEY_V1 }), "gho_dr");
    assert.equal(dbState.preview[0].activeBuildId, "bld_dr_1");
    assert.ok(dbState.preview[0].buildStartedAt instanceof Date);
    assert.equal(typeof dbState.previewMetric[0].memory, "bigint");
    assert.equal(dbState.previewMetric[0].memory, BigInt(104857600));
    assert.equal(dbState.auditLog[dbState.auditLog.length - 1].action, "BACKUP_RESTORED");

    // 6. Test retention pruning cleanly removes older backup archives
    const b2 = await createEncryptedBackup({
      outputDir: backupDir,
      encryptionKey: KEY_V1,
      mode: "prisma_snapshot",
      maxBackups: 2,
      client: mockDb
    });
    const b3 = await createEncryptedBackup({
      outputDir: backupDir,
      encryptionKey: KEY_V1,
      mode: "prisma_snapshot",
      maxBackups: 2,
      client: mockDb
    });
    assert.ok(fs.existsSync(b2.archivePath));
    assert.ok(fs.existsSync(b3.archivePath));
    const remaining = fs.readdirSync(backupDir).filter((f) => f.endsWith(".pfbackup"));
    assert.equal(remaining.length, 2);

    // Explicitly check pruneOldBackups when keeping maxBackups=1
    const pruned = pruneOldBackups({ outputDir: backupDir, maxBackups: 1 });
    assert.equal(pruned.deletedFiles.length, 1);
  });

  test("PostgreSQL pg_dump and psql execution isolates credentials from CLI args", async () => {
    const pgDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-pg-cli-"));
    tempDirs.push(pgDir);

    const cfg = buildPgConnectionConfig("postgresql://pguser:s3cr3tPass@db.internal:5432/previewflow");
    assert.ok(!cfg.sanitizedUrl.includes("s3cr3tPass"));
    assert.equal(cfg.env.PGPASSWORD, "s3cr3tPass");

    const calls = [];
    const mockExec = async (bin, args, opts) => {
      calls.push({ bin, args, envHasPassword: Boolean(opts?.env?.PGPASSWORD), stdinData: opts?.stdinData });
      if (args.includes("--version")) return { err: null, stdout: "pg_dump 16.2", stderr: "" };
      if (bin === "pg_dump") return { err: null, stdout: "-- PostgreSQL dump\nSELECT 1;\n", stderr: "" };
      if (bin === "psql") return { err: null, stdout: "", stderr: "" };
      return { err: null, stdout: "", stderr: "" };
    };

    const pgBackup = await createEncryptedBackup({
      outputDir: pgDir,
      databaseUrl: "postgresql://pguser:s3cr3tPass@db.internal:5432/previewflow",
      encryptionKey: KEY_V1,
      mode: "pg_dump",
      execFn: mockExec
    });
    assert.equal(pgBackup.mode, "pg_dump");
    assert.equal(calls[0].bin, "pg_dump");
    assert.equal(calls[0].envHasPassword, true);
    assert.ok(!calls[0].args.join(" ").includes("s3cr3tPass"));

    await restoreBackupArchive({
      archivePath: pgBackup.archivePath,
      databaseUrl: "postgresql://pguser:s3cr3tPass@db.internal:5432/previewflow",
      encryptionKey: KEY_V1,
      confirm: true,
      execFn: mockExec
    });
    assert.equal(calls[1].bin, "psql");
    assert.equal(calls[1].envHasPassword, true);
    assert.match(calls[1].stdinData, /SELECT 1;/);
  });
});
