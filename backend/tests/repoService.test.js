import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildCloneUrl,
  sanitizeGitError,
  cloneRepo
} from "../src/services/repoService.js";

describe("Authenticated private repository cloning & credential protection", () => {
  test("buildCloneUrl attaches token safely for private repos", () => {
    const url = buildCloneUrl({
      repoOwner: "my-org",
      repoName: "private-repo",
      accessToken: "ghp_secret_token_abc123"
    });

    assert.equal(
      url,
      "https://x-access-token:ghp_secret_token_abc123@github.com/my-org/private-repo.git"
    );
  });

  test("buildCloneUrl produces public URL when token is omitted", () => {
    const url = buildCloneUrl({
      repoOwner: "facebook",
      repoName: "react"
    });

    assert.equal(url, "https://github.com/facebook/react.git");
  });

  test("sanitizeGitError scrubs tokens from error messages", () => {
    const token = "ghp_secret_token_abc123";
    const rawError = new Error(
      `fatal: Authentication failed for 'https://x-access-token:${token}@github.com/owner/repo.git'`
    );

    const safeError = sanitizeGitError(rawError);

    assert.doesNotMatch(safeError.message, new RegExp(token));
    assert.match(safeError.message, /https:\/\/\*\*\*@github\.com/);
  });

  test("cloneRepo rejects invalid repository owner or name with 400 error", async () => {
    await assert.rejects(
      async () => {
        await cloneRepo({ repoOwner: "", repoName: "valid-name" });
      },
      (err) => {
        assert.match(err.message, /invalid repository coordinates/i);
        return true;
      }
    );
  });
});
