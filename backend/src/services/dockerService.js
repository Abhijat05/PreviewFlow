// src/services/dockerService.js
import fs from "fs";
import path from "path";
import { spawn, execFile, execFileSync } from "child_process";
import net from "net";
import { prisma } from "../db.js";
import { getIO } from "../socket.js";
import { resolveProjectConfig } from "./detectProjectType.js";
import { getPortPoolForTier } from "../middleware/subscription.js";

// Ensure common Windows Docker directories are present in process.env.PATH
if (process.platform === "win32") {
  const commonDockerDirs = [
    "D:\\Docker\\Docker\\resources\\bin",
    "C:\\Program Files\\Docker\\Docker\\resources\\bin",
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Docker\\Docker\\resources\\bin"),
    path.join(process.env.LOCALAPPDATA || "", "Docker\\resources\\bin")
  ];
  const currentPath = process.env.PATH || process.env.Path || "";
  for (const dir of commonDockerDirs) {
    if (fs.existsSync(dir) && !currentPath.includes(dir)) {
      process.env.PATH = `${dir};${process.env.PATH}`;
    }
  }
}

/**
 * Resolves the Docker CLI executable path across platforms
 */
export function getDockerExecutable() {
  if (process.env.DOCKER_BIN && fs.existsSync(process.env.DOCKER_BIN)) {
    return process.env.DOCKER_BIN;
  }

  if (process.platform === "win32") {
    const candidates = [
      "D:\\Docker\\Docker\\resources\\bin\\docker.exe",
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Docker\\Docker\\resources\\bin\\docker.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Docker\\resources\\bin\\docker.exe")
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }

  return "docker";
}

/**
 * Creates a standardized AbortError instance for cooperative build cancellation.
 */
function createAbortError(message = "Docker operation aborted") {
  const err = new Error(message);
  err.name = "AbortError";
  err.isAborted = true;
  return err;
}

/**
 * Execute a command safely via spawn without shell expansion, streaming logs.
 * Supports cooperative termination via an optional AbortSignal.
 */
export function runCommand(executable, args = [], onData, options = {}) {
  const resolvedBin = executable === "docker" ? getDockerExecutable() : executable;
  const { abortSignal } = options || {};

  if (abortSignal?.aborted) {
    return Promise.reject(createAbortError(`Command '${executable}' aborted before start`));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(resolvedBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: process.env
    });

    let settled = false;
    let aborted = false;
    let killTimer = null;

    const cleanup = () => {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const onAbort = () => {
      if (settled) return;
      aborted = true;
      onData?.(`\n[Build Aborted] Stopping '${executable}' process...\n`);
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore if already exited
      }
      killTimer = setTimeout(() => {
        try {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        } catch {
          // ignore
        }
      }, 2000);
      if (killTimer.unref) killTimer.unref();
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (d) => onData?.(d.toString()));
    child.stderr?.on("data", (d) => onData?.(d.toString()));

    child.on("close", (code) => {
      cleanup();
      if (settled) return;
      settled = true;

      if (aborted || abortSignal?.aborted) {
        return reject(createAbortError(`Command '${executable}' aborted`));
      }

      if (code === 0) {
        resolve();
      } else {
        const errorMsg = `Command '${executable} ${args.join(" ")}' failed with exit code ${code}`;
        onData?.(`\n[Process Error] ${errorMsg}\n`);
        reject(new Error(errorMsg));
      }
    });

    child.on("error", (err) => {
      cleanup();
      if (settled) return;
      settled = true;

      if (aborted || abortSignal?.aborted) {
        return reject(createAbortError(`Command '${executable}' aborted`));
      }
      onData?.(`\n[Process Error] Failed to execute '${executable}': ${err.message}\n`);
      reject(err);
    });
  });
}

/**
 * Legacy shell runner maintained for backward compatibility.
 * Splits arguments when possible or uses runCommand.
 */
export function run(command, onData) {
  return new Promise((resolve, reject) => {
    // If command starts with docker, parse args safely
    if (typeof command === "string") {
      const parts = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      const cleanParts = parts.map((p) => p.replace(/^["']|["']$/g, ""));
      if (cleanParts.length > 0) {
        const [bin, ...args] = cleanParts;
        return runCommand(bin, args, onData).then(resolve).catch(reject);
      }
    }
    reject(new Error("Invalid command provided to run()"));
  });
}

/**
 * Remove container if exists (force) safely without shell injection
 */
export async function removeContainer(name) {
  return new Promise((resolve) => {
    // Strict validation: Docker container names must only contain alphanumeric, underscore, dot, or hyphen
    if (!name || typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name)) {
      return resolve(false);
    }

    const dockerBin = getDockerExecutable();
    execFile(dockerBin, ["rm", "-f", name], (err) => {
      resolve(!err);
    });
  });
}

/* ===========================
   Port allocation utilities
   =========================== */

/**
 * Check if a TCP port is free on localhost.
 * Resolves true if free, false if bound.
 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once("error", () => {
        resolve(false);
      })
      .once("listening", () => {
        tester.close(() => resolve(true));
      })
      .listen(port, "127.0.0.1");
    // Safety: if can't bind, 'error' will fire
  });
}

/**
 * Determine if a port is reserved in DB for a non-deleted preview.
 * Returns true if the port is currently assigned in DB to a preview
 * whose status is not "deleted".
 */
export async function portReservedInDB(port) {
  const existing = await prisma.preview.findFirst({
    where: { port, status: { not: "deleted" } }
  });
  return !!existing;
}

// In-memory set of ports currently being allocated by in-flight processes
const pendingAllocatedPorts = new Set();
let allocationMutex = Promise.resolve();

function acquirePortLock() {
  let release;
  const nextLock = new Promise((resolve) => {
    release = resolve;
  });
  const currentLock = allocationMutex;
  allocationMutex = currentLock.then(() => nextLock);
  return currentLock.then(() => release);
}

export function reservePortInMemory(port) {
  pendingAllocatedPorts.add(port);
}

export function releasePortInMemory(port) {
  pendingAllocatedPorts.delete(port);
}

export function getPendingAllocatedPorts() {
  return Array.from(pendingAllocatedPorts);
}

/**
 * Find first available port in range [minPort, maxPort].
 * It checks:
 *  - Mutex lock & pending memory reservation (eliminates TOCTOU race condition between concurrent requests)
 *  - DB (no other preview currently claims it with status != deleted)
 *  - OS binding (port actually free)
 */
export async function findAvailablePort(minPort = 5000, maxPort = 5999) {
  const unlock = await acquirePortLock();
  try {
    for (let port = minPort; port <= maxPort; port++) {
      if (pendingAllocatedPorts.has(port)) continue;

      const reserved = await portReservedInDB(port);
      if (reserved) continue;

      /* eslint-disable no-await-in-loop */
      const free = await isPortFree(port);
      if (!free) continue;

      const reserved2 = await portReservedInDB(port);
      if (reserved2) continue;

      // Mark as pending allocation until database commit completes
      pendingAllocatedPorts.add(port);
      return port;
    }
    throw new Error(`No free ports available in configured range (${minPort}-${maxPort})`);
  } finally {
    unlock();
  }
}

/* ===========================
   Container naming utility
   =========================== */

/**
 * Generate deterministic container name.
 * Example: preview-p<projectId>-pr<prNumber>-b<buildNumber>
 *
 * We sanitize to lowercase and only allow alphanumerics and hyphens.
 */
export function generateContainerName(project, prNumber, buildNumber) {
  const projectIdShort = (project?.id || "")
    .toString()
    .slice(0, 8)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  const safePrNumber = String(prNumber).replace(/[^0-9]/g, "") || "1";
  const safeBuildNumber = String(buildNumber).replace(/[^0-9]/g, "") || "1";

  const base = `preview-p${projectIdShort}-pr${safePrNumber}-b${safeBuildNumber}`;
  return base.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/* ===========================
   Helper: remove stale containers that match baseName
   =========================== */

/**
 * Remove container forcibly if exists.
 * Uses `docker ps -aq -f name=<name>` safely without shell interpolation.
 */
export function removeContainerIfExists(containerName) {
  try {
    if (!containerName || typeof containerName !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(containerName)) {
      return;
    }

    const dockerBin = getDockerExecutable();
    const output = execFileSync(dockerBin, ["ps", "-aq", "-f", `name=${containerName}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();

    if (output) {
      const ids = output.split(/\s+/).filter((id) => /^[a-zA-Z0-9]+$/.test(id));
      for (const id of ids) {
        try {
          execFileSync(dockerBin, ["rm", "-f", id], { stdio: "ignore" });
        } catch (err) {
          console.warn("Failed to remove container", id, err?.message || err);
        }
      }
    }
  } catch (err) {
    console.warn("Error checking/removing container", err?.message || err);
  }
}

/* ===========================
   Main buildPreview flow (safe)
   =========================== */

/**
 * buildPreview - builds a Docker image and runs a container for a preview
 *
 * Inputs:
 *   - project: Project record (must include at least id, repoOwner, repoName)
 *   - previewId: Prisma preview.id
 *   - repoPath: local path to cloned repo
 *   - prNumber: PR number
 *   - buildNumber: optional explicit build number (provided by buildOrchestrator)
 *   - abortSignal: optional AbortSignal for cooperative cancellation
 *   - managedByOrchestrator: when true, returns metadata without mutating Preview directly
 */
export async function buildPreview({
  project,
  previewId,
  repoPath,
  prNumber,
  buildNumber,
  abortSignal,
  managedByOrchestrator = false
}) {
  if (abortSignal?.aborted) {
    throw createAbortError("Build aborted before Docker execution");
  }

  let logs = "";
  const push = (chunk) => {
    logs += chunk;
    try {
      getIO().to(previewId).emit("log", { chunk });
    } catch (e) {
      // ignore socket errors
    }
  };

  // MARK BUILD START (for direct/legacy non-orchestrated calls)
  const buildStartedAt = new Date();
  if (!managedByOrchestrator) {
    await prisma.preview.update({
      where: { id: previewId },
      data: {
        status: "building",
        buildStartedAt
      }
    });
  }

  // Load preview to get current buildNumber and port (if any)
  const preview = await prisma.preview.findUnique({ where: { id: previewId } });
  if (!preview) throw new Error("Preview row not found: " + previewId);

  const nextBuildNumber = buildNumber || preview.buildNumber || 1;

  // generate deterministic container name
  const containerName = generateContainerName(project, prNumber, nextBuildNumber);

  // Remove any existing container with same name (stale)
  removeContainerIfExists(containerName);

  // Assign or revalidate port
  let assignedPort = preview.port;
  let newlyAllocatedPort = null;
  let containerStarted = false;
  const pool = getPortPoolForTier(project?.user?.tier);
  const minPort = pool?.min || 5000;
  const maxPort = pool?.max || 5999;

  try {
    if (!assignedPort) {
      const freePort = await findAvailablePort(minPort, maxPort);
      newlyAllocatedPort = freePort;

      if (!managedByOrchestrator) {
        try {
          await prisma.preview.update({
            where: { id: previewId },
            data: { port: freePort }
          });
        } finally {
          releasePortInMemory(freePort);
          newlyAllocatedPort = null;
        }
      }

      assignedPort = freePort;
    } else {
      const free = await isPortFree(assignedPort);
      if (!free) {
        const freePort = await findAvailablePort(minPort, maxPort);
        newlyAllocatedPort = freePort;

        if (!managedByOrchestrator) {
          try {
            await prisma.preview.update({
              where: { id: previewId },
              data: { port: freePort }
            });
          } finally {
            releasePortInMemory(freePort);
            newlyAllocatedPort = null;
          }
        }
        assignedPort = freePort;
      }
    }

    if (!managedByOrchestrator) {
      await prisma.preview.update({
        where: { id: previewId },
        data: {
          containerName,
          buildNumber: { increment: 1 }
        }
      });
    }

    // Build image name sanitized
    const safeOwner = String(project.repoOwner || "").replace(/[^a-zA-Z0-9_.-]/g, "-");
    const safeRepo = String(project.repoName || "").replace(/[^a-zA-Z0-9_.-]/g, "-");
    const safePr = String(prNumber).replace(/[^0-9]/g, "");
    const imageName = `${safeOwner}-${safeRepo}-pr-${safePr}:b${nextBuildNumber}`.toLowerCase();

    // Detect project framework & configuration dynamically
    const projectConfig = resolveProjectConfig(repoPath);
    push(`\n[Detector] Identified project type as: ${projectConfig.type} (Internal Port: ${projectConfig.containerPort})\n`);

    const dockerfile = projectConfig.dockerfile;
    const containerPort = projectConfig.containerPort;

    // Secure build execution via spawn
    const buildArgs = ["build", "-t", imageName, "-f", dockerfile, repoPath];
    push(`\n> docker ${buildArgs.join(" ")}\n`);
    await runCommand("docker", buildArgs, push, { abortSignal });

    if (abortSignal?.aborted) {
      throw createAbortError("Build aborted after image build");
    }

    // Secure run execution with resource limits & safe port binding to localhost
    const runArgs = [
      "run",
      "-d",
      "--name", containerName,
      "--pids-limit", "100",
      "--memory", "512m",
      "--cpus", "1.0",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--cap-add", "CHOWN",
      "--cap-add", "SETUID",
      "--cap-add", "SETGID",
      "--cap-add", "NET_BIND_SERVICE",
      "-p", `127.0.0.1:${assignedPort}:${containerPort}`,
      imageName
    ];
    push(`\n> docker ${runArgs.join(" ")}\n`);
    await runCommand("docker", runArgs, push, { abortSignal });
    containerStarted = true;

    const url = `http://localhost:${assignedPort}`;
    const buildCompletedAt = new Date();

    if (!managedByOrchestrator) {
      await prisma.preview.update({
        where: { id: previewId },
        data: {
          status: "live",
          url,
          buildLogs: logs,
          buildCompletedAt
        }
      });

      try {
        getIO().to(previewId).emit("log-finish", { url });
      } catch (e) { /* ignore */ }

      return url;
    }

    try {
      getIO().to(previewId).emit("log-finish", { url });
    } catch (e) { /* ignore */ }

    return {
      url,
      containerName,
      port: assignedPort,
      imageName,
      logs
    };
  } catch (err) {
    if (containerStarted) {
      await removeContainer(containerName).catch(() => {});
    }
    if (newlyAllocatedPort) {
      releasePortInMemory(newlyAllocatedPort);
    }

    if (err && typeof err === "object") {
      err.buildLogs = logs + "\n\nERROR:\n" + (err?.message || String(err));
    }

    if (!managedByOrchestrator) {
      try {
        await prisma.preview.update({
          where: { id: previewId },
          data: {
            status: "error",
            buildLogs: logs + "\n\nERROR:\n" + (err?.message || String(err)),
            buildCompletedAt: new Date(),
            port: null
          }
        });
      } catch (e) {
        console.error("Failed to mark preview error & free port:", e?.message || e);
      }

      try { getIO().to(previewId).emit("log-error", { message: err.message }); } catch (e) { /* ignore */ }
    }

    throw err;
  }
}
