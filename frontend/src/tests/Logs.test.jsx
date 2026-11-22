// frontend/src/tests/Logs.test.jsx
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Logs from "../pages/Logs.jsx";
import api from "../api.js";
import * as socketContext from "../context/SocketContext.jsx";
import * as authContext from "../context/AuthContext.jsx";

vi.mock("../api.js", () => ({
  default: {
    get: vi.fn()
  },
  API_BASE_URL: "http://localhost:4000"
}));

describe("8. Logs Terminal Component Tests", () => {
  let mockSocket;
  let socketCallbacks;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("token", "mock_jwt_pro");
    socketCallbacks = {};

    mockSocket = {
      connected: true,
      on: vi.fn((event, cb) => {
        socketCallbacks[event] = cb;
      }),
      off: vi.fn(),
      emit: vi.fn()
    };

    vi.spyOn(socketContext, "useSocket").mockReturnValue({
      socket: mockSocket,
      joinPreview: vi.fn(),
      leavePreview: vi.fn()
    });

    vi.spyOn(authContext, "useAuth").mockReturnValue({
      tier: "PRO",
      token: "mock_jwt_pro"
    });
  });

  it("renders loading state initially and then displays fetched logs", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        logs: "Step 1: Cloning repository\nStep 2: Installing dependencies\n=== BUILD FINISHED ==="
      }
    });

    render(
      <MemoryRouter initialEntries={["/logs/prev_log_1"]}>
        <Routes>
          <Route path="/logs/:id" element={<Logs />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/BUILD FINISHED/)).toBeInTheDocument();
      expect(screen.getByText(/Cloning repository/)).toBeInTheDocument();
    });

    expect(api.get).toHaveBeenCalledWith(
      "/api/preview/prev_log_1/logs",
      expect.objectContaining({
        headers: { Authorization: "Bearer mock_jwt_pro" }
      })
    );
  });

  it("highlights errors with alert border and red text", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        logs: "npm ERR! code ENOENT\nError: Cannot find module './missing.js'"
      }
    });

    render(
      <MemoryRouter initialEntries={["/logs/prev_log_2"]}>
        <Routes>
          <Route path="/logs/:id" element={<Logs />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      const errLine = screen.getByText(/Cannot find module/);
      expect(errLine).toBeInTheDocument();
      expect(errLine).toHaveClass("text-red-400");
    });
  });

  it("renders empty logs fallback when no logs are returned", async () => {
    api.get.mockResolvedValueOnce({
      data: { logs: "" }
    });

    render(
      <MemoryRouter initialEntries={["/logs/prev_empty"]}>
        <Routes>
          <Route path="/logs/:id" element={<Logs />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Build Logs")).toBeInTheDocument();
      expect(screen.queryByText(/Error fetching saved logs/)).not.toBeInTheDocument();
    });
  });

  it("handles copy logs to clipboard", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValueOnce({
      data: { logs: "Build log content for clipboard" }
    });

    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true
    });

    render(
      <MemoryRouter initialEntries={["/logs/prev_copy"]}>
        <Routes>
          <Route path="/logs/:id" element={<Logs />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTitle("Copy")).toBeInTheDocument();
    });

    await user.click(screen.getByTitle("Copy"));
    expect(writeTextMock).toHaveBeenCalledWith("Build log content for clipboard");
  });
});
