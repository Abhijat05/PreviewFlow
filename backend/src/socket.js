// backend/src/socket.js
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { prisma } from "./db.js";
import { logger } from "./utils/logger.js";
import { recordAuditEvent } from "./services/auditService.js";
import { incActiveSockets, decActiveSockets } from "./services/metricsService.js";

let io;
const AUTH_TIMEOUT_MS = Number(process.env.SOCKET_AUTH_TIMEOUT_MS) || 5000;
const MAX_SOCKETS_PER_USER = Number(process.env.MAX_SOCKETS_PER_USER) || 20;

export function initSocket(server) {
  const userSocketIds = new Map();

  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:5173",
      credentials: true
    }
  });

  function trackUserSocket(userId, socketId) {
    let set = userSocketIds.get(userId);
    if (!set) {
      set = new Set();
      userSocketIds.set(userId, set);
    }
    set.add(socketId);
    return set.size;
  }

  function untrackUserSocket(userId, socketId) {
    if (!userId) return;
    const set = userSocketIds.get(userId);
    if (set) {
      set.delete(socketId);
      if (set.size === 0) {
        userSocketIds.delete(userId);
      }
    }
  }

  io.on("connection", (socket) => {
    let authenticated = false;
    let metricsIncremented = false;

    // Disconnect idle unauthenticated sockets that fail to register within timeout
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        logger.warn("Socket authentication timeout", { socketId: socket.id });
        socket.emit("error", "Authentication timeout");
        socket.disconnect();
      }
    }, AUTH_TIMEOUT_MS);
    if (authTimer.unref) authTimer.unref();

    socket.on("register", async (data) => {
      try {
        const { previewId, token } = data || {};
        const authToken = token || socket.handshake.auth?.token;

        if (!authToken) {
          socket.emit("error", "Missing token");
          return socket.disconnect();
        }

        // Verify JWT
        const payload = jwt.verify(authToken, process.env.JWT_SECRET);
        if (!payload?.userId) {
          socket.emit("error", "Authentication failed");
          return socket.disconnect();
        }

        const count = trackUserSocket(payload.userId, socket.id);
        if (count > MAX_SOCKETS_PER_USER) {
          untrackUserSocket(payload.userId, socket.id);
          void recordAuditEvent({
            actorUserId: payload.userId,
            action: "SOCKET_LIMIT_EXCEEDED",
            resourceType: "WebSocket",
            status: "DENIED",
            metadata: { activeCount: count }
          });
          socket.emit("error", "Connection limit exceeded");
          return socket.disconnect();
        }

        authenticated = true;
        if (!metricsIncremented) {
          metricsIncremented = true;
          incActiveSockets();
        }
        clearTimeout(authTimer);
        socket.userId = payload.userId;

        // Automatically join user's private channel
        socket.join(`user:${payload.userId}`);

        if (previewId !== undefined && previewId !== null) {
          if (typeof previewId !== "string" || !previewId.trim() || previewId.length > 64) {
            socket.emit("error", "Invalid previewId");
            return socket.disconnect();
          }

          // Check preview belongs to this user
          const preview = await prisma.preview.findUnique({
            where: { id: previewId },
            include: { project: true }
          });

          if (!preview) {
            socket.emit("error", "Preview not found");
            return socket.disconnect();
          }

          if (preview.project.userId !== payload.userId) {
            void recordAuditEvent({
              actorUserId: payload.userId,
              action: "SOCKET_ROOM_DENIED",
              resourceType: "Preview",
              resourceId: previewId,
              status: "DENIED"
            });
            socket.emit("error", "Not authorized for this preview");
            return socket.disconnect();
          }

          // Authorize and join preview rooms
          socket.join(`preview:${previewId}`);
          socket.join(previewId);
          socket.emit("registered", { previewId });
        } else {
          socket.emit("registered", { userId: payload.userId });
        }
      } catch (err) {
        logger.warn("Socket register error", { socketId: socket.id, err });
        socket.emit("error", "Authentication failed");
        socket.disconnect();
      }
    });

    socket.on("disconnect", () => {
      clearTimeout(authTimer);
      untrackUserSocket(socket.userId, socket.id);
      if (metricsIncremented) {
        metricsIncremented = false;
        decActiveSockets();
      }
    });
  });

  return io;
}

export function getIO() {
  if (!io) throw new Error("Socket.io not initialized. Call initSocket(server) first.");
  return io;
}

export function setIO(customIO) {
  io = customIO;
}
