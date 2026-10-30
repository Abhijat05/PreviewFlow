// src/services/dockerService.js
import fs from "fs";
import path from "path";
import { spawn, execFile, execFileSync } from "child_process";
import net from "net";
import { prisma } from "../db.js";
import { getIO } from "../socket.js";
import { resolveProjectConfig } from "./detectProjectType.js";

/**
 * Execute a command safely via spawn without shell expansion, streaming logs
 */
export function runCommand(executable, args = [], onData) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    child.stdout?.on("data", (d) => onData?.(d.toString()));
    child.stderr?.on("data", (d) => onData?.(d.toString()));

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command '${executable} ${args.join(" ")}' failed with exit code ${code}`));
    });

    child.on("error", reject);
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

    execFile("docker", ["rm", "-f", name], (err) => {
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

/**
 * Find first available port in range [minPort, maxPort].
 * It checks:
 *  - DB (no other preview currently claims it with status != deleted)
 *  - OS binding (port actually free)
 *
 * This function performs sequential checks; because we immediately record
 * the assigned port into the preview record (see build flow), this is
 * reasonably safe for single-instance deployments. For multi-instance,
 * use a central lock (Redis/DB advisory lock).
 */
export async function findAvailablePort(minPort = 5000, maxPort = 5999) {
  for (let port = minPort; port <= maxPort; port++) {
    // Check DB first (cheap)
    const reserved = await portReservedInDB(port);
    if (reserved) continue;

    // Check OS-level binding
    /* eslint-disable no-await-in-loop */
    const free = await isPortFree(port);
    if (!free) continue;

    // Port appears free — double-check DB again (race window minimal)
    const reserved2 = await portReservedInDB(port);
    if (reserved2) continue;

    return port;
  }
  throw new Error("No free ports available in configured range (5000-5999)");
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

    const output = execFileSync("docker", ["ps", "-aq", "-f", `name=${containerName}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();

    if (output) {
      const ids = output.split(/\s+/).filter((id) => /^[a-zA-Z0-9]+$/.test(id));
      for (const id of ids) {
        try {
          execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
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
 */
export async function buildPreview({ project, previewId, repoPath, prNumber }) {
  let logs = "";
  const push = (chunk) => {
    logs += chunk;
    try {
      getIO().to(previewId).emit("log", { chunk });
    } catch (e) {
      // ignore socket errors
    }
  };

  // MARK BUILD START
  const buildStartedAt = new Date();
  await prisma.preview.update({
    where: { id: previewId },
    data: {
      status: "building",
      buildStartedAt
    }
  });

  // Load preview to get current buildNumber and port (if any)
  const preview = await prisma.preview.findUnique({ where: { id: previewId } });
  if (!preview) throw new Error("Preview row not found: " + previewId);

  const nextBuildNumber = preview.buildNumber || 1;

  // generate deterministic container name
  const containerName = generateContainerName(project, prNumber, nextBuildNumber);

  // Remove any existing container with same name (stale)
  removeContainerIfExists(containerName);

  // Assign or revalidate port
  let assignedPort = preview.port;

  try {
    if (!assignedPort) {
      const freePort = await findAvailablePort(5000, 5999);

      await prisma.preview.update({
        where: { id: previewId },
        data: { port: freePort }
      });

      assignedPort = freePort;
    } else {
      const free = await isPortFree(assignedPort);
      if (!free) {
        const freePort = await findAvailablePort(5000, 5999);
        await prisma.preview.update({
          where: { id: previewId },
          data: { port: freePort }
        });
        assignedPort = freePort;
      }
    }

    await prisma.preview.update({
      where: { id: previewId },
      data: {
        containerName,
        buildNumber: { increment: 1 }
      }
    });

    // Build image name sanitized
    const safeOwner = String(project.repoOwner || "").replace(/[^a-zA-Z0-9_.-]/g, "-");
    const safeRepo = String(project.repoName || "").replace(/[^a-zA-Z0-9_.-]/g, "-");
    const safePr = String(prNumber).replace(/[^0-9]/g, "");
    const imageName = `${safeOwner}-${safeRepo}-pr-${safePr}`.toLowerCase();

    // Detect project framework & configuration dynamically
    const projectConfig = resolveProjectConfig(repoPath);
    push(`\n[Detector] Identified project type as: ${projectConfig.type} (Internal Port: ${projectConfig.containerPort})\n`);

    const dockerfile = projectConfig.dockerfile;
    const containerPort = projectConfig.containerPort;

    // Secure build execution via spawn
    const buildArgs = ["build", "-t", imageName, "-f", dockerfile, repoPath];
    push(`\n> docker ${buildArgs.join(" ")}\n`);
    await runCommand("docker", buildArgs, push);

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
      "-p", `127.0.0.1:${assignedPort}:${containerPort}`,
      imageName
    ];
    push(`\n> docker ${runArgs.join(" ")}\n`);
    await runCommand("docker", runArgs, push);

    // Build completed
    const url = `http://localhost:${assignedPort}`;
    const buildCompletedAt = new Date();

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
  } catch (err) {
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

    throw err;
  }
}
