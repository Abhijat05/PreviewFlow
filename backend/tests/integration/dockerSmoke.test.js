// backend/tests/integration/dockerSmoke.test.js
import { test, describe, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { prisma } from "../../src/db.js";
import { mockPrisma } from "../helpers/prismaMock.js";
import {
  buildPreview,
  getDockerExecutable,
  removeContainer,
  removeImage
} from "../../src/services/dockerService.js";
import { releasePort } from "../../src/services/portService.js";

describe("Docker Engine Container Smoke Test", () => {
  let dockerAvailable = false;
  let prismaRestore;
  const createdTempDirs = [];
  const containersToClean = [];
  const imagesToClean = [];
  const portsToRelease = [];

  before(() => {
    try {
      const dockerBin = getDockerExecutable();
      execFileSync(dockerBin, ["info", "--format", "{{.ServerVersion}}"], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 4000
      });
      dockerAvailable = true;
    } catch {
      console.warn("ℹ️ [Docker Smoke Notice] Docker daemon is not running on this host. Skipping live container smoke test.");
      dockerAvailable = false;
    }
  });

  afterEach(async () => {
    for (const name of containersToClean.splice(0)) {
      await removeContainer(name).catch(() => {});
    }
    for (const img of imagesToClean.splice(0)) {
      await removeImage(img, { force: true }).catch(() => {});
    }
    for (const p of portsToRelease.splice(0)) {
      await releasePort({ port: p }).catch(() => {});
    }
    for (const d of createdTempDirs.splice(0)) {
      try {
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    if (prismaRestore) {
      prismaRestore();
      prismaRestore = null;
    }
  });

  test("builds, launches, health-checks, inspects labels, and cleans up a real container", async (t) => {
    if (!dockerAvailable) {
      t.skip("Docker daemon is not available in current environment");
      return;
    }

    const { restore } = mockPrisma();
    prismaRestore = restore;

    const previewId = "prev_smoke_real_1";
    const mockPreview = {
      id: previewId,
      projectId: "proj_smoke_1",
      prNumber: 9999,
      buildNumber: 1,
      status: "building",
      port: null
    };

    prisma.preview.findUnique = async () => mockPreview;
    prisma.preview.findFirst = async () => null;
    prisma.preview.findMany = async () => [];
    prisma.portAllocation.findMany = async () => [];
    prisma.portAllocation.findUnique = async () => null;
    prisma.portAllocation.create = async ({ data }) => data;

    // Create minimal static app fixture so static.Dockerfile builds cleanly
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-docker-smoke-"));
    createdTempDirs.push(repoDir);
    fs.writeFileSync(
      path.join(repoDir, "index.html"),
      "<!doctype html><html><body><h1>PreviewFlow Smoke OK</h1></body></html>"
    );

    const project = {
      id: "proj_smoke_1",
      userId: "user_smoke_1",
      repoOwner: "previewflow",
      repoName: "smoke-fixture",
      user: { id: "user_smoke_1", tier: "PRO" }
    };

    const result = await buildPreview({
      project,
      previewId,
      repoPath: repoDir,
      prNumber: 9999,
      buildNumber: 1,
      buildId: "build_smoke_1",
      commitSha: "abc1234deadbeef",
      buildTimeoutMs: 120_000,
      runTimeoutMs: 30_000,
      readyTimeoutMs: 25_000,
      managedByOrchestrator: true
    });

    containersToClean.push(result.containerName);
    imagesToClean.push(result.imageName);
    portsToRelease.push(result.port);

    assert.ok(result.url.startsWith("http://localhost:"));
    assert.ok(result.port >= 5000 && result.port <= 5400);

    // Verify container actually serves HTTP 200 on assigned loopback port
    const httpRes = await fetch(result.url);
    assert.equal(httpRes.status, 200);
    const body = await httpRes.text();
    assert.match(body, /PreviewFlow Smoke OK/);

    // Verify tracing labels and resource caps via docker inspect
    const dockerBin = getDockerExecutable();
    const inspectedRaw = execFileSync(
      dockerBin,
      [
        "inspect",
        "-f",
        '{{index .Config.Labels "previewflow.managed"}}|{{index .Config.Labels "previewflow.commitSha"}}|{{.HostConfig.Memory}}',
        result.containerName
      ],
      { encoding: "utf8" }
    ).trim();

    const [managedLabel, shaLabel, memLimit] = inspectedRaw.split("|");
    assert.equal(managedLabel, "true");
    assert.equal(shaLabel, "abc1234deadbeef");
    assert.ok(Number(memLimit) > 0, "Container memory limit must be enforced");
  });
});
