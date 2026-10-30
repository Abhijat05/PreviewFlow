// backend/src/services/repoService.js
import simpleGit from "simple-git";
import fs from "fs";
import path from "path";
import os from "os";

/**
 * Builds a secure clone URL with optional token authentication for private repos.
 */
export function buildCloneUrl({ repoOwner, repoName, accessToken }) {
  const safeOwner = String(repoOwner || "").trim();
  const safeRepo = String(repoName || "").trim();

  if (accessToken && typeof accessToken === "string" && accessToken.trim()) {
    const encodedToken = encodeURIComponent(accessToken.trim());
    return `https://x-access-token:${encodedToken}@github.com/${safeOwner}/${safeRepo}.git`;
  }

  return `https://github.com/${safeOwner}/${safeRepo}.git`;
}

/**
 * Scrubs tokens and credentials from git error messages.
 */
export function sanitizeGitError(err) {
  if (!err) return new Error("Unknown git error");
  const msg = (err.message || String(err)).replace(
    /https:\/\/[^@\s]+@github\.com/gi,
    "https://***@github.com"
  );
  const sanitized = new Error(msg);
  sanitized.stack = err.stack ? err.stack.replace(/https:\/\/[^@\s]+@github\.com/gi, "https://***@github.com") : undefined;
  return sanitized;
}

/**
 * Clones a repository and checks out the specific PR or branch ref.
 * Supports private repositories via accessToken.
 */
export async function cloneRepo({ repoOwner, repoName, ref, prNumber, accessToken }) {
  if (!repoOwner || !repoName || typeof repoOwner !== "string" || typeof repoName !== "string" || !repoOwner.trim() || !repoName.trim()) {
    throw new Error("Invalid repository coordinates: repoOwner and repoName are required.");
  }

  const cleanOwner = repoOwner.trim();
  const cleanRepo = repoName.trim();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-build-"));
  const git = simpleGit();

  const cloneUrl = buildCloneUrl({ repoOwner: cleanOwner, repoName: cleanRepo, accessToken });

  try {
    // Clone repository (depth 50 to allow PR branch fetch)
    await git.clone(cloneUrl, tempDir, ["--depth", "50"]);

    // If prNumber is provided, fetch pull request head directly (works for forks & cross-repo PRs)
    if (prNumber) {
      try {
        await git.cwd(tempDir).fetch("origin", `pull/${prNumber}/head:pr-${prNumber}`);
        await git.cwd(tempDir).checkout(`pr-${prNumber}`);
      } catch (prErr) {
        // Fallback to checking out branch ref if PR ref fetch failed
        if (ref) {
          await git.cwd(tempDir).checkout(ref);
        } else {
          throw prErr;
        }
      }
    } else if (ref) {
      await git.cwd(tempDir).checkout(ref);
    }

    // Security: Reset origin remote URL to remove token from local .git/config on disk
    if (accessToken) {
      try {
        const publicUrl = `https://github.com/${cleanOwner}/${cleanRepo}.git`;
        await git.cwd(tempDir).remote(["set-url", "origin", publicUrl]);
      } catch {
        // non-fatal if remote url cannot be reset
      }
    }

    return tempDir;
  } catch (err) {
    // Cleanup temp directory immediately if clone fails
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}

    throw sanitizeGitError(err);
  }
}
