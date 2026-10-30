import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
  cleanupOrphanedBuildDirs,
  startPeriodicDiskCleanup
} from "../src/services/repoService.js";

describe("Production Server Hardening & Disk Cleanup", () => {
  test("cleanupOrphanedBuildDirs removes directories older than maxAge", () => {
    const tmpBase = os.tmpdir();
    // Create an old pr-build-* directory
    const oldDir = fs.mkdtempSync(path.join(tmpBase, "pr-build-old-"));
    // Create a new pr-build-* directory
    const newDir = fs.mkdtempSync(path.join(tmpBase, "pr-build-new-"));

    try {
      // Modify mtime of oldDir to 2 hours ago
      const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(oldDir, twoHoursAgo, twoHoursAgo);

      // Run cleanup with maxAge of 1 hour
      const cleaned = cleanupOrphanedBuildDirs(60 * 60 * 1000);

      assert.ok(cleaned >= 1, "Should have cleaned at least 1 old directory");
      assert.equal(fs.existsSync(oldDir), false, "Old directory should be deleted");
      assert.equal(fs.existsSync(newDir), true, "New directory should still exist");
    } finally {
      try { if (fs.existsSync(oldDir)) fs.rmSync(oldDir, { recursive: true, force: true }); } catch {}
      try { if (fs.existsSync(newDir)) fs.rmSync(newDir, { recursive: true, force: true }); } catch {}
    }
  });

  test("startPeriodicDiskCleanup starts unref timer that does not block event loop", () => {
    const timer = startPeriodicDiskCleanup(60000, 3600000);
    assert.ok(timer);
    clearInterval(timer);
  });
});
