// src/services/dockerService.js
import fs from "fs";
import path from "path";
import { spawn, execFile, execFileSync } from "child_process";
import { prisma } from "../db.js";
import { getIO } from "../socket.js";
import { resolveProjectConfig } from "./detectProjectType.js";
import { getPortPoolForTier } from "../middleware/subscription.js";
import { normalizeTier } from "../middleware/tierLimits.js";
import {
  isPortFree,
  portReservedInDB,
  reservePortInMemory,
  releasePortInMemory,
  getPendingAllocatedPorts,
  findAvailablePort,
  allocatePort,
  releasePort
} from "./portService.js";

export {
  isPortFree,
  portReservedInDB,
  reservePortInMemory,
  releasePortInMemory,
  getPendingAllocatedPorts,
  findAvailablePort
};

export const DEFAULT_DOCKER_BUILD_TIMEOUT_MS = Number(process.env.DOCKER_BUILD_TIMEOUT_MS) || 600_000;
export const DEFAULT_DOCKER_RUN_TIMEOUT_MS = Number(process.env.DOCKER_RUN_TIMEOUT_MS) || 30_000;
export const DEFAULT_CONTAINER_READY_TIMEOUT_MS = Number(process.env.CONTAINER_READY_TIMEOUT_MS) || 30_000;
export const DEFAULT_HEALTH_PROBE_INTERVAL_MS = Number(process.env.CONTAINER_HEALTH_PROBE_INTERVAL_MS) || 500;
export const DEFAULT_IMAGE_MAX_AGE_HOURS = Number(process.env.DOCKER_IMAGE_MAX_AGE_HOURS) || 168;

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
 * Resolves the Docker CLI executable path across platforms.
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

function createAbortError(message = "Docker operation aborted") {
  const err = new Error(message);
  err.name = "AbortError";
  err.isAborted = true;
  return err;
}

function createTimeoutError(message = "Docker operation timed out") {
  const err = new Error(message);
  err.name = "TimeoutError";
  err.isTimeout = true;
  return err;
}

/**
 * Execute a command safely via spawn without shell expansion, streaming logs.
 * Supports cooperative termination via AbortSignal and execution timeouts via timeoutMs.
 */
export function runCommand(executable, args = [], onData, options = {}) {
  const resolvedBin = executable === "docker" ? getDockerExecutable() : executable;
  const { abortSignal, timeoutMs = 0 } = options || {};

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
    let timedOut = false;
    let killTimer = null;
    let timeoutTimer = null;

    const cleanup = () => {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    const terminateChild = (reasonLine) => {
      onData?.(reasonLine);
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

    const onAbort = () => {
      if (settled) return;
      aborted = true;
      terminateChild(`\n[Build Aborted] Stopping '${executable}' process...\n`);
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    if (timeoutMs && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        terminateChild(`\n[Timeout Error] Command '${executable}' exceeded timeout (${timeoutMs}ms)\n`);
      }, timeoutMs);
      if (timeoutTimer.unref) timeoutTimer.unref();
    }

    child.stdout?.on("data", (d) => onData?.(d.toString()));
    child.stderr?.on("data", (d) => onData?.(d.toString()));

    child.on("close", (code) => {
      cleanup();
      if (settled) return;
      settled = true;

      if (timedOut) {
        return reject(createTimeoutError(`Command '${executable}' timed out after ${timeoutMs}ms`));
      }

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

      if (timedOut) {
        return reject(createTimeoutError(`Command '${executable}' timed out after ${timeoutMs}ms`));
      }
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
 * Validates Docker container names against shell metacharacters.
 */
export function isValidContainerName(name) {
  return Boolean(name && typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name));
}

/**
 * Validates Docker image tags against shell metacharacters.
 */
export function isValidImageReference(imageTag) {
  return Boolean(
    imageTag &&
    typeof imageTag === "string" &&
    imageTag.length <= 255 &&
    /^[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(imageTag)
  );
}

/**
 * Remove container if exists (force) safely without shell injection.
 */
export async function removeContainer(name) {
  return new Promise((resolve) => {
    if (!isValidContainerName(name)) {
      return resolve(false);
    }

    const dockerBin = getDockerExecutable();
    execFile(dockerBin, ["rm", "-f", name], (err) => {
      resolve(!err);
    });
  });
}

/**
 * Removes a Docker image safely without shell injection.
 */
export async function removeImage(imageTag, { force = false } = {}) {
  return new Promise((resolve) => {
    if (!isValidImageReference(imageTag)) {
      return resolve(false);
    }

    const dockerBin = getDockerExecutable();
    const args = force ? ["rmi", "-f", imageTag] : ["rmi", imageTag];
    execFile(dockerBin, args, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Prunes dangling Docker images to reclaim build layer disk space.
 */
export async function pruneDanglingImages() {
  return new Promise((resolve) => {
    const dockerBin = getDockerExecutable();
    execFile(dockerBin, ["image", "prune", "-f"], (err, stdout) => {
      resolve({ ok: !err, output: stdout || "" });
    });
  });
}

/**
 * Prunes PreviewFlow preview images older than maxAgeHours that are not in activeImageTags.
 */
export async function pruneStalePreviewImages({
  maxAgeHours = DEFAULT_IMAGE_MAX_AGE_HOURS,
  activeImageTags = new Set(),
  execFn = null
} = {}) {
  const runExec =
    execFn ||
    ((bin, args) =>
      new Promise((resolve) => {
        execFile(bin, args, (err, stdout) => resolve({ err, stdout: stdout || "" }));
      }));

  const dockerBin = getDockerExecutable();
  const { err, stdout } = await runExec(dockerBin, [
    "images",
    "--format",
    "{{.Repository}}:{{.Tag}}|{{.CreatedAt}}",
    "--filter",
    "reference=previewflow/*"
  ]);

  if (err || !stdout.trim()) {
    return { removedImages: [], skippedCount: 0 };
  }

  const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const removedImages = [];
  let skippedCount = 0;

  for (const line of stdout.trim().split(/\r?\n/)) {
    const [imageTag, createdAtRaw] = line.split("|");
    if (!imageTag || imageTag === "<none>:<none>" || !isValidImageReference(imageTag)) {
      continue;
    }

    if (activeImageTags.has(imageTag)) {
      skippedCount++;
      continue;
    }

    const createdMs = Date.parse(createdAtRaw || "");
    if (!Number.isNaN(createdMs) && createdMs < cutoffMs) {
      const removed = execFn
        ? await runExec(dockerBin, ["rmi", "-f", imageTag]).then((r) => !r.err)
        : await removeImage(imageTag, { force: true });
      if (removed) {
        removedImages.push(imageTag);
      }
    } else {
      skippedCount++;
    }
  }

  return { removedImages, skippedCount };
}

/**
 * Starts periodic pruning of dangling and expired PreviewFlow Docker images.
 */
export function startPeriodicDockerCleanup({
  intervalMs = 6 * 60 * 60 * 1000,
  maxAgeHours = DEFAULT_IMAGE_MAX_AGE_HOURS,
  client = prisma
} = {}) {
  const runCleanup = async () => {
    try {
      await pruneDanglingImages();

      const activeImageTags = new Set();
      try {
        const activeBuilds = await client.build.findMany({
          where: {
            OR: [{ status: "RUNNING" }, { status: "QUEUED" }, { activeForPreviews: { some: {} } }]
          },
          select: { imageTag: true }
        });
        for (const b of activeBuilds || []) {
          if (b.imageTag) activeImageTags.add(b.imageTag);
        }
      } catch {
        // DB may be unavailable or unmigrated during startup; skip active tag pruning safely
        return;
      }

      await pruneStalePreviewImages({ maxAgeHours, activeImageTags });
    } catch (err) {
      console.warn("[DockerCleanup] Periodic cleanup warning:", err?.message || err);
    }
  };

  const timer = setInterval(runCleanup, intervalMs);
  if (timer.unref) {
    timer.unref();
  }
  return timer;
}

/* ===========================
   Port utilities re-exported from portService.js
   =========================== */

/* ===========================
   Naming, labels & resource limits
   =========================== */

/**
 * Generate deterministic container name.
 * Example: preview-p<projectId>-pr<prNumber>-b<buildNumber>
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

/**
 * Generates standardized Docker image reference scoped to PreviewFlow.
 */
export function generateImageTag(project, prNumber, buildNumber = 1, commitSha = null) {
  const safeOwner = String(project?.repoOwner || "org")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/^-+|-+$/g, "") || "org";
  const safeRepo = String(project?.repoName || "app")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/^-+|-+$/g, "") || "app";
  const safePr = String(prNumber).replace(/[^0-9]/g, "") || "1";
  const safeBuild = String(buildNumber).replace(/[^0-9]/g, "") || "1";

  const cleanSha =
    commitSha && commitSha !== "pr-head" && commitSha !== "HEAD"
      ? String(commitSha).slice(0, 7).toLowerCase().replace(/[^a-z0-9]/g, "")
      : "";

  const tag = cleanSha ? `pr-${safePr}-b${safeBuild}-${cleanSha}` : `pr-${safePr}-b${safeBuild}`;
  return `previewflow/${safeOwner}-${safeRepo}:${tag}`.slice(0, 128);
}

/**
 * Resolves enforced cgroup resource limits by subscription tier.
 */
export function resolveContainerResourceLimits(tier) {
  const normalized = normalizeTier(tier);
  switch (normalized) {
    case "ENTERPRISE":
      return { memory: "2048m", memorySwap: "2048m", cpus: "2.0", pidsLimit: "250" };
    case "PRO":
      return { memory: "1024m", memorySwap: "1024m", cpus: "1.5", pidsLimit: "150" };
    case "HOBBY":
    case "FREE":
    default:
      return { memory: "512m", memorySwap: "512m", cpus: "1.0", pidsLimit: "100" };
  }
}

/**
 * Builds tracing labels attached to every managed preview container.
 */
export function buildContainerLabels({
  previewId,
  buildId,
  projectId,
  prNumber,
  buildNumber,
  commitSha,
  port
}) {
  const sanitizeVal = (v) => String(v ?? "").replace(/[^a-zA-Z0-9_.:-]/g, "");
  const pairs = [
    ["previewflow.managed", "true"],
    ["previewflow.previewId", sanitizeVal(previewId)],
    ["previewflow.projectId", sanitizeVal(projectId)],
    ["previewflow.prNumber", sanitizeVal(prNumber)],
    ["previewflow.buildNumber", sanitizeVal(buildNumber)],
    ["previewflow.port", sanitizeVal(port)],
    ["previewflow.createdAt", new Date().toISOString()]
  ];

  if (buildId) {
    pairs.push(["previewflow.buildId", sanitizeVal(buildId)]);
  }
  if (commitSha && commitSha !== "pr-head" && commitSha !== "HEAD") {
    pairs.push(["previewflow.commitSha", sanitizeVal(commitSha)]);
  }

  const labelArgs = [];
  for (const [k, v] of pairs) {
    if (v) {
      labelArgs.push("--label", `${k}=${v}`);
    }
  }
  return labelArgs;
}

/**
 * Constructs hardened `docker run` argument array with resource caps,
 * minimal capabilities, tracing labels, and loopback port binding.
 */
export function buildRunArgs({
  containerName,
  assignedPort,
  containerPort,
  imageName,
  tier,
  labels = []
}) {
  const limits = resolveContainerResourceLimits(tier);
  return [
    "run",
    "-d",
    "--name",
    containerName,
    "--pids-limit",
    limits.pidsLimit,
    "--memory",
    limits.memory,
    "--memory-swap",
    limits.memorySwap,
    "--cpus",
    limits.cpus,
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "NET_BIND_SERVICE",
    ...labels,
    "-p",
    `127.0.0.1:${assignedPort}:${containerPort}`,
    imageName
  ];
}

/* ===========================
   Container inspection, logs & health readiness probes
   =========================== */

/**
 * Inspects container execution status via Docker CLI.
 * Returns { status, running, exitCode } or null if unavailable.
 */
export async function inspectContainerState(containerName) {
  if (!isValidContainerName(containerName)) return null;

  return new Promise((resolve) => {
    const dockerBin = getDockerExecutable();
    execFile(
      dockerBin,
      ["inspect", "-f", "{{.State.Status}}|{{.State.Running}}|{{.State.ExitCode}}", containerName],
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const parts = stdout.trim().split("|");
        if (parts.length < 3) return resolve(null);
        resolve({
          status: parts[0],
          running: parts[1] === "true",
          exitCode: Number.parseInt(parts[2], 10) || 0
        });
      }
    );
  });
}

/**
 * Retrieves trailing logs from a container for crash diagnostics.
 */
export async function getContainerLogs(containerName, { tail = 50 } = {}) {
  if (!isValidContainerName(containerName)) return "";

  return new Promise((resolve) => {
    const dockerBin = getDockerExecutable();
    execFile(
      dockerBin,
      ["logs", "--tail", String(tail), containerName],
      (err, stdout, stderr) => {
        if (err) return resolve("");
        resolve(`${stdout || ""}${stderr || ""}`.trim());
      }
    );
  });
}

async function defaultHttpProbe(url) {
  const controller = new AbortController();
  const reqTimer = setTimeout(() => controller.abort(), 1500);
  if (reqTimer.unref) reqTimer.unref();

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal
    });
    return {
      ok: res.status >= 200 && res.status < 500,
      status: res.status
    };
  } catch (err) {
    return { ok: false, error: err?.message || "Connection failed" };
  } finally {
    clearTimeout(reqTimer);
  }
}

function sleepWithAbort(ms, abortSignal) {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      return reject(createAbortError("Health check aborted"));
    }

    let timer = null;

    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(createAbortError("Health check aborted"));
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
  });
}

/**
 * Actively probes the started preview container over HTTP on 127.0.0.1 until ready.
 * Fails fast if the container crashes/exits or aborts cooperatively on signal.
 */
export async function waitForContainerReady({
  port,
  containerName = null,
  timeoutMs = DEFAULT_CONTAINER_READY_TIMEOUT_MS,
  intervalMs = DEFAULT_HEALTH_PROBE_INTERVAL_MS,
  path: probePath = "/",
  abortSignal = null,
  probeFn = defaultHttpProbe,
  inspectFn = inspectContainerState
}) {
  if (!port) {
    throw new Error("Port is required for container health check");
  }

  const startTime = Date.now();
  const normalizedPath = probePath.startsWith("/") ? probePath : `/${probePath}`;
  const url = `http://127.0.0.1:${port}${normalizedPath}`;
  let lastError = "No HTTP response";

  while (Date.now() - startTime < timeoutMs) {
    if (abortSignal?.aborted) {
      throw createAbortError("Container readiness probe aborted");
    }

    if (containerName && inspectFn) {
      /* eslint-disable no-await-in-loop */
      const state = await inspectFn(containerName);
      if (state && !state.running && state.status !== "created") {
        throw new Error(
          `Container '${containerName}' exited unexpectedly with status '${state.status}' (exit code ${state.exitCode})`
        );
      }
    }

    const probeResult = await probeFn(url);
    if (probeResult?.ok) {
      return {
        ready: true,
        status: probeResult.status,
        elapsedMs: Date.now() - startTime
      };
    }

    if (probeResult?.error) {
      lastError = probeResult.error;
    } else if (probeResult?.status) {
      lastError = `HTTP ${probeResult.status}`;
    }

    const remainingMs = timeoutMs - (Date.now() - startTime);
    if (remainingMs <= 0) break;

    await sleepWithAbort(Math.min(intervalMs, remainingMs), abortSignal);
  }

  throw createTimeoutError(
    `Container health probe timed out after ${timeoutMs}ms on ${url} (${lastError})`
  );
}

/**
 * Remove container forcibly if exists.
 */
export function removeContainerIfExists(containerName) {
  try {
    if (!isValidContainerName(containerName)) {
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
   Main buildPreview flow
   =========================== */

/**
 * buildPreview - builds a Docker image, enforces timeouts & resource limits,
 * starts a labeled container, and verifies readiness via HTTP health probe.
 */
export async function buildPreview({
  project,
  previewId,
  repoPath,
  prNumber,
  buildNumber,
  buildId = null,
  commitSha = null,
  abortSignal = null,
  buildTimeoutMs = DEFAULT_DOCKER_BUILD_TIMEOUT_MS,
  runTimeoutMs = DEFAULT_DOCKER_RUN_TIMEOUT_MS,
  readyTimeoutMs = DEFAULT_CONTAINER_READY_TIMEOUT_MS,
  healthPath = "/",
  skipHealthCheck = false,
  healthChecker = waitForContainerReady,
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
    } catch {
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

  const preview = await prisma.preview.findUnique({ where: { id: previewId } });
  if (!preview) throw new Error("Preview row not found: " + previewId);

  const nextBuildNumber = buildNumber || preview.buildNumber || 1;
  const containerName = generateContainerName(project, prNumber, nextBuildNumber);

  // Remove any existing container with same name (stale)
  removeContainerIfExists(containerName);

  // Assign or revalidate port via cross-process PostgreSQL port leasing
  let assignedPort = preview.port;
  let newlyAllocatedPort = null;
  let containerStarted = false;
  const userTier = project?.user?.tier;
  const pool = getPortPoolForTier(userTier);
  const minPort = pool?.min || 5000;
  const maxPort = pool?.max || 5999;

  try {
    const portResult = await allocatePort({
      previewId,
      buildId,
      tier: userTier,
      minPort,
      maxPort,
      preferredPort: assignedPort
    });

    assignedPort = portResult.port;
    newlyAllocatedPort = assignedPort;

    if (!managedByOrchestrator) {
      try {
        await prisma.preview.update({
          where: { id: previewId },
          data: {
            port: assignedPort,
            containerName,
            buildNumber: { increment: 1 }
          }
        });
      } finally {
        releasePortInMemory(assignedPort);
        newlyAllocatedPort = null;
      }
    }

    const imageName = generateImageTag(project, prNumber, nextBuildNumber, commitSha);

    // Detect project framework & configuration dynamically
    const projectConfig = resolveProjectConfig(repoPath);
    push(`\n[Detector] Identified project type as: ${projectConfig.type} (Internal Port: ${projectConfig.containerPort})\n`);

    const dockerfile = projectConfig.dockerfile;
    const containerPort = projectConfig.containerPort;

    // 1. Docker Image Build with timeout & cooperative abort
    const buildArgs = ["build", "-t", imageName, "-f", dockerfile, repoPath];
    push(`\n> docker ${buildArgs.join(" ")}\n`);
    await runCommand("docker", buildArgs, push, {
      abortSignal,
      timeoutMs: buildTimeoutMs
    });

    if (abortSignal?.aborted) {
      throw createAbortError("Build aborted after image build");
    }

    // 2. Hardened Container Run with tracing labels & tier resource limits
    const labels = buildContainerLabels({
      previewId,
      buildId,
      projectId: project.id,
      prNumber,
      buildNumber: nextBuildNumber,
      commitSha,
      port: assignedPort
    });

    const runArgs = buildRunArgs({
      containerName,
      assignedPort,
      containerPort,
      imageName,
      tier: userTier,
      labels
    });

    push(`\n> docker ${runArgs.join(" ")}\n`);
    await runCommand("docker", runArgs, push, {
      abortSignal,
      timeoutMs: runTimeoutMs
    });
    containerStarted = true;

    // 3. Container HTTP Readiness Probe
    if (!skipHealthCheck && healthChecker) {
      push(`\n[Health Check] Probing http://127.0.0.1:${assignedPort}${healthPath} ...\n`);
      const probeResult = await healthChecker({
        port: assignedPort,
        containerName,
        timeoutMs: readyTimeoutMs,
        path: healthPath,
        abortSignal
      });
      push(
        `\n[Health Check] Container ready (HTTP ${probeResult?.status || 200} in ${probeResult?.elapsedMs ?? 0}ms)\n`
      );
    }

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
      } catch {
        // ignore
      }

      return url;
    }

    try {
      getIO().to(previewId).emit("log-finish", { url });
    } catch {
      // ignore
    }

    return {
      url,
      containerName,
      port: assignedPort,
      imageName,
      logs
    };
  } catch (err) {
    if (containerStarted) {
      const crashLogs = await getContainerLogs(containerName, { tail: 50 }).catch(() => "");
      if (crashLogs) {
        push(`\n[Container Output]\n${crashLogs}\n`);
      }
      await removeContainer(containerName).catch(() => {});
    }
    if (newlyAllocatedPort) {
      if (!managedByOrchestrator) {
        await releasePort({ port: newlyAllocatedPort, previewId, buildId }).catch(() => {});
      } else {
        releasePortInMemory(newlyAllocatedPort);
      }
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

      try {
        getIO().to(previewId).emit("log-error", { message: err.message });
      } catch {
        // ignore
      }
    }

    throw err;
  }
}
