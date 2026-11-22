// frontend/src/tests/Dashboard.test.jsx
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import Dashboard from "../pages/Dashboard.jsx";
import api from "../api.js";
import * as socketContext from "../context/SocketContext.jsx";
import * as authContext from "../context/AuthContext.jsx";

vi.mock("../api.js", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn()
  },
  API_BASE_URL: "http://localhost:4000"
}));

describe("8. Dashboard & Preview Cards Component Tests", () => {
  let mockSocket;
  let socketCallbacks;

  const mockProjects = [
    {
      id: "p1",
      repoOwner: "acme",
      repoName: "web-portal",
      previews: [
        {
          id: "prev_live",
          prNumber: 42,
          status: "live",
          url: "http://localhost:5050",
          port: 5050,
          buildStartedAt: new Date(Date.now() - 120000).toISOString()
        },
        {
          id: "prev_building",
          prNumber: 43,
          status: "building",
          url: null,
          buildStartedAt: new Date().toISOString()
        },
        {
          id: "prev_error",
          prNumber: 44,
          status: "error",
          url: null
        }
      ]
    }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("token", "mock_token_dashboard");
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
      isConnected: true,
      joinPreview: vi.fn(),
      leavePreview: vi.fn()
    });

    vi.spyOn(authContext, "useAuth").mockReturnValue({
      tier: "PRO",
      token: "mock_token_dashboard",
      refreshUser: vi.fn().mockResolvedValue(undefined)
    });
  });

  it("renders empty projects state when user has no connected projects", async () => {
    api.get.mockResolvedValueOnce({ data: [] });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Dashboard")).toBeInTheDocument();
      expect(screen.getByText("Import Repository")).toBeInTheDocument();
    });
  });

  it("renders waiting state when project has no pull requests yet", async () => {
    api.get.mockResolvedValueOnce({
      data: [{ id: "p1", repoOwner: "acme", repoName: "web-portal", previews: [] }]
    });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Waiting for Pull Requests...")).toBeInTheDocument();
    });
  });

  it("renders project selection and preview cards with accurate status badges", async () => {
    api.get.mockResolvedValueOnce({ data: mockProjects });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("web-portal")).toBeInTheDocument();
      expect(screen.getByText("#42")).toBeInTheDocument();
      expect(screen.getByText("#43")).toBeInTheDocument();
      expect(screen.getByText("#44")).toBeInTheDocument();
    });

    // Check status visual labels
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Building")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("triggers rebuild preview API request when rebuild button is clicked", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValueOnce({ data: mockProjects });
    api.post.mockResolvedValueOnce({ data: { ok: true, status: "building" } });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("#42")).toBeInTheDocument();
    });

    const rebuildButtons = screen.getAllByTitle(/redeploy/i);
    await user.click(rebuildButtons[0]);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("/api/preview/prev_live/rebuild", {});
    });
  });

  it("triggers delete preview API request when delete button is clicked and confirmed", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValueOnce({ data: mockProjects });
    api.post.mockResolvedValueOnce({ data: { ok: true } });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("#42")).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByTitle(/delete/i);
    await user.click(deleteButtons[0]);

    // Modal or confirm prompt appears with "Confirm"
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("/api/preview/prev_live/delete", {});
    });
  });
});
