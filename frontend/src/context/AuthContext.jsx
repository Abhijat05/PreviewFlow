import { createContext, useContext, useEffect, useState, useCallback } from "react";
import api from "../api.js";

const AuthContext = createContext();

function getFallbackTier(rawToken) {
  try {
    if (!rawToken) return "FREE";
    const base64Url = rawToken.split(".")[1];
    if (!base64Url) return "FREE";
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(window.atob(base64));
    return (payload.tier || "FREE").toUpperCase();
  } catch {
    return "FREE";
  }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem("token"));
  const [user, setUser] = useState(null);
  const [tier, setTier] = useState(() => getFallbackTier(localStorage.getItem("token")));
  const [loading, setLoading] = useState(true);

  const fetchUserProfile = useCallback(async (authToken) => {
    if (!authToken) {
      setUser(null);
      setTier("FREE");
      return;
    }
    try {
      const res = await api.get("/api/user/me");
      if (res.data) {
        setUser(res.data);
        if (res.data.tier) {
          setTier(res.data.tier.toUpperCase());
        }
      }
    } catch (err) {
      console.warn("Failed to fetch fresh user profile from DB:", err?.message || err);
    }
  }, []);

  const refreshUser = useCallback(async () => {
    const currentToken = localStorage.getItem("token");
    if (currentToken) {
      await fetchUserProfile(currentToken);
    }
  }, [fetchUserProfile]);

  useEffect(() => {
    const stored = localStorage.getItem("token");
    setToken(stored);
    if (stored) {
      setTier(getFallbackTier(stored));
      fetchUserProfile(stored).finally(() => setLoading(false));
    } else {
      setLoading(false);
    }

    const handleSyncLogout = () => {
      setToken(null);
      setUser(null);
      setTier("FREE");
    };

    const handleStorageChange = (e) => {
      if (e.key === "token") {
        setToken(e.newValue);
        if (e.newValue) {
          setTier(getFallbackTier(e.newValue));
          fetchUserProfile(e.newValue);
        } else {
          setUser(null);
          setTier("FREE");
        }
      }
    };

    window.addEventListener("auth:logout", handleSyncLogout);
    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("auth:logout", handleSyncLogout);
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [fetchUserProfile]);

  const login = (newToken) => {
    localStorage.setItem("token", newToken);
    setToken(newToken);
    setTier(getFallbackTier(newToken));
    fetchUserProfile(newToken);
  };

  const logout = () => {
    localStorage.removeItem("token");
    setToken(null);
    setUser(null);
    setTier("FREE");
  };

  return (
    <AuthContext.Provider value={{ token, user, tier, login, logout, loading, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
