import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { prisma } from "./db.js";

let io;

export function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:5173",
      credentials: true
    },
  });

  io.on("connection", (socket) => {
    // Client can register with { token } (for user-level dashboard events)
    // or { token, previewId } (for preview-specific telemetry & logs)
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
        socket.userId = payload.userId;

        // Automatically join user's private channel
        socket.join(`user:${payload.userId}`);

        if (previewId) {
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
            socket.emit("error", "Not authorized for this preview");
            return socket.disconnect();
          }

          // Authorize and join preview rooms
          socket.join(`preview:${previewId}`);
          socket.join(previewId); // backward compatibility for log streams
          socket.emit("registered", { previewId });
        } else {
          socket.emit("registered", { userId: payload.userId });
        }
      } catch (err) {
        console.warn("Socket register error:", err?.message || err);
        socket.emit("error", "Authentication failed");
        socket.disconnect();
      }
    });

    socket.on("disconnect", () => {
      // socket disconnected cleanly
    });
  });

  return io;
}

export function getIO() {
  if (!io) throw new Error("Socket.io not initialized. Call initSocket(server) first.");
  return io;
}
