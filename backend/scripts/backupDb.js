// backend/scripts/backupDb.js
import "dotenv/config";
import path from "node:path";
import { prisma } from "../src/db.js";
import {
  createEncryptedBackup,
  verifyBackupArchive,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_MAX_BACKUPS
} from "../src/services/backupService.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur.startsWith("--")) {
      const key = cur.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(
    String(args.dir || process.env.BACKUP_DIR || "./backups")
  );
  const mode = String(args.mode || "auto");
  const retentionDays = args["retention-days"]
    ? Number(args["retention-days"])
    : DEFAULT_RETENTION_DAYS;
  const maxBackups = args["max-backups"]
    ? Number(args["max-backups"])
    : DEFAULT_MAX_BACKUPS;
  const shouldVerify = args.verify !== "false";

  const created = await createEncryptedBackup({
    outputDir,
    mode,
    retentionDays,
    maxBackups
  });

  const verification = shouldVerify
    ? verifyBackupArchive({ archivePath: created.archivePath })
    : null;

  process.stdout.write(
    `${JSON.stringify({ ok: true, backup: created, verified: verification?.valid ?? null }, null, 2)}\n`
  );
}

main()
  .catch((err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
