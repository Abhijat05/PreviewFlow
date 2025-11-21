import fs from "fs";
import path from "path";
import { exec } from "child_process";
import getPort from "get-port";
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
 * Build & run preview container
 */
export async function buildPreview({ project, previewId, repoPath, prNumber }) {
  let logs = "";
  const push = (chunk) => {
    logs += chunk;
    try {
      getIO().to(previewId).emit("log", { chunk });
    } catch { }
  };

  // → MARK BUILD START
  const buildStartedAt = new Date();
  await prisma.preview.update({
    where: { id: previewId },
    data: {
      status: "building",
      buildStartedAt
    }
  });

  const baseName = `${project.repoOwner}-${project.repoName}-pr-${prNumber}`
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, "-");

  const imageName = baseName;
  let containerName = baseName;

  const dockerfile = path.resolve("deploy-templates/vite.Dockerfile");
  const hostPort = await getPort({ port: 40000 });

  try {
    // Build
    push(`\n> docker build -t ${imageName} -f "${dockerfile}" "${repoPath}"\n`);
    await run(
      `docker build -t ${imageName} -f "${dockerfile}" "${repoPath}"`,
      push
    );

    // Run
    push(
      `\n> docker run -d --name ${containerName} -p ${hostPort}:80 ${imageName}\n`
    );
    await run(
      `docker run -d --name ${containerName} -p ${hostPort}:80 ${imageName}`,
      push
    );

    // Detect actual container name
    await new Promise((resolve) => {
      exec(`docker ps -a --format "{{.Names}}"`, (err, stdout) => {
        if (!err) {
          const names = stdout.split("\n").map((s) => s.trim());
          const match = names.find((s) => s.includes(baseName));
          if (match) containerName = match;
        }
        resolve();
      });
    });

    const url = `http://localhost:${hostPort}`;

    // → MARK BUILD END
    const buildCompletedAt = new Date();

    // Save result in DB
    await prisma.preview.update({
      where: { id: previewId },
      data: {
        status: "live",
        url,
        buildLogs: logs,
        containerName,
        buildCompletedAt
      }
    });

    try {
      getIO().to(previewId).emit("log-finish", { url });
    } catch { }

    return url;
  } catch (err) {
    const buildCompletedAt = new Date();

    await prisma.preview.update({
      where: { id: previewId },
      data: {
        status: "error",
        buildLogs: logs + "\n\nERROR:\n" + err.message,
        buildCompletedAt
      }
    });

    try {
      getIO().to(previewId).emit("log-error", { message: err.message });
    } catch { }

    throw err;
  }
}

/**
 * Stop & remove container safely
 */
export async function removeContainer(name) {
  return new Promise((resolve) => {
    exec(`docker rm -f ${name}`, (err) => {
      resolve(!err);
    });
  });
}
