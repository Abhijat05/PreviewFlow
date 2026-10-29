import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express from "express";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { io as Client } from "socket.io-client";

describe("Socket.io room isolation & authentication", () => {
  const originalJwtSecret = process.env.JWT_SECRET || "socket_test_secret";
  process.env.JWT_SECRET = originalJwtSecret;

  let server;
  let io;
  let port;

  before(async () => {
    const app = express();
    server = http.createServer(app);
    io = new Server(server, { cors: { origin: "*" } });

    io.on("connection", (socket) => {
      socket.on("register", (data) => {
        try {
          const { previewId, token } = data || {};
          if (!token) return socket.disconnect();
          const payload = jwt.verify(token, process.env.JWT_SECRET);
          socket.join(`user:${payload.userId}`);
          if (previewId) {
            socket.join(`preview:${previewId}`);
            socket.join(previewId);
          }
          socket.emit("registered", { ok: true });
        } catch (err) {
          socket.disconnect();
        }
      });
    });

    await new Promise((resolve) => {
      server.listen(0, () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(() => {
    io.close();
    server.close();
  });

  test("scoped emissions only reach authorized user rooms and not other users", async () => {
    const userAToken = jwt.sign({ userId: "user_A" }, process.env.JWT_SECRET);
    const userBToken = jwt.sign({ userId: "user_B" }, process.env.JWT_SECRET);

    const clientA = Client(`http://127.0.0.1:${port}`, { transports: ["websocket"] });
    const clientB = Client(`http://127.0.0.1:${port}`, { transports: ["websocket"] });

    await Promise.all([
      new Promise((res) => clientA.on("connect", res)),
      new Promise((res) => clientB.on("connect", res))
    ]);

    // Register user A for their preview
    clientA.emit("register", { previewId: "prev_A", token: userAToken });
    // Register user B for their preview
    clientB.emit("register", { previewId: "prev_B", token: userBToken });

    await Promise.all([
      new Promise((res) => clientA.on("registered", res)),
      new Promise((res) => clientB.on("registered", res))
    ]);

    let userAReceived = false;
    let userBReceived = false;

    clientA.on("preview-stats-update", (data) => {
      if (data.previewId === "prev_A") userAReceived = true;
    });

    clientB.on("preview-stats-update", (data) => {
      if (data.previewId === "prev_A") userBReceived = true;
    });

    // Emit stats targeting only prev_A / user_A
    io.to("preview:prev_A").to("prev_A").to("user:user_A").emit("preview-stats-update", {
      previewId: "prev_A",
      cpu: 12.5,
      memory: 1048576
    });

    // Wait 100ms for event propagation
    await new Promise((res) => setTimeout(res, 100));

    clientA.disconnect();
    clientB.disconnect();

    assert.equal(userAReceived, true, "User A should receive their preview stats");
    assert.equal(userBReceived, false, "User B must NOT receive User A's private preview stats");
  });
});
