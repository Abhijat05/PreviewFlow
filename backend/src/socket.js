import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { prisma } from "./db.js";

let io;

export function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: "http://localhost:5173",
      credentials: true
    },
    // optional: pingInterval/pingTimeout tweaks
  });

  io.on("connection", (socket) => {
    console.log("Socket connected", socket.id);

    // Client must call "register" with { previewId, token } to join its preview room
    socket.on("register", async (data) => {
      try {
        const { previewId, token } = data || {};
        if (!token || !previewId) {
          socket.emit("error", "Missing token or previewId");
          return socket.disconnect();
        }

        // verify JWT
        const payload = jwt.verify(token, process.env.JWT_SECRET);

        // check preview belongs to this user
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

        // All good: join the room
        socket.join(previewId);
        console.log(`Socket ${socket.id} joined preview ${previewId}`);
        socket.emit("registered", { previewId });
      } catch (err) {
        console.warn("Socket register error:", err?.message || err);
        socket.emit("error", "Authentication failed");
        socket.disconnect();
      }
    });

    socket.on("disconnect", () => {
      console.log("Socket disconnected", socket.id);
    });
  });

  return io;
}

export function getIO() {
  if (!io) throw new Error("Socket.io not initialized. Call initSocket(server) first.");
  return io;
}
