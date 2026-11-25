// backend/tests/unit/dockerService.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import http from "http";
import {
  generateContainerName,
  generateImageTag,
  resolveContainerResourceLimits,
  buildContainerLabels,
  buildRunArgs,
  removeContainer,
  removeImage,
  isValidImageReference,
  pruneStalePreviewImages,
  waitForContainerReady,
  isPortFree,
  portReservedInDB,
  findAvailablePort,
  reservePortInMemory,
  releasePortInMemory,
  getPendingAllocatedPorts,
  runCommand
} from "../../src/services/dockerService.js";
import { prisma } from "../../src/db.js";

describe("4.2 Docker Service Unit Tests", () => {
  let originalPreviewFindFirst;
  let originalPreviewFindUnique;
  let originalPreviewUpdate;

  beforeEach(() => {
    originalPreviewFindFirst = prisma.preview.findFirst;
    originalPreviewFindUnique = prisma.preview.findUnique;
    originalPreviewUpdate = prisma.preview.update;
  });

  afterEach(() => {
    prisma.preview.findFirst = originalPreviewFindFirst;
    prisma.preview.findUnique = originalPreviewFindUnique;
    prisma.preview.update = originalPreviewUpdate;
  });

  test("generateContainerName sanitizes project id, pr number, and build number", () => {
    const project = { id: "clx1234567890abcdef" };
    const name = generateContainerName(project, 42, 3);
    assert.equal(name, "preview-pclx12345-pr42-b3");

    // Test with malicious / irregular characters
    const maliciousProj = { id: "p-123;rm -rf /;$(whoami)" };
    const safeName = generateContainerName(maliciousProj, "99;reboot", "7&&exit");
    assert.match(safeName, /^[a-z0-9-]+$/);
    assert.doesNotMatch(safeName, /[;$&|`"']/);
  });

  test("generateContainerName handles missing or non-numeric pr/build numbers safely", () => {
    const fallbackName = generateContainerName(null, "invalid-pr", "invalid-build");
    assert.equal(fallbackName, "preview-p-pr1-b1");
  });

  test("isPortFree accurately returns true for available port and false for bound port", async () => {
    // 1. Check an ephemeral port bound by net.createServer
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const boundPort = server.address().port;

    try {
      const freeStatusBound = await isPortFree(boundPort);
      assert.equal(freeStatusBound, false, "Bound port must report false");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // Now after server is closed, the port should become free
    const freeStatusAfterClose = await isPortFree(boundPort);
    assert.equal(freeStatusAfterClose, true, "Closed port must report true");
  });

  test("portReservedInDB returns true when preview is found with active status", async () => {
    prisma.preview.findFirst = async ({ where }) => {
      if (where.port === 5050 && where.status?.not === "deleted") {
        return { id: "prev_active", port: 5050, status: "live" };
      }
      return null;
    };

    const reserved = await portReservedInDB(5050);
    assert.equal(reserved, true);

    const notReserved = await portReservedInDB(5051);
    assert.equal(notReserved, false);
  });

  test("findAvailablePort skips ports reserved in database and finds next free port", async () => {
    prisma.preview.findFirst = async ({ where }) => {
      // Simulate port 5200 is already reserved in DB
      if (where.port === 5200) return { id: "prev_1", port: 5200 };
      return null;
    };

    const port = await findAvailablePort(5200, 5210);
    assert.ok(port > 5200, `Allocated port ${port} must be greater than reserved 5200`);
    assert.ok(port <= 5210);

    // Cleanup in-memory reservation left by findAvailablePort
    releasePortInMemory(port);
  });

  test("findAvailablePort throws error when no ports in range are free", async () => {
    prisma.preview.findFirst = async () => ({ id: "prev_all_reserved" });

    await assert.rejects(
      async () => findAvailablePort(5900, 5902),
      (err) => {
        assert.match(err.message, /No free ports available in configured range/i);
        return true;
      }
    );
  });

  test("in-memory port reservation prevents concurrent allocation collision", async () => {
    prisma.preview.findFirst = async () => null;

    reservePortInMemory(5300);
    assert.ok(getPendingAllocatedPorts().includes(5300));

    const allocated = await findAvailablePort(5300, 5305);
    assert.notEqual(allocated, 5300);
    assert.ok(allocated >= 5301 && allocated <= 5305);

    releasePortInMemory(5300);
    releasePortInMemory(allocated);
    assert.equal(getPendingAllocatedPorts().includes(5300), false);
  });

  test("removeContainer rejects dangerous container names with command injection characters", async () => {
    const maliciousNames = [
      "test; reboot",
      "test && rm -rf /",
      "test | cat /etc/shadow",
      "`rm -rf /`",
      "$(id)",
      "preview\nrm -rf /",
      "../evil"
    ];

    for (const name of maliciousNames) {
      const result = await removeContainer(name);
      assert.equal(result, false, `Must reject command injection attempt: ${name}`);
    }
  });

  test("runCommand streams output chunks and resolves on exit code 0", async () => {
    const chunks = [];
    await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('chunk-1'); process.stdout.write('chunk-2');"],
      (chunk) => chunks.push(chunk)
    );

    assert.equal(chunks.join(""), "chunk-1chunk-2");
  });

  test("runCommand rejects with error when process returns non-zero exit code", async () => {
    const logs = [];
    await assert.rejects(
      async () => {
        await runCommand(
          process.execPath,
          ["-e", "process.stderr.write('fatal error'); process.exit(1);"],
          (chunk) => logs.push(chunk)
        );
      },
      (err) => {
        assert.match(err.message, /failed with exit code 1/i);
        return true;
      }
    );

    assert.ok(logs.some((l) => l.includes("fatal error") || l.includes("Process Error")));
  });

  test("runCommand terminates child process on timeoutMs and throws TimeoutError", async () => {
    const start = Date.now();
    await assert.rejects(
      async () => {
        await runCommand(
          process.execPath,
          ["-e", "setTimeout(() => {}, 10000);"],
          () => {},
          { timeoutMs: 80 }
        );
      },
      (err) => {
        assert.equal(err.isTimeout, true);
        assert.equal(err.name, "TimeoutError");
        assert.match(err.message, /timed out/i);
        return true;
      }
    );

    assert.ok(Date.now() - start < 3000);
  });

  test("generateImageTag formats standardized lowercase tag with short SHA", () => {
    const tag = generateImageTag(
      { repoOwner: "Acme-Org", repoName: "My_Web.App" },
      42,
      3,
      "a1b2c3d4e5f67890"
    );
    assert.equal(tag, "previewflow/acme-org-my_web.app:pr-42-b3-a1b2c3d");

    const tagNoSha = generateImageTag({ repoOwner: "Org", repoName: "App" }, 7, 1, "pr-head");
    assert.equal(tagNoSha, "previewflow/org-app:pr-7-b1");
  });

  test("resolveContainerResourceLimits scales safely by user tier", () => {
    assert.deepEqual(resolveContainerResourceLimits("FREE"), {
      memory: "512m",
      memorySwap: "512m",
      cpus: "1.0",
      pidsLimit: "100"
    });
    assert.deepEqual(resolveContainerResourceLimits("PRO"), {
      memory: "1024m",
      memorySwap: "1024m",
      cpus: "1.5",
      pidsLimit: "150"
    });
    assert.deepEqual(resolveContainerResourceLimits("ENTERPRISE"), {
      memory: "2048m",
      memorySwap: "2048m",
      cpus: "2.0",
      pidsLimit: "250"
    });
  });

  test("buildContainerLabels and buildRunArgs include required tracing labels, caps, and security options", () => {
    const labels = buildContainerLabels({
      previewId: "prev_1",
      buildId: "build_99",
      projectId: "proj_2",
      prNumber: 12,
      buildNumber: 4,
      commitSha: "deadbeef1234",
      port: 5055
    });

    const args = buildRunArgs({
      containerName: "preview-pproj_2-pr12-b4",
      assignedPort: 5055,
      containerPort: 80,
      imageName: "previewflow/acme-app:pr-12-b4-deadbee",
      tier: "PRO",
      labels
    });

    assert.ok(args.includes("previewflow.managed=true"));
    assert.ok(args.includes("previewflow.previewId=prev_1"));
    assert.ok(args.includes("previewflow.buildId=build_99"));
    assert.ok(args.includes("previewflow.commitSha=deadbeef1234"));
    assert.ok(args.includes("--memory"));
    assert.ok(args.includes("1024m"));
    assert.ok(args.includes("--cap-add"));
    assert.ok(args.includes("NET_BIND_SERVICE"));
    assert.ok(args.includes("127.0.0.1:5055:80"));
  });

  test("waitForContainerReady resolves once HTTP endpoint starts responding", async () => {
    let probeReady = false;
    const server = http.createServer((req, res) => {
      if (!probeReady) {
        res.destroy();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    setTimeout(() => {
      probeReady = true;
    }, 60);

    try {
      const res = await waitForContainerReady({
        port,
        containerName: "preview-ready-test",
        timeoutMs: 2000,
        intervalMs: 30,
        inspectFn: async () => ({ status: "running", running: true, exitCode: 0 })
      });

      assert.equal(res.ready, true);
      assert.equal(res.status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("waitForContainerReady fails fast if container exits prematurely", async () => {
    await assert.rejects(
      async () => {
        await waitForContainerReady({
          port: 5999,
          containerName: "preview-crashed-test",
          timeoutMs: 5000,
          intervalMs: 50,
          inspectFn: async () => ({ status: "exited", running: false, exitCode: 137 }),
          probeFn: async () => ({ ok: false })
        });
      },
      (err) => {
        assert.match(err.message, /exited unexpectedly.*exit code 137/i);
        return true;
      }
    );
  });

  test("waitForContainerReady throws TimeoutError when container never responds", async () => {
    await assert.rejects(
      async () => {
        await waitForContainerReady({
          port: 5998,
          containerName: "preview-timeout-test",
          timeoutMs: 80,
          intervalMs: 20,
          inspectFn: async () => ({ status: "running", running: true, exitCode: 0 }),
          probeFn: async () => ({ ok: false, error: "ECONNREFUSED" })
        });
      },
      (err) => {
        assert.equal(err.isTimeout, true);
        assert.equal(err.name, "TimeoutError");
        assert.match(err.message, /timed out/i);
        return true;
      }
    );
  });

  test("removeImage validates references and pruneStalePreviewImages skips active or recent images", async () => {
    assert.equal(isValidImageReference("previewflow/org-app:pr-1-b1"), true);
    assert.equal(isValidImageReference("img; rm -rf /"), false);
    assert.equal(await removeImage("img && whoami"), false);

    const oldDate = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const removedCalls = [];

    const result = await pruneStalePreviewImages({
      maxAgeHours: 168,
      activeImageTags: new Set(["previewflow/org-app:pr-1-b1-active"]),
      execFn: async (bin, args) => {
        if (args[0] === "images") {
          return {
            err: null,
            stdout: [
              `previewflow/org-app:pr-1-b1-active|${oldDate}`,
              `previewflow/org-app:pr-2-b1-stale|${oldDate}`,
              `previewflow/org-app:pr-3-b1-fresh|${recentDate}`
            ].join("\n")
          };
        }
        if (args[0] === "rmi") {
          removedCalls.push(args[2]);
          return { err: null, stdout: "" };
        }
        return { err: null, stdout: "" };
      }
    });

    assert.deepEqual(result.removedImages, ["previewflow/org-app:pr-2-b1-stale"]);
    assert.deepEqual(removedCalls, ["previewflow/org-app:pr-2-b1-stale"]);
    assert.equal(result.skippedCount, 2);
  });
});
