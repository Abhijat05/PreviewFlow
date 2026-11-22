// backend/tests/unit/dockerService.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import {
  generateContainerName,
  removeContainer,
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
});
