// backend/scripts/benchmark.js
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

// Ensure importing server.js loads Express app without starting live worker loops or listening on PORT
process.env.NODE_ENV = "test";
if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = "error";
}
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = "previewflow_benchmark_jwt_secret_32chars!!";
}
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = "previewflow_benchmark_enc_key_32chars!!";
}

const [{ default: app }, { prisma }, { runFullBenchmarkSuite }] = await Promise.all([
  import("../src/server.js"),
  import("../src/db.js"),
  import("../src/services/benchmarkService.js")
]);

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
  const scale = String(args.scale || "standard");
  const jsonOnly = args.json === true;

  const report = await runFullBenchmarkSuite({
    app,
    prismaClient: prisma,
    scale
  });

  if (args.out && typeof args.out === "string") {
    const target = path.resolve(args.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`\nPreviewFlow Load & Concurrency Benchmark Report (scale: ${report.scale})\n`);
    process.stdout.write(`Environment: Node ${report.environment.nodeVersion} | ${report.environment.platform} | CPUs: ${report.environment.cpus}\n\n`);
    for (const s of report.scenarios) {
      const rate =
        s.throughputPerSec ?? s.claimsPerSec ?? s.eventsDeliveredPerSec ?? 0;
      process.stdout.write(
        `  [${s.passed ? "PASS" : "FAIL"}] ${s.scenario.padEnd(18)} | rate=${String(rate).padEnd(9)} /s | p50=${String(s.latency.p50Ms).padEnd(6)}ms | p95=${String(s.latency.p95Ms).padEnd(6)}ms | p99=${String(s.latency.p99Ms).padEnd(6)}ms\n`
      );
    }
    process.stdout.write(
      `\nSummary: allPassed=${report.summary.allPassed} | totalDurationMs=${report.summary.totalDurationMs}ms | heapDelta=${report.summary.heapDeltaMb}MB | rssDelta=${report.summary.rssDeltaMb}MB\n`
    );
  }

  if (!report.summary.allPassed) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    process.stderr.write(`Benchmark runner failed: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
