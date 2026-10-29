import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import devSimRouter from "../src/routes/devSimulate.js";

describe("POST /dev/sim-pr security and validation", () => {
  const originalEnv = process.env.NODE_ENV;

  after(() => {
    process.env.NODE_ENV = originalEnv;
  });

  test("blocks access with 403 when NODE_ENV is production", async () => {
    process.env.NODE_ENV = "production";

    const app = express();
    app.use(express.json());
    app.use("/", devSimRouter);

    const server = app.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/dev/sim-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj_123", prNumber: 1, action: "open" })
      });

      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.error, "dev_endpoints_disabled_in_production");
    } finally {
      server.close();
      process.env.NODE_ENV = originalEnv;
    }
  });

  test("rejects request with 400 when input parameters are invalid", async () => {
    process.env.NODE_ENV = "development";

    const app = express();
    app.use(express.json());
    app.use("/", devSimRouter);

    const server = app.listen(0);
    const { port } = server.address();

    try {
      // Missing projectId
      const res1 = await fetch(`http://127.0.0.1:${port}/dev/sim-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prNumber: 1, action: "open" })
      });
      assert.equal(res1.status, 400);

      // Invalid prNumber (not positive integer)
      const res2 = await fetch(`http://127.0.0.1:${port}/dev/sim-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj_123", prNumber: -5, action: "open" })
      });
      assert.equal(res2.status, 400);

      // Invalid action
      const res3 = await fetch(`http://127.0.0.1:${port}/dev/sim-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj_123", prNumber: 1, action: "invalid_action" })
      });
      assert.equal(res3.status, 400);
    } finally {
      server.close();
      process.env.NODE_ENV = originalEnv;
    }
  });
});
