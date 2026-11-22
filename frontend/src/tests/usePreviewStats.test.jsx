// frontend/src/tests/usePreviewStats.test.jsx
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { usePreviewStats } from "../hooks/usePreviewStats.js";
import api from "../api.js";
import * as socketContext from "../context/SocketContext.jsx";

// Mock API
vi.mock("../api.js", () => ({
  default: {
    get: vi.fn()
  },
  API_BASE_URL: "http://localhost:4000"
}));

describe("8. usePreviewStats Custom Hook Tests", () => {
  let mockSocket;
  let socketCallbacks;

  beforeEach(() => {
    vi.clearAllMocks();
    socketCallbacks = {};

    mockSocket = {
      connected: true,
      on: vi.fn((event, cb) => {
        socketCallbacks[event] = cb;
      }),
      off: vi.fn((event, _cb) => {
        delete socketCallbacks[event];
      }),
      emit: vi.fn()
    };

    vi.spyOn(socketContext, "useSocket").mockReturnValue({
      socket: mockSocket,
      isConnected: true,
      joinPreview: vi.fn(),
      leavePreview: vi.fn()
    });
  });

  it("fetches historical telemetry and sets history and currentStats", async () => {
    const mockMetricsResponse = {
      data: {
        previewId: "prev_hook_1",
        range: "1h",
        count: 2,
        metrics: [
          {
            createdAt: new Date(Date.now() - 30000).toISOString(),
            cpu: 12.4,
            memory: 104857600,
            networkRx: 1000,
            networkTx: 2000
          },
          {
            createdAt: new Date().toISOString(),
            cpu: 25.8,
            memory: 209715200,
            networkRx: 5000,
            networkTx: 8000
          }
        ]
      }
    };

    api.get.mockResolvedValueOnce(mockMetricsResponse);

    const { result } = renderHook(() => usePreviewStats("prev_hook_1", "1h"));

    expect(result.current.isLoadingHistory).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoadingHistory).toBe(false);
      expect(result.current.history.length).toBe(2);
      expect(result.current.currentStats.cpu).toBe(25.8);
      expect(result.current.currentStats.memoryMB).toBe(200);
    });

    expect(api.get).toHaveBeenCalledWith("/api/previews/prev_hook_1/metrics?range=1h");
  });

  it("handles historical metrics fetch error gracefully", async () => {
    api.get.mockRejectedValueOnce({
      response: { data: { message: "Telemetry offline" } }
    });

    const { result } = renderHook(() => usePreviewStats("prev_err_1"));

    await waitFor(() => {
      expect(result.current.isLoadingHistory).toBe(false);
      expect(result.current.error).toBe("Telemetry offline");
      expect(result.current.history).toEqual([]);
    });
  });

  it("appends real-time socket updates to history when received", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        metrics: [
          {
            createdAt: new Date().toISOString(),
            cpu: 10.0,
            memory: 104857600
          }
        ]
      }
    });

    const { result } = renderHook(() => usePreviewStats("prev_socket_1"));

    await waitFor(() => {
      expect(result.current.isLoadingHistory).toBe(false);
    });

    // Simulate socket event
    act(() => {
      if (socketCallbacks["preview-stats-update"]) {
        socketCallbacks["preview-stats-update"]({
          previewId: "prev_socket_1",
          cpu: 55.4,
          memory: 314572800,
          networkRx: 1024,
          networkTx: 2048,
          uptime: 120
        });
      }
    });

    await waitFor(() => {
      expect(result.current.currentStats.cpu).toBe(55.4);
      expect(result.current.currentStats.uptime).toBe(120);
    });
  });
});
