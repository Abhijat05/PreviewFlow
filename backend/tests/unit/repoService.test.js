// backend/tests/unit/repoService.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import simpleGit from "simple-git";
import {
  buildCloneUrl,
  sanitizeGitError,
  cloneRepo,
  cleanupOrphanedBuildDirs,
  startPeriodicDiskCleanup
} from "../../src/services/repoService.js";

describe("4.1 Repository Service Unit Tests", () => {
  let createdDirs = [];

  afterEach(() => {
    // Cleanup any lingering temp directories
    for (const d of createdDirs) {
      try {
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    createdDirs = [];
  });

  test("buildCloneUrl formats authenticated URL for private repos and encodes tokens", () => {
    const url = buildCloneUrl({
      repoOwner: "test-org",
      repoName: "secure-repo",
      accessToken: "ghp_tok@123#xyz"
    });
    assert.equal(
      url,
      "https://x-access-token:ghp_tok%40123%23xyz@github.com/test-org/secure-repo.git"
    );
  });

  test("buildCloneUrl formats public clone URL when accessToken is absent or empty", () => {
    assert.equal(
      buildCloneUrl({ repoOwner: "owner", repoName: "repo" }),
      "https://github.com/owner/repo.git"
    );
    assert.equal(
      buildCloneUrl({ repoOwner: "owner", repoName: "repo", accessToken: "   " }),
      "https://github.com/owner/repo.git"
    );
  });

  test("cloneRepo rejects missing or invalid repository coordinates", async () => {
    await assert.rejects(
      async () => cloneRepo({ repoOwner: "", repoName: "repo" }),
      (err) => {
        assert.match(err.message, /invalid repository coordinates/i);
        return true;
      }
    );

    await assert.rejects(
      async () => cloneRepo({ repoOwner: "owner", repoName: "  " }),
      (err) => {
        assert.match(err.message, /invalid repository coordinates/i);
        return true;
      }
    );

    await assert.rejects(
      async () => cloneRepo({ repoOwner: null, repoName: "repo" }),
      (err) => {
        assert.match(err.message, /invalid repository coordinates/i);
        return true;
      }
    );
  });

  test("sanitizeGitError scrubs tokens from error message and stack trace", () => {
    const token = "ghp_secret_access_token_12345";
    const rawError = new Error(
      `fatal: unable to access 'https://x-access-token:${token}@github.com/org/repo.git/': 403`
    );
    rawError.stack = `Error: fatal: https://x-access-token:${token}@github.com\n at Object.<anonymous>`;

    const sanitized = sanitizeGitError(rawError);
    assert.doesNotMatch(sanitized.message, new RegExp(token));
    assert.match(sanitized.message, /https:\/\/\*\*\*@github\.com/);
    if (sanitized.stack) {
      assert.doesNotMatch(sanitized.stack, new RegExp(token));
      assert.match(sanitized.stack, /https:\/\/\*\*\*@github\.com/);
    }
  });

  test("cloneRepo cleans up temporary directory if clone command fails", async () => {
    // We pass an unresolvable domain to force clone failure without a hang
    let createdTempDir = null;
    const originalMkdtempSync = fs.mkdtempSync;

    fs.mkdtempSync = (prefix) => {
      const dir = originalMkdtempSync(prefix);
      createdTempDir = dir;
      createdDirs.push(dir);
      return dir;
    };

    try {
      await assert.rejects(
        async () => {
          await cloneRepo({
            repoOwner: "invalid-owner-xyz-9999",
            repoName: "invalid-repo-xyz-9999",
            accessToken: "secret_fail_tok"
          });
        },
        (err) => {
          // Verify error is sanitized
          assert.doesNotMatch(err.message, /secret_fail_tok/);
          return true;
        }
      );

      // Verify temp dir was deleted in catch block
      assert.ok(createdTempDir, "Temp dir should have been created initially");
      assert.equal(
        fs.existsSync(createdTempDir),
        false,
        "Temp directory must be cleaned up on clone failure"
      );
    } finally {
      fs.mkdtempSync = originalMkdtempSync;
    }
  });

  test("cleanupOrphanedBuildDirs deletes stale build dirs and preserves fresh ones", () => {
    const tmpBase = os.tmpdir();
    const oldDir = fs.mkdtempSync(path.join(tmpBase, "pr-build-stale-"));
    const freshDir = fs.mkdtempSync(path.join(tmpBase, "pr-build-fresh-"));
    createdDirs.push(oldDir, freshDir);

    const pastTime = (Date.now() - 3600 * 1000 * 5) / 1000;
    fs.utimesSync(oldDir, pastTime, pastTime);

    const cleanedCount = cleanupOrphanedBuildDirs(3600 * 1000);
    assert.ok(cleanedCount >= 1);
    assert.equal(fs.existsSync(oldDir), false, "Stale directory should be removed");
    assert.equal(fs.existsSync(freshDir), true, "Fresh directory should be preserved");
  });

  test("startPeriodicDiskCleanup initiates unreferenced timer", () => {
    const timer = startPeriodicDiskCleanup(10000, 3600000);
    assert.ok(timer, "Timer must be created");
    clearInterval(timer);
  });

  test("cloneRepo checks out exact commitSha when provided", async () => {
    const tmpBase = path.join(process.cwd(), "tmp-builds");
    if (!fs.existsSync(tmpBase)) fs.mkdirSync(tmpBase, { recursive: true });
    const srcDir = fs.mkdtempSync(path.join(tmpBase, "git-src-"));
    createdDirs.push(srcDir);
    const git = simpleGit(srcDir);
    await git.init();
    await git.addConfig("user.name", "Test User");
    await git.addConfig("user.email", "test@example.com");

    fs.writeFileSync(path.join(srcDir, "file.txt"), "Version 1");
    await git.add("file.txt");
    const commit1 = await git.commit("Commit 1");
    const sha1 = commit1.commit;

    fs.writeFileSync(path.join(srcDir, "file.txt"), "Version 2");
    await git.add("file.txt");
    await git.commit("Commit 2");

    const tempCloned = await cloneRepo({
      repoOwner: "test",
      repoName: "local",
      commitSha: sha1,
      cloneUrlOverride: srcDir
    });
    createdDirs.push(tempCloned);

    const content = fs.readFileSync(path.join(tempCloned, "file.txt"), "utf8");
    assert.equal(content, "Version 1");

    const clonedGit = simpleGit(tempCloned);
    const headLog = await clonedGit.log({ maxCount: 1 });
    assert.equal(headLog.latest.hash, sha1);
  });

  test("cloneRepo rejects immediately with AbortError when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () =>
        cloneRepo({
          repoOwner: "test",
          repoName: "local",
          abortSignal: controller.signal
        }),
      (err) => {
        assert.equal(err.isAborted, true);
        assert.equal(err.name, "AbortError");
        return true;
      }
    );
  });

  test("sanitizeGitError preserves TimeoutError metadata when present", () => {
    const raw = new Error("fatal: unable to access https://x-access-token:secret@github.com/o/r.git");
    raw.isTimeout = true;
    const sanitized = sanitizeGitError(raw);
    assert.equal(sanitized.isTimeout, true);
    assert.equal(sanitized.name, "TimeoutError");
    assert.doesNotMatch(sanitized.message, /secret/);
  });
});
