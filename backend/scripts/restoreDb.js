// backend/scripts/restoreDb.js
import "dotenv/config";
import path from "node:path";
import { prisma } from "../src/db.js";
import { verifyBackupArchive, restoreBackupArchive } from "../src/services/backupService.js";

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
  const rawFile = args.file || args.archive;
  if (!rawFile || typeof rawFile !== "string") {
    throw new Error("Missing --file <path-to-.pfbackup>");
  }

  const archivePath = path.resolve(rawFile);

  if (args["verify-only"]) {
    const verification = verifyBackupArchive({ archivePath });
    process.stdout.write(`${JSON.stringify({ ok: true, verification }, null, 2)}\n`);
    return;
  }

  const confirm = args.confirm === true || args.confirm === "true";
  const cleanBeforeRestore = args["no-clean"] !== true;

  const result = await restoreBackupArchive({
    archivePath,
    confirm,
    cleanBeforeRestore
  });

  process.stdout.write(`${JSON.stringify({ ok: true, restore: result }, null, 2)}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
