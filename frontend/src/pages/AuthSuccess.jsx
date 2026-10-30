import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function AuthSuccess() {
  const navigate = useNavigate();
  const { login } = useAuth();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");

    // Immediately scrub sensitive JWT from URL bar and browser history
    if (window.history?.replaceState) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    if (token) {
      login(token);
      navigate("/dashboard", { replace: true });
    } else {
      navigate("/", { replace: true });
    }
  }, [login, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#fafafa] text-gray-500 text-sm font-sans">
      Authenticating...
    </div>
  );
}
