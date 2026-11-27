// backend/tests/integration/productionDeployment.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import app from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { mockPrisma } from "../helpers/prismaMock.js";
import {
  resolveTrustProxySetting,
  resolveAllowedOrigins,
  createCorsOriginCallback
} from "../../src/utils/networkConfig.js";
import { runPreflightChecks } from "../../src/services/preflightService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

describe("Production Deployment, Reverse-Proxy Routing & Operational Validation Suite", () => {
  let prismaRestore;
  const origEnv = {
    INTERNAL_PROXY_TOKEN: process.env.INTERNAL_PROXY_TOKEN,
    PREVIEW_BASE_DOMAIN: process.env.PREVIEW_BASE_DOMAIN,
    PREVIEW_UPSTREAM_HOST: process.env.PREVIEW_UPSTREAM_HOST
  };

  beforeEach(() => {
    const { restore } = mockPrisma();
    prismaRestore = restore;
    delete process.env.INTERNAL_PROXY_TOKEN;
    delete process.env.PREVIEW_BASE_DOMAIN;
    delete process.env.PREVIEW_UPSTREAM_HOST;
  });

  afterEach(() => {
    if (prismaRestore) prismaRestore();
    for (const [k, v] of Object.entries(origEnv)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  test("networkConfig resolves bounded trust_proxy hops and multi-origin CORS safely", async () => {
    assert.equal(resolveTrustProxySetting({ NODE_ENV: "production" }), 1);
    assert.equal(resolveTrustProxySetting({ NODE_ENV: "production", TRUST_PROXY: "true" }), 1);
    assert.equal(resolveTrustProxySetting({ NODE_ENV: "production", TRUST_PROXY: "2" }), 2);
    assert.equal(resolveTrustProxySetting({ NODE_ENV: "production", TRUST_PROXY: "false" }), false);
    assert.equal(resolveTrustProxySetting({ NODE_ENV: "development" }), false);

    const prodOrigins = resolveAllowedOrigins({
      NODE_ENV: "production",
      FRONTEND_URL: "https://app.example.com/",
      ALLOWED_ORIGINS: "https://admin.example.com, https://staging.example.com/"
    });
    assert.deepEqual(prodOrigins, [
      "https://app.example.com",
      "https://admin.example.com",
      "https://staging.example.com"
    ]);
    assert.ok(!prodOrigins.includes("http://localhost:5173"));

    const checker = createCorsOriginCallback(prodOrigins);
    const allowed = await new Promise((r) => checker("https://admin.example.com", (_, ok) => r(ok)));
    const denied = await new Promise((r) => checker("https://evil.example.com", (_, ok) => r(ok)));
    const noOrigin = await new Promise((r) => checker(undefined, (_, ok) => r(ok)));
    assert.equal(allowed, true);
    assert.equal(denied, false);
    assert.equal(noOrigin, true);
  });

  test("GET /internal/resolve-preview validates hostnames, enforces INTERNAL_PROXY_TOKEN, and maps live upstreams", async () => {
    process.env.INTERNAL_PROXY_TOKEN = "internal-proxy-secret-xyz";
    process.env.PREVIEW_BASE_DOMAIN = "previews.example.com";
    process.env.PREVIEW_UPSTREAM_HOST = "host.docker.internal";

    // 1. Missing or wrong token rejected with 401
    await request(app)
      .get("/internal/resolve-preview?host=pr-42-b3-prev12.previews.example.com")
      .expect(401);

    // 2. Malformed / path-traversal hosts rejected with 400
    await request(app)
      .get("/internal/resolve-preview?host=../../etc/passwd")
      .set("X-Internal-Proxy-Token", "internal-proxy-secret-xyz")
      .expect(400);

    // 3. Domain outside configured PREVIEW_BASE_DOMAIN rejected with 404
    await request(app)
      .get("/internal/resolve-preview?host=pr-42-b3-prev12.other-domain.com")
      .set("X-Internal-Proxy-Token", "internal-proxy-secret-xyz")
      .expect(404);

    // 4. Resolves matching live preview upstream safely
    prisma.preview.findMany = async ({ where }) =>
      where.prNumber === 42
        ? [
            {
              id: "prev123456",
              prNumber: 42,
              status: "live",
              port: 6042,
              url: "https://pr-42-b3-prev12.previews.example.com"
            }
          ]
        : [];

    const okRes = await request(app)
      .get("/internal/resolve-preview?host=pr-42-b3-prev12.previews.example.com")
      .set("Authorization", "Bearer internal-proxy-secret-xyz")
      .expect(200);

    assert.equal(okRes.headers["x-preview-port"], "6042");
    assert.equal(okRes.headers["x-preview-upstream"], "host.docker.internal:6042");
    assert.equal(okRes.body.port, 6042);

    // 5. Stopped / unknown PR returns 404
    await request(app)
      .get("/internal/resolve-preview?host=pr-999-b1-abc123.previews.example.com")
      .set("X-Internal-Proxy-Token", "internal-proxy-secret-xyz")
      .expect(404);
  });

  test("runPreflightChecks fails fast on incomplete config/schema/docker and passes when production-ready", async () => {
    const validEnv = {
      JWT_SECRET: "a".repeat(40),
      ENCRYPTION_KEY: "b".repeat(40),
      DATABASE_URL: "postgresql://user:pass@db:5432/prod",
      GITHUB_CLIENT_ID: "real_client_id",
      GITHUB_CLIENT_SECRET: "real_client_secret",
      PUBLIC_WEBHOOK_URL: "https://app.example.com",
      PREVIEW_BASE_DOMAIN: "previews.example.com",
      METRICS_TOKEN: "prom-token"
    };

    const requiredTableRows = [
      "User",
      "Project",
      "Preview",
      "Build",
      "PreviewMetric",
      "WebhookDelivery",
      "PortAllocation",
      "AuditLog"
    ].map((table_name) => ({ table_name }));

    const healthyClient = {
      $queryRaw: async (strings) => {
        const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
        if (sql.includes("information_schema.tables")) return requiredTableRows;
        return [{ "?column?": 1 }];
      }
    };

    const mockDockerExec = async (_bin, args) => {
      if (args[0] === "info") return { err: null, stdout: "27.3.1", stderr: "" };
      return { err: null, stdout: "", stderr: "" };
    };

    const okReport = await runPreflightChecks({
      env: validEnv,
      client: healthyClient,
      dockerExec: mockDockerExec
    });
    assert.equal(okReport.passed, true);
    assert.equal(okReport.checks.config.passed, true);
    assert.equal(okReport.checks.database.passed, true);
    assert.equal(okReport.checks.docker.passed, true);
    assert.equal(okReport.warnings.length, 0);

    // Missing table or weak secret fails cleanly
    const badReport = await runPreflightChecks({
      env: { ...validEnv, JWT_SECRET: "weak" },
      client: {
        $queryRaw: async (strings) => {
          const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
          if (sql.includes("information_schema.tables")) return [{ table_name: "User" }];
          return [{ "?column?": 1 }];
        }
      },
      dockerExec: async () => ({ err: new Error("Cannot connect to Docker daemon"), stdout: "", stderr: "" })
    });
    assert.equal(badReport.passed, false);
    assert.equal(badReport.checks.config.passed, false);
    assert.equal(badReport.checks.database.passed, false);
    assert.equal(badReport.checks.docker.passed, false);
  });

  test("production Dockerfiles, Compose topology, Nginx proxy, and env templates pass structural validation", () => {
    const backendDockerfile = fs.readFileSync(path.join(repoRoot, "backend", "Dockerfile"), "utf8");
    const frontendDockerfile = fs.readFileSync(path.join(repoRoot, "frontend", "Dockerfile"), "utf8");
    const composeProd = fs.readFileSync(path.join(repoRoot, "docker-compose.prod.yml"), "utf8");
    const nginxProd = fs.readFileSync(path.join(repoRoot, "infra", "nginx", "previewflow.prod.conf"), "utf8");
    const envExample = fs.readFileSync(path.join(repoRoot, "backend", ".env.example"), "utf8");

    assert.match(backendDockerfile, /HEALTHCHECK/);
    assert.match(backendDockerfile, /npm ci --omit=dev/);
    assert.match(frontendDockerfile, /FROM nginx:/);
    assert.match(frontendDockerfile, /HEALTHCHECK/);

    // Verify split API/Worker architecture & hardening options
    assert.match(composeProd, /PREVIEWFLOW_MODE:\s*api/);
    assert.match(composeProd, /PREVIEWFLOW_MODE:\s*worker/);
    assert.match(composeProd, /no-new-privileges:true/);
    assert.match(composeProd, /condition:\s*service_healthy/);

    // Verify TLS, WebSockets, /metrics protection, and wildcard preview resolver in Nginx config
    assert.match(nginxProd, /ssl_protocols\s+TLSv1\.2\s+TLSv1\.3/);
    assert.match(nginxProd, /Upgrade\s+\$http_upgrade/);
    assert.match(nginxProd, /auth_request\s+\/_resolve_preview/);
    assert.match(nginxProd, /location\s+=\s+\/metrics/);

    // Verify .env.example documents critical Phase 3 secrets cleanly
    for (const key of [
      "JWT_SECRET=",
      "ENCRYPTION_KEY=",
      "PREVIEW_BASE_DOMAIN=",
      "TRUST_PROXY=",
      "BACKUP_DIR="
    ]) {
      assert.ok(envExample.includes(key), `Missing ${key} in backend/.env.example`);
    }
  });
});
