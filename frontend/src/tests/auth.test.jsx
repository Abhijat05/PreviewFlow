// frontend/src/tests/auth.test.jsx
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "../context/AuthContext.jsx";
import api from "../api.js";

// Mock API client
vi.mock("../api.js", () => ({
  default: {
    get: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() }
    }
  },
  API_BASE_URL: "http://localhost:4000"
}));

// Test Consumer Component
function AuthStatusConsumer() {
  const { token, user, tier, login, logout, loading } = useAuth();

  if (loading) return <div>Loading Auth...</div>;

  return (
    <div>
      <div data-testid="token-status">{token ? "AUTHENTICATED" : "UNAUTHENTICATED"}</div>
      <div data-testid="tier-status">{tier}</div>
      <div data-testid="username">{user?.username || "ANONYMOUS"}</div>
      <button onClick={() => login("mock.header.eyJ0aWVyIjoiUFJPIiwidXNlcklkIjoidTEifQ.signature")}>
        Trigger Login
      </button>
      <button onClick={logout}>Trigger Logout</button>
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { token, loading } = useAuth();
  if (loading) return <div>Loading Protected...</div>;
  return token ? children : <Navigate to="/" replace />;
}

describe("8. Authentication Context & Protected Route Component Tests", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("initializes with unauthenticated state when no token is in localStorage", async () => {
    render(
      <AuthProvider>
        <AuthStatusConsumer />
      </AuthProvider>
    );

    expect(screen.getByTestId("token-status")).toHaveTextContent("UNAUTHENTICATED");
    expect(screen.getByTestId("tier-status")).toHaveTextContent("FREE");
    expect(screen.getByTestId("username")).toHaveTextContent("ANONYMOUS");
  });

  it("initializes with authenticated state when valid token exists in localStorage and fetches user profile", async () => {
    const rawPayload = btoa(JSON.stringify({ tier: "PRO", userId: "u1" }));
    const mockToken = `header.${rawPayload}.signature`;
    localStorage.setItem("token", mockToken);

    api.get.mockResolvedValueOnce({
      data: { id: "u1", username: "octocat_pro", tier: "PRO" }
    });

    render(
      <AuthProvider>
        <AuthStatusConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("token-status")).toHaveTextContent("AUTHENTICATED");
      expect(screen.getByTestId("tier-status")).toHaveTextContent("PRO");
      expect(screen.getByTestId("username")).toHaveTextContent("octocat_pro");
    });
  });

  it("updates auth state on login and clears it on logout", async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({
      data: { id: "u1", username: "login_user", tier: "PRO" }
    });

    render(
      <AuthProvider>
        <AuthStatusConsumer />
      </AuthProvider>
    );

    expect(screen.getByTestId("token-status")).toHaveTextContent("UNAUTHENTICATED");

    // Click Login
    await user.click(screen.getByRole("button", { name: "Trigger Login" }));

    await waitFor(() => {
      expect(screen.getByTestId("token-status")).toHaveTextContent("AUTHENTICATED");
      expect(screen.getByTestId("tier-status")).toHaveTextContent("PRO");
    });
    expect(localStorage.getItem("token")).toBeTruthy();

    // Click Logout
    await user.click(screen.getByRole("button", { name: "Trigger Logout" }));

    expect(screen.getByTestId("token-status")).toHaveTextContent("UNAUTHENTICATED");
    expect(screen.getByTestId("tier-status")).toHaveTextContent("FREE");
    expect(localStorage.getItem("token")).toBeNull();
  });

  it("synchronizes logout across tabs when window 'auth:logout' event is dispatched", async () => {
    const rawPayload = btoa(JSON.stringify({ tier: "FREE" }));
    localStorage.setItem("token", `h.${rawPayload}.s`);
    api.get.mockResolvedValueOnce({ data: { id: "u1", tier: "FREE" } });

    render(
      <AuthProvider>
        <AuthStatusConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("token-status")).toHaveTextContent("AUTHENTICATED");
    });

    // Dispatch global auth:logout event
    act(() => {
      window.dispatchEvent(new Event("auth:logout"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("token-status")).toHaveTextContent("UNAUTHENTICATED");
    });
  });

  it("ProtectedRoute redirects unauthenticated visitors to landing page", () => {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<div>Public Landing Page</div>} />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <div>Secret Dashboard Content</div>
                </ProtectedRoute>
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    expect(screen.getByText("Public Landing Page")).toBeInTheDocument();
    expect(screen.queryByText("Secret Dashboard Content")).not.toBeInTheDocument();
  });

  it("ProtectedRoute renders protected content for authenticated users", async () => {
    const rawPayload = btoa(JSON.stringify({ tier: "PRO" }));
    localStorage.setItem("token", `h.${rawPayload}.s`);

    api.get.mockResolvedValueOnce({ data: { id: "u1", tier: "PRO" } });

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<div>Public Landing Page</div>} />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <div>Secret Dashboard Content</div>
                </ProtectedRoute>
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Secret Dashboard Content")).toBeInTheDocument();
    });
  });
});
