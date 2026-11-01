import React, { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import AuthSuccess from "./pages/AuthSuccess.jsx";
import { useAuth } from "./context/AuthContext.jsx";

// Route-level code-splitting with React.lazy
const LandingPage = lazy(() => import("./pages/LandingPage.jsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.jsx"));
const ConnectRepo = lazy(() => import("./pages/ConnectRepo.jsx"));
const Logs = lazy(() => import("./pages/Logs.jsx"));
const Pricing = lazy(() => import("./pages/Pricing.jsx"));
const PreviewMetrics = lazy(() => import("./pages/PreviewMetrics.jsx"));

function PageLoader() {
  return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-black border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { token, loading } = useAuth();

  if (loading) return <PageLoader />;

  return token ? children : <Navigate to="/" replace />;
}

function AppRoutes() {
  const { token } = useAuth();

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* OAuth callback → saves token → redirects */}
        <Route path="/auth/success" element={<AuthSuccess />} />

        {/* Public Landing */}
        <Route path="/" element={<LandingPage />} />

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

        {/* Metrics */}
        <Route
          path="/metrics/:id"
          element={
            <ProtectedRoute>
              <PreviewMetrics />
            </ProtectedRoute>
          }
        />

        {/* If logged in and they try an unknown route → /dashboard */}
        <Route
          path="*"
          element={token ? <Navigate to="/dashboard" replace /> : <Navigate to="/" replace />}
        />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
