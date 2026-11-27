// backend/scripts/rotateKeys.js
import "dotenv/config";
import { prisma } from "../src/db.js";
import { rotateDatabaseSecrets } from "../src/services/keyRotationService.js";

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
  const dryRun = args["dry-run"] === true || args["dry-run"] === "true";
  const oldKey = args["old-key"] || process.env.ENCRYPTION_KEY_PREVIOUS || null;
  const newKey = args["new-key"] || process.env.ENCRYPTION_KEY;

  const report = await rotateDatabaseSecrets({
    oldKey,
    newKey,
    dryRun
  });

  process.stdout.write(`${JSON.stringify({ ok: true, report }, null, 2)}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
