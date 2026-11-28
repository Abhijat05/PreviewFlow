import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import Dashboard from "../pages/Dashboard.jsx";
import api from "../api.js";

const mockRefreshUser = vi.fn().mockResolvedValue({});
const mockJoinPreview = vi.fn();

vi.mock("../api.js", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn()
  }
}));

vi.mock("../context/AuthContext.jsx", () => ({
  useAuth: () => ({
    tier: "FREE",
    refreshUser: mockRefreshUser
  })
}));

vi.mock("../context/SocketContext.jsx", () => ({
  useSocket: () => ({
    socket: null,
    joinPreview: mockJoinPreview
  })
}));

vi.mock("../pages/Logs.jsx", () => ({
  default: ({ previewId, onClose }) => (
    <div data-testid="mock-logs-drawer">
      <span>Logs for {previewId}</span>
      <button type="button" onClick={onClose}>Close Logs</button>
    </div>
  )
}));

vi.mock("../components/PlanChangeModal.jsx", () => ({
  default: () => null
}));

const sampleOverview = {
  projects: [
    {
      id: "proj_1",
      repoOwner: "octocat",
      repoName: "web-app",
      framework: "nextjs",
      hasWebhook: true,
      previews: [
        {
          id: "prev_1",
          prNumber: 7,
          status: "live",
          url: "http://pr-7.localhost:3000"
        }
      ]
    }
  ],
  stats: {
    totalProjects: 1,
    totalPreviews: 1,
    livePreviews: 1,
    buildingPreviews: 0,
    errorPreviews: 0,
    archivedPreviews: 0,
    totalBuilds: 4,
    completedBuilds: 3,
    failedBuilds: 1,
    successRate: 75,
    avgBuildDurationSec: 12.4
  },
  recentBuilds: [
    {
      id: "bld_1",
      previewId: "prev_1",
      buildNumber: 4,
      commitSha: "abcdef123456",
      branch: "feat/dashboard",
      status: "COMPLETED",
      durationSec: 12.4,
      prNumber: 7,
      repoOwner: "octocat",
      repoName: "web-app",
      queuedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    }
  ],
  activity: [
    {
      id: "audit-1",
      kind: "audit",
      action: "PROJECT_CONNECTED",
      title: "Connected repository",
      status: "SUCCESS",
      timestamp: new Date().toISOString()
    }
  ]
};

describe("Dashboard Overview & Quick Actions (Phase 4A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("token", "test-jwt-token");
  });

  it("renders skeleton loading state while initial overview request is pending", () => {
    api.get.mockImplementation(() => new Promise(() => {}));

    const { container } = render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("displays explicit error recovery state and retries overview fetch cleanly", async () => {
    const user = userEvent.setup();
    api.get
      .mockRejectedValueOnce({ response: { data: { error: "Database unavailable" } } })
      .mockResolvedValueOnce({ data: sampleOverview });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Could not load your dashboard")).toBeInTheDocument();
      expect(screen.getByText("Database unavailable")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /retry load/i }));

    await waitFor(() => {
      expect(screen.getByText("web-app")).toBeInTheDocument();
    });
    expect(api.get).toHaveBeenCalledWith("/api/dashboard/overview");
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("renders stats strip, framework badge, builds/activity tabs, and quick log/redeploy actions", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: sampleOverview });
    api.post.mockResolvedValue({ data: { success: true } });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("web-app")).toBeInTheDocument();
    });

    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("Avg duration 12.4s")).toBeInTheDocument();
    expect(screen.getByText("Next.js")).toBeInTheDocument();
    expect(screen.getByText("Webhook active")).toBeInTheDocument();
    expect(screen.getByText("Connected repository")).toBeInTheDocument();

    // Switch timeline tab to Builds
    await user.click(screen.getByRole("button", { name: /builds \(1\)/i }));
    expect(screen.getByText(/web-app · PR #7/i)).toBeInTheDocument();
    expect(screen.getByText(/feat\/dashboard · abcdef1/i)).toBeInTheDocument();

    // Open Logs drawer from project card quick action
    await user.click(screen.getByRole("button", { name: /latest logs/i }));
    expect(screen.getByTestId("mock-logs-drawer")).toHaveTextContent("Logs for prev_1");

    // Quick redeploy from project card header
    const redeployButtons = screen.getAllByRole("button", { name: /redeploy pr #7/i });
    await user.click(redeployButtons[0]);
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("/api/preview/prev_1/rebuild", {});
    });
  });

  it("opens Create Project drawer, lists GitHub repos, and connects with framework preset", async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url === "/api/dashboard/overview") {
        return Promise.resolve({ data: sampleOverview });
      }
      if (url === "/api/repos") {
        return Promise.resolve({
          data: [
            {
              owner: "octocat",
              name: "new-service",
              fullName: "octocat/new-service",
              isPrivate: true,
              language: "TypeScript"
            }
          ]
        });
      }
      return Promise.resolve({ data: [] });
    });
    api.post.mockResolvedValue({
      data: { success: true, project: { id: "proj_2", repoOwner: "octocat", repoName: "new-service" } }
    });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("web-app")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Create Project" })).toBeInTheDocument();
      expect(screen.getByText("octocat/new-service")).toBeInTheDocument();
    });

    await user.selectOptions(screen.getByLabelText("Framework preset"), "nextjs");
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("/api/connect-repo", {
        repoOwner: "octocat",
        repoName: "new-service",
        framework: "nextjs"
      });
    });
  });

  it("shows empty filter state and resets filters cleanly", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: sampleOverview });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("web-app")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText("Filter projects"), "does-not-exist");
    expect(screen.getByText("No deployments match your filters")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /reset filters/i }));
    expect(screen.getByText("web-app")).toBeInTheDocument();
  });
});
