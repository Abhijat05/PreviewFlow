// backend/tests/integration/socket.test.js
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { io as Client } from "socket.io-client";
import { initSocket } from "../../src/socket.js";
import { prisma } from "../../src/db.js";
import { generateTestToken } from "../helpers/authHelper.js";

describe("7. Socket.IO Realtime Telemetry & Security Integration Tests", () => {
  let server;
  let io;
  let port;
  let originalPreviewFindUnique;

  const userA = "user_socket_alice";
  const userB = "user_socket_bob";
  const tokenA = generateTestToken({ userId: userA, tier: "PRO" });
  const tokenB = generateTestToken({ userId: userB, tier: "FREE" });

  before(async () => {
    server = http.createServer();
    io = initSocket(server);

    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    if (io) {
      io.disconnectSockets(true);
      await new Promise((r) => io.close(r));
    }
    if (server) {
      await new Promise((r) => server.close(r));
    }
  });

  beforeEach(() => {
    originalPreviewFindUnique = prisma.preview.findUnique;
  });

  afterEach(() => {
    prisma.preview.findUnique = originalPreviewFindUnique;
  });

  function createClient() {
    return Client(`http://127.0.0.1:${port}`, {
      autoConnect: false,
      reconnection: false
    });
  }

  test("disconnects and emits error when register message is missing authentication token", async () => {
    const client = createClient();

    const errorPromise = new Promise((resolve) => client.on("error", resolve));
    const disconnectPromise = new Promise((resolve) => client.on("disconnect", resolve));

    client.on("connect", () => {
      client.emit("register", { previewId: "prev_1" }); // no token
    });

    client.connect();

    const [errorMsg] = await Promise.all([errorPromise, disconnectPromise]);
    assert.equal(errorMsg, "Missing token");
    client.disconnect();
  });

  test("disconnects and emits error when register token is invalid or corrupted", async () => {
    const client = createClient();

    const errorPromise = new Promise((resolve) => client.on("error", resolve));
    const disconnectPromise = new Promise((resolve) => client.on("disconnect", resolve));

    client.on("connect", () => {
      client.emit("register", { token: "bad.corrupted.token" });
    });

    client.connect();

    const [errorMsg] = await Promise.all([errorPromise, disconnectPromise]);
    assert.equal(errorMsg, "Authentication failed");
    client.disconnect();
  });

  test("authenticates user and joins user channel when valid token is provided without previewId", async () => {
    const client = createClient();

    const regPromise = new Promise((resolve) => client.on("registered", resolve));

    client.on("connect", () => {
      client.emit("register", { token: tokenA });
    });

    client.connect();

    const regData = await regPromise;
    assert.equal(regData.userId, userA);
    client.disconnect();
  });

  test("rejects preview room registration when preview is not found in database", async () => {
    prisma.preview.findUnique = async () => null;

    const client = createClient();

    const errorPromise = new Promise((resolve) => client.on("error", resolve));
    const disconnectPromise = new Promise((resolve) => client.on("disconnect", resolve));

    client.on("connect", () => {
      client.emit("register", { token: tokenA, previewId: "prev_missing" });
    });

    client.connect();

    const [errorMsg] = await Promise.all([errorPromise, disconnectPromise]);
    assert.equal(errorMsg, "Preview not found");
    client.disconnect();
  });

  test("blocks registration with error when user attempts to join another user's preview room", async () => {
    prisma.preview.findUnique = async () => ({
      id: "prev_belonging_to_b",
      project: { userId: userB } // Owned by user B
    });

    const clientA = createClient();

    const errorPromise = new Promise((resolve) => clientA.on("error", resolve));
    const disconnectPromise = new Promise((resolve) => clientA.on("disconnect", resolve));

    clientA.on("connect", () => {
      clientA.emit("register", { token: tokenA, previewId: "prev_belonging_to_b" });
    });

    clientA.connect();

    const [errorMsg] = await Promise.all([errorPromise, disconnectPromise]);
    assert.equal(errorMsg, "Not authorized for this preview");
    clientA.disconnect();
  });

  test("joins preview room and delivers log, status, and metrics events exclusively to authorized room subscribers", async () => {
    prisma.preview.findUnique = async ({ where }) => {
      if (where.id === "prev_alice") {
        return { id: "prev_alice", project: { userId: userA } };
      }
      if (where.id === "prev_bob") {
        return { id: "prev_bob", project: { userId: userB } };
      }
      return null;
    };

    const clientA = createClient();
    const clientB = createClient();

    const connectA = new Promise((res) => clientA.on("connect", res));
    const connectB = new Promise((res) => clientB.on("connect", res));

    clientA.connect();
    clientB.connect();

    await Promise.all([connectA, connectB]);

    const regA = new Promise((res) => clientA.on("registered", res));
    const regB = new Promise((res) => clientB.on("registered", res));

    clientA.emit("register", { token: tokenA, previewId: "prev_alice" });
    clientB.emit("register", { token: tokenB, previewId: "prev_bob" });

    await Promise.all([regA, regB]);

    let clientAReceivedLogs = [];
    let clientBReceivedLogs = [];
    let clientAReceivedStats = null;
    let clientBReceivedStats = null;

    clientA.on("log", (d) => clientAReceivedLogs.push(d.chunk));
    clientB.on("log", (d) => clientBReceivedLogs.push(d.chunk));
    clientA.on("preview-stats-update", (d) => { clientAReceivedStats = d; });
    clientB.on("preview-stats-update", (d) => { clientBReceivedStats = d; });

    // Emit logs and stats targeting ONLY preview:prev_alice
    io.to("prev_alice").emit("log", { chunk: "Building step 1..." });
    io.to("preview:prev_alice").emit("preview-stats-update", {
      previewId: "prev_alice",
      cpu: 18.2,
      memory: 104857600
    });

    // Wait 100ms for event distribution
    await new Promise((r) => setTimeout(r, 100));

    // Verify isolation: Client A received events, Client B received none
    assert.deepEqual(clientAReceivedLogs, ["Building step 1..."]);
    assert.equal(clientBReceivedLogs.length, 0, "Client B must NOT receive Client A's logs");

    assert.ok(clientAReceivedStats);
    assert.equal(clientAReceivedStats.previewId, "prev_alice");
    assert.equal(clientBReceivedStats, null, "Client B must NOT receive Client A's stats");

    clientA.disconnect();
    clientB.disconnect();
  });
});
