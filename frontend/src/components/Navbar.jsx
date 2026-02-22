import React, { useState, useEffect } from "react";
import { Layout } from "lucide-react";
import { Link, useNavigate, useLocation } from "react-router-dom"; 

export default function Navbar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [isScrolled, setIsScrolled] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    const token = localStorage.getItem("token");
    setIsLoggedIn(!!token);

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const handleAuthAction = () => {
    if (isLoggedIn) {
      navigate("/dashboard");
    } else {
      window.location.href = "http://localhost:4000/auth/github";
    }
  };

  const isLandingPage = location.pathname === "/";

  const handleLogoClick = () => {
    if (isLandingPage) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      navigate('/');
    }
  };

  const NavLink = ({ to, children }) => {
    const isActive = location.pathname === to;
    return (
      <Link 
        to={to}
        className={`text-sm font-medium transition-colors duration-200 ${
          isActive ? "text-gray-900" : "text-gray-500 hover:text-gray-900"
        }`}
      >
        {children}
      </Link>
    );
  };

  return (
    <nav
      className={`fixed top-0 z-50 w-full transition-all duration-300 ${
        isScrolled 
          ? "bg-white/80 backdrop-blur-xl border-b border-gray-200/80 supports-[backdrop-filter]:bg-white/60" 
          : "bg-transparent border-b border-transparent"
      }`}
    >
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        
        {/* Logo Section */}
        <div 
          // Changed: text-neutral-900 -> text-gray-900
          className="flex items-center gap-2.5 font-bold text-lg tracking-tight cursor-pointer text-gray-900 select-none group" 
          onClick={handleLogoClick}
        >
          {/* Changed: bg-neutral-900 -> bg-black */}
          <div className="p-1.5 bg-black text-white rounded-lg shadow-sm group-hover:bg-gray-800 transition-colors">
            <Layout size={16} strokeWidth={2.5} />
          </div>
          PreviewFlow
        </div>

        <div className="flex items-center gap-8">
          <div className="hidden sm:flex items-center gap-8">
            <NavLink to="/">Features</NavLink>
            <NavLink to="/pricing">Pricing</NavLink>
            <a href="#" className="text-sm font-medium text-gray-500 hover:text-gray-900 transition-colors">Docs</a>
          </div>

          <div className="h-4 w-[1px] bg-gray-200 hidden sm:block"></div>

          <button 
            onClick={handleAuthAction}
            className="text-sm font-medium px-5 py-2 bg-black text-white rounded-full hover:bg-gray-800 transition-all shadow-[0_2px_10px_rgba(0,0,0,0.1)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.15)] active:scale-95 hover:-translate-y-0.5"
          >
            {isLoggedIn ? "Dashboard" : "Log In"}
          </button>
        </div>
      </div>
    </nav>
  );
}