import React from "react";
import { Github, Twitter, Linkedin, Layout } from "lucide-react";
import { Link } from "react-router-dom";

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="bg-white pt-20 pb-12 w-full border-t border-gray-200">
      <div className="max-w-7xl mx-auto px-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-10 mb-16">
          
          {/* Brand Column */}
          <div className="sm:col-span-2">
            <Link 
              to="/" 
              className="inline-flex items-center gap-2 font-bold text-gray-900 mb-4 text-lg tracking-tight select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-black rounded-lg"
              aria-label="PreviewFlow home"
            >
              <div className="p-1.5 bg-black text-white rounded-lg shadow-sm">
                <Layout size={16} strokeWidth={3} />
              </div>
              <span>PreviewFlow</span>
            </Link>
            <p className="text-sm text-gray-600 mb-6 max-w-xs leading-relaxed font-normal">
              Automated preview environments for every pull request. 
              Ship faster with live, isolated branch deployments.
            </p>
            <div className="flex gap-3">
              <SocialLink 
                icon={<Github size={18} />} 
                href="https://github.com" 
                label="PreviewFlow on GitHub" 
              />
              <SocialLink 
                icon={<Twitter size={18} />} 
                href="https://x.com" 
                label="PreviewFlow on X (Twitter)" 
              />
              <SocialLink 
                icon={<Linkedin size={18} />} 
                href="https://linkedin.com" 
                label="PreviewFlow on LinkedIn" 
              />
            </div>
          </div>
          
          {/* Product Links */}
          <div className="flex flex-col gap-4">
            <h4 className="font-semibold text-gray-900 text-sm tracking-tight">Product</h4>
            <ul className="flex flex-col gap-2.5 text-sm text-gray-600">
              <li>
                <a href="#features" className="hover:text-black transition-colors duration-200">
                  Features
                </a>
              </li>
              <li>
                <Link to="/pricing" className="hover:text-black transition-colors duration-200">
                  Pricing
                </Link>
              </li>
              <li>
                <a href="#workflow" className="hover:text-black transition-colors duration-200">
                  How it works
                </a>
              </li>
              <li>
                <a href="mailto:sales@previewflow.app?subject=Enterprise Inquiry" className="hover:text-black transition-colors duration-200">
                  Enterprise
                </a>
              </li>
            </ul>
          </div>

          {/* Resources Links */}
          <div className="flex flex-col gap-4">
            <h4 className="font-semibold text-gray-900 text-sm tracking-tight">Resources</h4>
            <ul className="flex flex-col gap-2.5 text-sm text-gray-600">
              <li>
                <a href="#workflow" className="hover:text-black transition-colors duration-200">
                  Documentation
                </a>
              </li>
              <li>
                <a href="mailto:support@previewflow.app" className="hover:text-black transition-colors duration-200">
                  Contact Support
                </a>
              </li>
              <li>
                <a href="https://github.com" target="_blank" rel="noopener noreferrer" className="hover:text-black transition-colors duration-200">
                  GitHub Community
                </a>
              </li>
              <li>
                <a href="mailto:sales@previewflow.app" className="hover:text-black transition-colors duration-200">
                  Talk to Sales
                </a>
              </li>
            </ul>
          </div>

          {/* Legal Links */}
          <div className="flex flex-col gap-4">
            <h4 className="font-semibold text-gray-900 text-sm tracking-tight">Legal & Trust</h4>
            <ul className="flex flex-col gap-2.5 text-sm text-gray-600">
              <li>
                <a href="#security" onClick={(e) => { e.preventDefault(); alert("Security: PreviewFlow uses ephemeral isolated Docker sandboxes. No user code is retained."); }} className="hover:text-black transition-colors duration-200">
                  Security Overview
                </a>
              </li>
              <li>
                <span className="text-gray-500 text-xs py-1 inline-block">
                  Privacy Policy (Standard)
                </span>
              </li>
              <li>
                <span className="text-gray-500 text-xs py-1 inline-block">
                  Terms of Service
                </span>
              </li>
              <li>
                <span className="text-gray-500 text-xs py-1 inline-block">
                  Cookie Preferences
                </span>
              </li>
            </ul>
          </div>

        </div>
        
        {/* Bottom Bar */}
        <div className="border-t border-gray-200 pt-8 flex flex-col md:flex-row justify-between items-center gap-4 text-xs font-medium text-gray-500">
          <p>© {currentYear} PreviewFlow Inc. All rights reserved.</p>
          
          <div className="flex gap-6">
            <span className="text-gray-500">SOC2 Type II Ready</span>
            <span className="text-gray-300">•</span>
            <span className="text-gray-500">99.9% Uptime SLA</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

// --- SUBCOMPONENTS ---

function SocialLink({ icon, href, label }) {
  return (
    <a 
      href={href} 
      target="_blank" 
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="w-9 h-9 flex items-center justify-center rounded-full bg-gray-50 border border-gray-200 text-gray-600 hover:bg-black hover:border-black hover:text-white transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-black"
    >
      {icon}
    </a>
  );
}
