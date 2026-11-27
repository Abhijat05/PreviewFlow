import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import api from "../api.js";
import { useAuth } from "../context/AuthContext.jsx";

export default function AuthSuccess() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const processedRef = useRef(false);

  useEffect(() => {
    if (processedRef.current) return;
    processedRef.current = true;

    const searchStr = location.search || window.location.search;
    const params = new URLSearchParams(searchStr);
    const code = params.get("code");
    const legacyToken = params.get("token");

    // Immediately scrub sensitive auth code or token from URL bar and browser history
    if (window.history?.replaceState) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    async function completeAuth() {
      if (code) {
        try {
          const res = await api.post("/auth/exchange", { code });
          if (res.data?.token) {
            login(res.data.token);
            navigate("/dashboard", { replace: true });
            return;
          }
        } catch (err) {
          console.error("Auth code exchange failed:", err?.message || err);
        }
        navigate("/", { replace: true });
        return;
      }

      if (legacyToken) {
        login(legacyToken);
        navigate("/dashboard", { replace: true });
        return;
      }

      navigate("/", { replace: true });
    }

    completeAuth();
  }, [location.search, login, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#fafafa] text-gray-500 text-sm font-sans">
      Authenticating...
    </div>
  );
}
