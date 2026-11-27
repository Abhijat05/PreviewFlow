// backend/src/services/detectProjectType.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKIPPED_SCAN_DIRS = new Set([".git", "node_modules", ".next", "dist", "build"]);

/**
 * Verifies a relative path exists, is a regular file (never a symlink),
 * and resolves strictly inside repoPath.
 */
export function isSafeRegularRepoFile(repoPath, relativePath) {
  try {
    const fullPath = path.join(repoPath, relativePath);
    const lstat = fs.lstatSync(fullPath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      return false;
    }
    const realRoot = fs.realpathSync(repoPath);
    const realTarget = fs.realpathSync(fullPath);
    return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

/**
 * Recursively audits repository workspace to block symlinks pointing outside repoPath.
 * Throws a security error if any symlink escapes the build directory.
 */
export function assertNoUnsafeSymlinks(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath)) return;

  const realRoot = fs.realpathSync(repoPath);
  const stack = [repoPath];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (SKIPPED_SCAN_DIRS.has(entry.name)) continue;

      const fullPath = path.join(currentDir, entry.name);
      const lstat = fs.lstatSync(fullPath);

      if (lstat.isSymbolicLink()) {
        let resolvedTarget = null;
        try {
          resolvedTarget = fs.realpathSync(fullPath);
        } catch {
          throw new Error(
            `Security violation: broken or external symlink detected at ${path.relative(repoPath, fullPath)}`
          );
        }

        const isInsideRoot =
          resolvedTarget === realRoot || resolvedTarget.startsWith(realRoot + path.sep);
        if (!isInsideRoot) {
          throw new Error(
            `Security violation: symlink '${path.relative(repoPath, fullPath)}' escapes repository boundary`
          );
        }
      } else if (lstat.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
}

/**
 * Detect the framework or runtime type of a repository safely.
 */
export function detectProjectType(repoPath) {
  const f = (p) => isSafeRegularRepoFile(repoPath, p);

  if (f("Dockerfile")) return "dockerfile";
  if (f("next.config.js") || f("next.config.mjs") || f("next.config.ts")) return "nextjs";
  if (f("vite.config.js") || f("vite.config.ts") || f("vite.config.mjs")) return "vite";

  if (f("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, "package.json"), "utf8"));
      const scripts = pkg.scripts || {};
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps.next) return "nextjs";
      if (deps.vite) return "vite";
      if (deps.react && scripts.build) return "vite";
      if (scripts.start || scripts.dev) return "node-backend";
    } catch {
      // ignore json parse error
    }
    return "node-backend";
  }

  if (f("index.html")) return "static";

  return "unknown";
}

/**
 * Resolve project build configuration, Dockerfile path, and exposed container port.
 */
export function resolveProjectConfig(repoPath) {
  const type = detectProjectType(repoPath);
  const templatesDir = path.resolve(__dirname, "../../deploy-templates");

  switch (type) {
    case "dockerfile": {
      const dockerfilePath = path.join(repoPath, "Dockerfile");
      if (!isSafeRegularRepoFile(repoPath, "Dockerfile")) {
        throw new Error("Security violation: Dockerfile must be a regular file inside repository root");
      }
      return {
        type: "dockerfile",
        dockerfile: dockerfilePath,
        containerPort: 80
      };
    }

    case "nextjs":
      return {
        type: "nextjs",
        dockerfile: path.join(templatesDir, "nextjs.Dockerfile"),
        containerPort: 3000
      };

    case "node-backend":
      return {
        type: "node-backend",
        dockerfile: path.join(templatesDir, "node-backend.Dockerfile"),
        containerPort: 3000
      };

    case "static":
      return {
        type: "static",
        dockerfile: path.join(templatesDir, "static.Dockerfile"),
        containerPort: 80
      };

    case "vite":
    case "unknown":
    default:
      return {
        type: type === "unknown" ? "vite" : type,
        dockerfile: path.join(templatesDir, "vite.Dockerfile"),
        containerPort: 80
      };
  }
}
