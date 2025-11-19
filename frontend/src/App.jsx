import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import AuthSuccess from "./pages/AuthSuccess.jsx";
import ConnectRepo from "./pages/ConnectRepo.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Logs from "./pages/Logs.jsx";

export default function App() {
  const token = localStorage.getItem("token");

  const LoginPage = () => (
    <div className="flex items-center justify-center min-h-screen">
      <a
        href="http://localhost:4000/auth/github"
        className="px-4 py-2 bg-black text-white rounded"
      >
        Sign in with GitHub
      </a>
    </div>
  );

  return (
    <BrowserRouter>
      <Routes>

        {/* OAuth callback */}
        <Route path="/auth/success" element={<AuthSuccess />} />

        {/* Dashboard (home) */}
        <Route
          path="/"
          element={token ? <Dashboard /> : <LoginPage />}
        />

        {/* Connect repo */}
        <Route
          path="/connect"
          element={token ? <ConnectRepo /> : <Navigate to="/" />}
        />

        {/* Live Logs */}
        <Route
          path="/logs/:id"
          element={token ? <Logs /> : <Navigate to="/" />}
        />

      </Routes>
    </BrowserRouter>
  );
}
