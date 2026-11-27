// backend/src/services/preflightService.js
import { prisma as defaultPrisma } from "../db.js";
import { validateProductionConfig } from "../utils/configValidation.js";
import { ensureIsolatedNetwork, getDockerExecutable } from "./dockerService.js";
import { execFile } from "node:child_process";

const REQUIRED_TABLES = [
  "User",
  "Project",
  "Preview",
  "Build",
  "PreviewMetric",
  "WebhookDelivery",
  "PortAllocation",
  "AuditLog"
];

function defaultExec(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 5000 }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

/**
 * Validates production environment readiness, database schema migrations,
 * and Docker sandbox networking prior to production cutover.
 */
export async function runPreflightChecks({
  env = process.env,
  client = defaultPrisma,
  skipDb = false,
  skipDocker = false,
  dockerExec = defaultExec
} = {}) {
  const warnings = [];
  const checks = {
    config: { passed: false, details: [] },
    database: { passed: false, skipped: skipDb, details: [] },
    docker: { passed: false, skipped: skipDocker, details: [] }
  };

  // 1. Cryptographic & production configuration validation
  try {
    validateProductionConfig({ ...env, NODE_ENV: "production" });
    checks.config.passed = true;
    checks.config.details.push("Required cryptographic secrets and OAuth settings validated.");

    if (!env.PUBLIC_WEBHOOK_URL) {
      warnings.push("PUBLIC_WEBHOOK_URL is not set; auto GitHub webhook registration will be disabled.");
    }
    if (!env.PREVIEW_BASE_DOMAIN) {
      warnings.push("PREVIEW_BASE_DOMAIN is not set; previews will fall back to localhost:<port> URLs.");
    }
    if (!env.METRICS_TOKEN) {
      warnings.push("METRICS_TOKEN is unset; ensure /metrics is firewalled from public ingress.");
    }
  } catch (err) {
    checks.config.passed = false;
    checks.config.details.push(err.message);
  }

  // 2. Database connectivity & required schema verification
  if (skipDb) {
    checks.database.passed = true;
    checks.database.details.push("Database check skipped by option.");
  } else {
    try {
      await client.$queryRaw`SELECT 1`;
      checks.database.details.push("Database connectivity verified.");

      const rows = await client.$queryRaw`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
      `;
      const existingTables = new Set((rows || []).map((r) => r.table_name));
      const missingTables = REQUIRED_TABLES.filter((t) => !existingTables.has(t));

      if (missingTables.length > 0) {
        checks.database.passed = false;
        checks.database.details.push(`Missing database tables: ${missingTables.join(", ")}`);
      } else {
        checks.database.passed = true;
        checks.database.details.push(`All ${REQUIRED_TABLES.length} required Prisma tables present.`);
      }
    } catch (err) {
      checks.database.passed = false;
      checks.database.details.push(`Database check failed: ${err.message}`);
    }
  }

  // 3. Docker Engine availability & sandbox network verification
  if (skipDocker) {
    checks.docker.passed = true;
    checks.docker.details.push("Docker check skipped by option.");
  } else {
    try {
      const dockerBin = getDockerExecutable();
      const infoRes = await dockerExec(dockerBin, ["info", "--format", "{{.ServerVersion}}"]);
      if (infoRes.err) {
        checks.docker.passed = false;
        checks.docker.details.push(`Docker daemon unreachable: ${infoRes.stderr || infoRes.err.message}`);
      } else {
        const netName = await ensureIsolatedNetwork({ execFn: dockerExec });
        checks.docker.passed = Boolean(netName);
        checks.docker.details.push(
          `Docker Engine ready (v${infoRes.stdout.trim() || "unknown"}), sandbox network '${netName}' verified.`
        );
      }
    } catch (err) {
      checks.docker.passed = false;
      checks.docker.details.push(`Docker check failed: ${err.message}`);
    }
  }

  const passed = checks.config.passed && checks.database.passed && checks.docker.passed;

  return {
    passed,
    timestamp: new Date().toISOString(),
    checks,
    warnings
  };
}
