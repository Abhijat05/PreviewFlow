import React, { useState, useEffect } from "react";
import { Layout, Menu, X, ArrowRight, BookOpen, Sparkles } from "lucide-react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { API_BASE_URL } from "../api.js"; 
import { useAuth } from "../context/AuthContext.jsx";

export default function Navbar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = useAuth();
  const isLoggedIn = !!token;
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Close mobile menu when changing route
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  const handleAuthAction = () => {
    if (isLoggedIn) {
      navigate("/dashboard");
    } else {
      window.location.href = `${API_BASE_URL}/auth/github`;
    }
  };

  const isLandingPage = location.pathname === "/";

  const handleLogoClick = (e) => {
    if (isLandingPage) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleFeaturesClick = (e) => {
    if (isLandingPage) {
      e.preventDefault();
      const el = document.getElementById("features");
      if (el) {
        el.scrollIntoView({ behavior: "smooth" });
      }
    }
    setMobileMenuOpen(false);
  };

  const handleWorkflowClick = (e) => {
    if (isLandingPage) {
      e.preventDefault();
      const el = document.getElementById("workflow");
      if (el) {
        el.scrollIntoView({ behavior: "smooth" });
      }
    }
    setMobileMenuOpen(false);
  };

  return (
    <nav
      aria-label="Main navigation"
      className={`fixed top-0 z-50 w-full transition-all duration-300 ${
        isScrolled || mobileMenuOpen
          ? "bg-white/90 backdrop-blur-xl border-b border-gray-200/80 shadow-xs supports-[backdrop-filter]:bg-white/75" 
          : "bg-transparent border-b border-transparent"
      }`}
    >
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        
        {/* Semantic Accessible Logo */}
        <Link 
          to="/" 
          onClick={handleLogoClick}
          aria-label="PreviewFlow homepage"
          className="flex items-center gap-2.5 font-bold text-lg tracking-tight text-gray-900 select-none group focus:outline-none focus-visible:ring-2 focus-visible:ring-black rounded-lg"
        >
          <div className="p-1.5 bg-black text-white rounded-lg shadow-sm group-hover:bg-gray-800 transition-colors">
            <Layout size={16} strokeWidth={2.5} />
          </div>
          <span>PreviewFlow</span>
        </Link>

        {/* Desktop Navigation */}
        <div className="hidden sm:flex items-center gap-8">
          <a 
            href="#features" 
            onClick={handleFeaturesClick}
            className="text-sm font-medium text-gray-600 hover:text-gray-950 transition-colors"
          >
            Features
          </a>
          <a 
            href="#workflow" 
            onClick={handleWorkflowClick}
            className="text-sm font-medium text-gray-600 hover:text-gray-950 transition-colors"
          >
            How it works
          </a>
          <Link 
            to="/pricing"
            className={`text-sm font-medium transition-colors ${
              location.pathname === "/pricing" ? "text-gray-950 font-semibold" : "text-gray-600 hover:text-gray-950"
            }`}
          >
            Pricing
          </Link>
        </div>

        {/* Desktop CTA & Mobile Toggle */}
        <div className="flex items-center gap-3">
          <button 
            type="button"
            onClick={handleAuthAction}
            className="hidden sm:inline-flex text-sm font-medium px-5 py-2 bg-black text-white rounded-full hover:bg-gray-800 transition-all shadow-[0_2px_10px_rgba(0,0,0,0.1)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.15)] active:scale-95 hover:-translate-y-0.5"
          >
            {isLoggedIn ? "Dashboard" : "Log In"}
          </button>

          {/* Mobile Hamburger Button */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileMenuOpen}
            className="sm:hidden p-2 text-gray-700 hover:text-black hover:bg-gray-100 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-black"
          >
            {mobileMenuOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="sm:hidden border-b border-gray-200 bg-white/95 backdrop-blur-xl px-6 pt-3 pb-6 animate-in slide-in-from-top-2 duration-200 shadow-xl">
          <div className="flex flex-col gap-3">
            <a
              href="#features"
              onClick={handleFeaturesClick}
              className="px-3 py-2.5 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-black flex items-center justify-between"
            >
              <span>Features</span>
              <ArrowRight size={14} className="text-gray-400" />
            </a>
            <a
              href="#workflow"
              onClick={handleWorkflowClick}
              className="px-3 py-2.5 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-black flex items-center justify-between"
            >
              <span>How it works</span>
              <ArrowRight size={14} className="text-gray-400" />
            </a>
            <Link
              to="/pricing"
              onClick={() => setMobileMenuOpen(false)}
              className={`px-3 py-2.5 rounded-lg text-sm font-medium flex items-center justify-between ${
                location.pathname === "/pricing"
                  ? "bg-gray-100 text-black font-semibold"
                  : "text-gray-700 hover:bg-gray-100 hover:text-black"
              }`}
            >
              <span>Pricing</span>
              <ArrowRight size={14} className="text-gray-400" />
            </Link>

            <div className="h-px bg-gray-200 my-1"></div>

            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                handleAuthAction();
              }}
              className="w-full py-3 bg-black text-white text-sm font-medium rounded-full shadow-md hover:bg-gray-800 transition-all flex items-center justify-center gap-2"
            >
              <Sparkles size={16} />
              {isLoggedIn ? "Go to Dashboard" : "Log In with GitHub"}
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}
