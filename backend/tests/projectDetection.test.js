import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
  detectProjectType,
  resolveProjectConfig
} from "../src/services/detectProjectType.js";

describe("Dynamic project type detection & container port mapping", () => {
  let tempBaseDir;

  before(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-test-"));
  });

  after(() => {
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
  });

  test("detects custom Dockerfile in repo root", () => {
    const dir = path.join(tempBaseDir, "custom-docker");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM alpine\nCMD echo hi");

    const config = resolveProjectConfig(dir);
    assert.equal(config.type, "dockerfile");
    assert.equal(config.dockerfile, path.join(dir, "Dockerfile"));
    assert.ok(fs.existsSync(config.dockerfile));
  });

  test("detects Next.js project with containerPort 3000 and valid template", () => {
    const dir = path.join(tempBaseDir, "next-project");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "next.config.js"), "module.exports = {}");

    const config = resolveProjectConfig(dir);
    assert.equal(config.type, "nextjs");
    assert.equal(config.containerPort, 3000);
    assert.ok(fs.existsSync(config.dockerfile), `Template must exist at ${config.dockerfile}`);
  });

  test("detects Vite project with containerPort 80 and valid template", () => {
    const dir = path.join(tempBaseDir, "vite-project");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "vite.config.ts"), "export default {}");

    const config = resolveProjectConfig(dir);
    assert.equal(config.type, "vite");
    assert.equal(config.containerPort, 80);
    assert.ok(fs.existsSync(config.dockerfile), `Template must exist at ${config.dockerfile}`);
  });

  test("detects Node backend project with containerPort 3000 and valid template", () => {
    const dir = path.join(tempBaseDir, "node-project");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "my-api", scripts: { start: "node index.js" } })
    );

    const config = resolveProjectConfig(dir);
    assert.equal(config.type, "node-backend");
    assert.equal(config.containerPort, 3000);
    assert.ok(fs.existsSync(config.dockerfile), `Template must exist at ${config.dockerfile}`);
  });

  test("detects static HTML project with containerPort 80 and valid template", () => {
    const dir = path.join(tempBaseDir, "static-project");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>Hello</h1>");

    const config = resolveProjectConfig(dir);
    assert.equal(config.type, "static");
    assert.equal(config.containerPort, 80);
    assert.ok(fs.existsSync(config.dockerfile), `Template must exist at ${config.dockerfile}`);
  });
});
