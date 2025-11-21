// src/services/dockerService.js
import fs from "fs";
import path from "path";
import { exec, execSync } from "child_process";
import net from "net";
import { prisma } from "../db.js";
import { getIO } from "../socket.js";

/**
 * Execute a shell command and stream logs
 */
export function run(command, onData) {
  return new Promise((resolve, reject) => {
    const child = exec(command, { maxBuffer: 1024 * 1024 * 50 });

    child.stdout?.on("data", (d) => onData(d.toString()));
    child.stderr?.on("data", (d) => onData(d.toString()));

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}`));
    });
    child.on("error", reject);
  });
}

/**
 * Remove container if exists (force)
 */
export async function removeContainer(name) {
  return new Promise((resolve) => {
    exec(`docker rm -f ${name}`, (err) => {
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
    // Skip ports commonly reserved (optional)
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
  throw new Error("No free ports available in configured range (4000-4999)");
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
  // project may be the project record or strings repoOwner/repoName can be used
  // Keep name short: include project id prefix to ensure uniqueness across projects
  const projectIdShort = (project.id || "")
    .toString()
    .slice(0, 8); // 8 chars of cuid to keep name length reasonable

  const base = `preview-p${projectIdShort}-pr${prNumber}-b${buildNumber}`;
  // sanitize
  return base.toLowerCase().replace(/[^a-z0-9\-]/g, "-");
}

/* ===========================
   Helper: remove stale containers that match baseName
   =========================== */

/**
 * Remove container forcibly if exists.
 * Uses `docker ps -aq -f name=<name>` to find matching containers and removes them.
 */
export function removeContainerIfExists(containerName) {
  try {
    const ids = execSync(`docker ps -aq -f name=${containerName}`).toString().trim();
    if (ids) {
      // May return multiple ids if names partially match; loop lines
      const lines = ids.split(/\s+/).filter(Boolean);
      for (const id of lines) {
        try {
          execSync(`docker rm -f ${id}`);
        } catch (err) {
          // ignore individual errors, continue
          console.warn("Failed to remove container", id, err?.message || err);
        }
      }
    }
  } catch (err) {
    // Not fatal
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
 *
 * Behavior:
 *  - increments buildNumber (if necessary) and uses it in container name
 *  - finds an available host port and atomically saves it to preview record
 *  - saves containerName to preview record
 *  - on failure: frees reserved port in DB (sets port = null) and sets status = "error"
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

  // Decide buildNumber: use preview.buildNumber (already default 1).
  // For each build we will increment buildNumber in DB BEFORE launching the container,
  // so container name will contain the increment.
  const nextBuildNumber = (preview.buildNumber || 1);

  // generate deterministic container name
  const containerName = generateContainerName(project, prNumber, nextBuildNumber);

  // Remove any existing container with same name (stale)
  removeContainerIfExists(containerName);

  // Assign or revalidate port
  let assignedPort = preview.port;

  try {
    if (!assignedPort) {
      // find a free port and reserve it in DB immediately
      const freePort = await findAvailablePort(5000, 5999);

      // Save assigned port in DB (reserving it)
      await prisma.preview.update({
        where: { id: previewId },
        data: { port: freePort }
      });

      assignedPort = freePort;
    } else {
      // There is a port recorded: check if it's actually free on OS.
      const free = await isPortFree(assignedPort);
      if (!free) {
        // Port clash / bound by something else -> find another port and update DB
        const freePort = await findAvailablePort(4000, 4999);
        await prisma.preview.update({
          where: { id: previewId },
          data: { port: freePort }
        });
        assignedPort = freePort;
      }
    }

    // Persist containerName & increment buildNumber.
    // We increment buildNumber so the next rebuild gets a new container name.
    const updatedPreview = await prisma.preview.update({
      where: { id: previewId },
      data: {
        containerName,
        // increment buildNumber for the stored preview so next rebuild increments again
        buildNumber: { increment: 1 }
      }
    });

    // Build image
    const baseName = `${project.repoOwner}-${project.repoName}-pr-${prNumber}`
      .toLowerCase()
      .replace(/[^a-z0-9\-]/g, "-");

    const imageName = baseName;

    // Choose dockerfile template (existing behavior)
    const dockerfile = path.resolve("deploy-templates/vite.Dockerfile");

    push(`\n> docker build -t ${imageName} -f "${dockerfile}" "${repoPath}"\n`);
    await run(
      `docker build -t ${imageName} -f "${dockerfile}" "${repoPath}"`,
      push
    );

    // Run container mapping assignedPort to container port 80 (keep same as original)
    push(`\n> docker run -d --name ${containerName} -p ${assignedPort}:80 ${imageName}\n`);
    await run(
      `docker run -d --name ${containerName} -p ${assignedPort}:80 ${imageName}`,
      push
    );

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
    // On error: free DB port reservation (set port = null) so other builds can use it
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
