import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";
import { API_BASE_URL } from "../api.js";
import { useAuth } from "./AuthContext.jsx";

const SocketContext = createContext(null);

export function SocketProvider({ children }) {
  const { token } = useAuth();
  const socketRef = useRef(null);
  const [isConnected, setIsConnected] = useState(false);
  const activeRooms = useRef(new Set());

  useEffect(() => {
    if (!token) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
        activeRooms.current.clear();
      }
      return;
    }

    const socket = io(API_BASE_URL, {
      transports: ["websocket"],
      auth: { token },
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setIsConnected(true);
      // Automatically register user session for scoped status events
      socket.emit("register", { token });

      // Re-register any active preview rooms on reconnect
      activeRooms.current.forEach((previewId) => {
        socket.emit("register", { token, previewId });
      });
    });

    socket.on("disconnect", () => {
      setIsConnected(false);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setIsConnected(false);
    };
  }, [token]);

  const joinPreview = useCallback((previewId) => {
    if (!previewId) return;
    activeRooms.current.add(previewId);
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit("register", { token, previewId });
    }
  }, [token]);

  const leavePreview = useCallback((previewId) => {
    if (!previewId) return;
    activeRooms.current.delete(previewId);
  }, []);

  return (
    <SocketContext.Provider value={{ socket: socketRef.current, isConnected, joinPreview, leavePreview }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  const context = useContext(SocketContext);
  return context || { socket: null, isConnected: false, joinPreview: () => {}, leavePreview: () => {} };
}
