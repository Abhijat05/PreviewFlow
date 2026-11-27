// backend/src/utils/validation.js
const GITHUB_OWNER_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const GITHUB_REPO_REGEX = /^[a-zA-Z0-9._-]{1,100}$/;

/**
 * Validates GitHub owner (username or org) slug to prevent URL path injection.
 */
export function isValidGitHubOwner(owner) {
  return typeof owner === "string" && GITHUB_OWNER_REGEX.test(owner.trim());
}

/**
 * Validates GitHub repository name slug to prevent path traversal (`..`, `/`, query strings).
 */
export function isValidGitHubRepo(repo) {
  if (typeof repo !== "string") return false;
  const trimmed = repo.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
    return false;
  }
  return GITHUB_REPO_REGEX.test(trimmed);
}

/**
 * Validates both repoOwner and repoName slugs.
 */
export function isValidRepoCoordinates(repoOwner, repoName) {
  return isValidGitHubOwner(repoOwner) && isValidGitHubRepo(repoName);
}
