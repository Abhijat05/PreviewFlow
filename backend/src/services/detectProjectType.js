import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Detect the framework or runtime type of a repository.
 */
export function detectProjectType(repoPath) {
  const f = (p) => fs.existsSync(path.join(repoPath, p));

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
    } catch (e) {
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
    case "dockerfile":
      return {
        type: "dockerfile",
        dockerfile: path.join(repoPath, "Dockerfile"),
        containerPort: 80
      };

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
