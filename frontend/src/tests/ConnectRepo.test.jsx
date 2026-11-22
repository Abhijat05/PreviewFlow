// frontend/src/tests/ConnectRepo.test.jsx
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import ConnectRepo from "../pages/ConnectRepo.jsx";
import api from "../api.js";
import * as authContext from "../context/AuthContext.jsx";

vi.mock("../api.js", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn()
  },
  API_BASE_URL: "http://localhost:4000"
}));

describe("8. ConnectRepo Component Tests", () => {
  const mockRepos = [
    { id: 1, fullName: "facebook/react", owner: "facebook", name: "react", isPrivate: false },
    { id: 2, fullName: "vercel/next.js", owner: "vercel", name: "next.js", isPrivate: false },
    { id: 3, fullName: "previewflow/backend", owner: "previewflow", name: "backend", isPrivate: true }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("token", "mock_token_123");

    vi.spyOn(authContext, "useAuth").mockReturnValue({
      token: "mock_token_123",
      tier: "FREE",
      user: { id: "u1", username: "octocat" }
    });
  });

  it("renders repository search input and fetched repositories list", async () => {
    api.get.mockImplementation((url) => {
      if (url === "/api/repos") return Promise.resolve({ data: mockRepos });
      if (url === "/api/projects") return Promise.resolve({ data: [] });
      return Promise.reject(new Error("not found"));
    });

    render(
      <MemoryRouter>
        <ConnectRepo />
      </MemoryRouter>
    );

    expect(screen.getByText("Fetching repositories...")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search repositories/i)).toBeInTheDocument();
      expect(screen.getByText("facebook/react")).toBeInTheDocument();
      expect(screen.getByText("vercel/next.js")).toBeInTheDocument();
      expect(screen.getByText("previewflow/backend")).toBeInTheDocument();
    });
  });

  it("filters repository list based on user search query", async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url === "/api/repos") return Promise.resolve({ data: mockRepos });
      if (url === "/api/projects") return Promise.resolve({ data: [] });
      return Promise.reject(new Error("not found"));
    });

    render(
      <MemoryRouter>
        <ConnectRepo />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("facebook/react")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search repositories/i);
    await user.type(searchInput, "next");

    expect(screen.getByText("vercel/next.js")).toBeInTheDocument();
    expect(screen.queryByText("facebook/react")).not.toBeInTheDocument();
  });

  it("shows disabled button when FREE tier project quota is reached", async () => {
    // Simulate 1 existing project already connected for FREE tier (quota max = 1)
    api.get.mockImplementation((url) => {
      if (url === "/api/repos") return Promise.resolve({ data: mockRepos });
      if (url === "/api/projects") return Promise.resolve({ data: [{ id: "p1", repoName: "existing", repoOwner: "someone" }] });
      return Promise.reject(new Error("not found"));
    });

    render(
      <MemoryRouter>
        <ConnectRepo />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("facebook/react")).toBeInTheDocument();
    });

    // Check that buttons show 'Limit' and are disabled
    const limitButtons = screen.getAllByRole("button", { name: /limit/i });
    expect(limitButtons.length).toBeGreaterThan(0);
    expect(limitButtons[0]).toBeDisabled();
  });

  it("calls api.post to connect repository and handles successful connection", async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url === "/api/repos") return Promise.resolve({ data: mockRepos });
      if (url === "/api/projects") return Promise.resolve({ data: [] });
      return Promise.reject(new Error("not found"));
    });

    api.post.mockResolvedValueOnce({
      data: {
        success: true,
        project: { id: "proj_new_123", repoOwner: "facebook", repoName: "react" }
      }
    });

    render(
      <MemoryRouter>
        <ConnectRepo />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("facebook/react")).toBeInTheDocument();
    });

    const importButtons = screen.getAllByRole("button", { name: /import/i });
    await user.click(importButtons[0]);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith("/api/connect-repo", {
        repoOwner: "facebook",
        repoName: "react"
      });
    });
  });
});
