// backend/scripts/preflight.js
import "dotenv/config";
import { prisma } from "../src/db.js";
import { runPreflightChecks } from "../src/services/preflightService.js";

function parseArgs(argv) {
  const args = {};
  for (const cur of argv) {
    if (cur.startsWith("--")) {
      args[cur.slice(2)] = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runPreflightChecks({
    env: process.env,
    client: prisma,
    skipDb: Boolean(args["skip-db"]),
    skipDocker: Boolean(args["skip-docker"])
  });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    process.stderr.write(`${JSON.stringify({ passed: false, error: err.message })}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
