import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import ConnectRepo from "./pages/ConnectRepo.jsx";
import AuthSuccess from "./pages/AuthSuccess.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Logs from "./pages/Logs.jsx";
import LandingPage from "./pages/LandingPage.jsx";
import Pricing from "./pages/Pricing.jsx";
import PreviewMetrics from "./pages/PreviewMetrics.jsx";

import { AuthProvider, useAuth } from "./context/AuthContext.jsx";

function ProtectedRoute({ children }) {
  const { token, loading } = useAuth();

  if (loading) return <div>Loading...</div>;

  return token ? children : <Navigate to="/" replace />;
}

function AppRoutes() {
  const { token } = useAuth();

  return (
    <Routes>

      {/* OAuth callback → saves token → redirects */}
      <Route path="/auth/success" element={<AuthSuccess />} />

      {/* Public Landing */}
      <Route
        path="/"
        element={<LandingPage />}
      />

      {/* Dashboard */}
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />

      {/* Pricing (public) */}
      <Route path="/pricing" element={<Pricing />} />

      {/* Connect Repo */}
      <Route
        path="/connect"
        element={
          <ProtectedRoute>
            <ConnectRepo />
          </ProtectedRoute>
        }
      />

      {/* Logs */}
      <Route
        path="/logs/:id"
        element={
          <ProtectedRoute>
            <Logs />
          </ProtectedRoute>
        }
      />

      {/* If logged in and they try an unknown route → /dashboard */}
      <Route
        path="*"
        element={token ? <Navigate to="/dashboard" replace /> : <Navigate to="/" replace />}
      />

      <Route path="/metrics/:id" element={<PreviewMetrics />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
