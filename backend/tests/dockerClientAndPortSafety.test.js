import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDockerOptions, createDockerClient } from "../src/services/dockerClient.js";
import {
  findAvailablePort,
  reservePortInMemory,
  releasePortInMemory,
  getPendingAllocatedPorts,
  isPortFree
} from "../src/services/dockerService.js";
import { prisma } from "../src/db.js";

describe("Docker Client Configuration & Port TOCTOU Safety", () => {
  const envSnapshot = { ...process.env };

  afterEach(() => {
    // Restore env vars
    for (const key of ["DOCKER_SOCKET_PATH", "DOCKER_HOST", "DOCKER_PORT"]) {
      if (envSnapshot[key] !== undefined) {
        process.env[key] = envSnapshot[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test("getDockerOptions prioritizes DOCKER_SOCKET_PATH override", () => {
    process.env.DOCKER_SOCKET_PATH = "/var/run/custom-docker.sock";
    const opts = getDockerOptions();
    assert.deepEqual(opts, { socketPath: "/var/run/custom-docker.sock" });
  });

  test("getDockerOptions correctly parses TCP DOCKER_HOST with port", () => {
    delete process.env.DOCKER_SOCKET_PATH;
    process.env.DOCKER_HOST = "tcp://192.168.1.100:2376";
    const opts = getDockerOptions();
    assert.deepEqual(opts, { host: "192.168.1.100", port: 2376 });
  });

  test("getDockerOptions correctly parses unix:// and npipe:// DOCKER_HOST", () => {
    delete process.env.DOCKER_SOCKET_PATH;
    process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
    assert.deepEqual(getDockerOptions(), { socketPath: "/var/run/docker.sock" });

    process.env.DOCKER_HOST = "npipe:////./pipe/docker_engine";
    assert.deepEqual(getDockerOptions(), { socketPath: "//./pipe/docker_engine" });
  });

  test("getDockerOptions correctly handles DOCKER_PORT override", () => {
    delete process.env.DOCKER_SOCKET_PATH;
    delete process.env.DOCKER_HOST;
    process.env.DOCKER_PORT = "4243";
    const opts = getDockerOptions();
    assert.deepEqual(opts, { host: "127.0.0.1", port: 4243 });
  });

  test("getDockerOptions defaults to named pipe on Windows or unix socket on POSIX", () => {
    delete process.env.DOCKER_SOCKET_PATH;
    delete process.env.DOCKER_HOST;
    delete process.env.DOCKER_PORT;

    const opts = getDockerOptions();
    if (process.platform === "win32") {
      assert.deepEqual(opts, { socketPath: "//./pipe/docker_engine" });
    } else {
      assert.deepEqual(opts, { socketPath: "/var/run/docker.sock" });
    }
  });

  test("findAvailablePort skips ports currently in pendingAllocatedPorts", async () => {
    const originalFindFirst = prisma.preview.findFirst;
    try {
      // Mock DB: no ports reserved in DB
      prisma.preview.findFirst = async () => null;

      // Reserve port 5100 in memory
      reservePortInMemory(5100);
      assert.ok(getPendingAllocatedPorts().includes(5100));

      // Find available port in range 5100-5105
      const allocated = await findAvailablePort(5100, 5105);
      // Because 5100 is reserved in memory, it must have skipped 5100 and chosen 5101 (or higher)
      assert.notEqual(allocated, 5100);
      assert.ok(allocated >= 5101 && allocated <= 5105);

      // Clean up in-memory reservation
      releasePortInMemory(5100);
      releasePortInMemory(allocated);
    } finally {
      prisma.preview.findFirst = originalFindFirst;
    }
  });

  test("concurrent calls to findAvailablePort allocate distinct ports without collision", async () => {
    const originalFindFirst = prisma.preview.findFirst;
    try {
      prisma.preview.findFirst = async () => null;

      // Execute 3 concurrent calls
      const [portA, portB, portC] = await Promise.all([
        findAvailablePort(5200, 5210),
        findAvailablePort(5200, 5210),
        findAvailablePort(5200, 5210)
      ]);

      const portSet = new Set([portA, portB, portC]);
      assert.equal(portSet.size, 3, "All concurrently allocated ports must be distinct");

      // Release memory reservations
      releasePortInMemory(portA);
      releasePortInMemory(portB);
      releasePortInMemory(portC);
    } finally {
      prisma.preview.findFirst = originalFindFirst;
    }
  });
});
