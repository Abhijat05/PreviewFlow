import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { 
  Github, GitPullRequest, Terminal, Globe, Layout, 
  Zap, ArrowRight, ShieldCheck, 
  RotateCcw, MessageSquare, BarChart3, ChevronRight, 
  Loader2, Code2, Box, Lock, Server, Check, Copy, X, ExternalLink, BookOpen, Mail, Sparkles
} from "lucide-react";
import Navbar from "../components/Navbar.jsx"; 
import Footer from "../components/Footer.jsx"; 
import Toast from "../components/Toast.jsx";
import { cn } from "../lib/utils.js";
import { API_BASE_URL } from "../api.js"; 

export default function LandingPage() {
  const navigate = useNavigate();
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [showDocsModal, setShowDocsModal] = useState(false);
  const [showContactModal, setShowContactModal] = useState(false);
  const [contactEmail, setContactEmail] = useState("");
  const [contactMsg, setContactMsg] = useState("");
  const [toast, setToast] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem("token");
    setIsLoggedIn(!!token);
  }, []);

  const handlePrimaryAction = () => {
    if (isLoggedIn) {
      navigate("/dashboard");
    } else {
      window.location.href = `${API_BASE_URL}/auth/github`;
    }
  };

  const handleCopyPreviewUrl = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText("https://pr-123.previewflow.app");
    }
    setCopiedUrl(true);
    setToast({ message: "Preview URL copied to clipboard!", type: "success" });
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const handleContactSubmit = (e) => {
    e.preventDefault();
    if (!contactEmail) {
      setToast({ message: "Please provide your email address.", type: "warning" });
      return;
    }
    setShowContactModal(false);
    setContactEmail("");
    setContactMsg("");
    setToast({ message: "Thank you! Our enterprise team will reach out shortly.", type: "success" });
  };

  return (
    <div className="min-h-screen bg-white text-gray-900 font-sans selection:bg-black selection:text-white relative overflow-x-hidden">
      
      <Navbar />

      <main className="flex flex-col items-center w-full">
        
        {/* --- HERO SECTION --- */}
        <section className="w-full max-w-[1400px] px-6 pt-24 pb-20 text-center relative">
          
          {/* The "Box Grid" Background */}
          <div className="absolute inset-0 -z-10 h-full w-full bg-white bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]"></div>

          {/* Announcement Pill: Live release badge */}
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-700 mb-6 flex justify-center">
            <a 
              href="#workflow"
              className="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white/80 backdrop-blur-sm px-3.5 py-1 text-xs font-medium text-gray-700 transition-all hover:border-gray-300 hover:text-black cursor-pointer shadow-sm group"
            >
              <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              <span>PreviewFlow v2.0 is live</span>
              <ArrowRight size={12} className="text-gray-400 group-hover:translate-x-0.5 transition-transform" />
            </a>
          </div>

          <h1 className="text-5xl md:text-7xl lg:text-8xl font-bold tracking-tighter text-gray-950 mb-6 max-w-5xl mx-auto leading-[0.95] animate-in fade-in slide-in-from-bottom-6 duration-700">
            Automated previews <br className="hidden md:block" />
            for every <span className="text-gray-500">Pull Request.</span>
          </h1>

          <p className="text-lg md:text-xl text-gray-600 max-w-2xl mx-auto mb-8 leading-relaxed font-normal animate-in fade-in slide-in-from-bottom-8 duration-700">
             Stop waiting for staging. PreviewFlow automatically builds and deploys your PRs to a unique URL. 
             Review code changes live, instantly.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 animate-in fade-in slide-in-from-bottom-10 duration-700 mb-4">
            <button 
              type="button"
              onClick={handlePrimaryAction}
              className="h-12 px-8 rounded-full bg-black text-white font-medium text-sm hover:bg-gray-800 transition-all flex items-center gap-2 shadow-lg hover:shadow-xl hover:-translate-y-0.5"
            >
              {isLoggedIn ? <Layout size={18} /> : <Github size={18} />}
              {isLoggedIn ? "Go to Dashboard" : "Connect with GitHub"}
            </button>
            <button 
              type="button"
              onClick={() => setShowDocsModal(true)}
              className="h-12 px-8 rounded-full bg-white text-gray-700 border border-gray-200 font-medium text-sm hover:bg-gray-50 hover:text-black transition-all flex items-center gap-2 shadow-sm hover:shadow-md"
            >
              <BookOpen size={16} />
              Read Documentation
            </button>
          </div>

          {/* Security & Reassurance Micro-copy */}
          <div className="flex items-center justify-center gap-3 md:gap-4 text-xs text-gray-600 font-medium mb-12 flex-wrap">
            <span className="flex items-center gap-1.5"><ShieldCheck size={14} className="text-emerald-600" /> Read-only repo access</span>
            <span>•</span>
            <span>Ephemeral sandboxes</span>
            <span>•</span>
            <span>No code stored</span>
          </div>

          <div className="mb-16 animate-in fade-in slide-in-from-bottom-12 duration-1000">
             <p className="text-xs font-bold text-gray-600 mb-6 uppercase tracking-widest">Works seamlessly with</p>
             <div className="flex flex-wrap justify-center gap-8 md:gap-16 opacity-85 hover:opacity-100 transition-opacity duration-300">
                <TechBadge icon={<Github size={20}/>} label="GitHub" />
                <TechBadge icon={<Zap size={20}/>} label="Vite" />
                <TechBadge icon={<Code2 size={20}/>} label="React" />
                <TechBadge icon={<Server size={20}/>} label="Node.js" />
                <TechBadge icon={<Box size={20}/>} label="Docker" />
             </div>
          </div>

          <div className="relative mx-auto max-w-5xl animate-in fade-in zoom-in-95 duration-1000 delay-200 group">
            <div className="absolute -inset-1 bg-gradient-to-r from-blue-500/20 via-purple-500/20 to-pink-500/20 rounded-2xl blur-xl opacity-50 group-hover:opacity-100 transition duration-1000"></div>
            
            <div className="relative rounded-xl border border-gray-200 bg-[#0a0a0a] shadow-2xl overflow-hidden ring-1 ring-white/10 text-left">
              <div className="bg-[#0a0a0a] border-b border-white/10 px-4 py-3 flex items-center justify-between">
                <div className="flex gap-2">
                  <div className="w-3 h-3 rounded-full bg-[#FF5F56]"></div>
                  <div className="w-3 h-3 rounded-full bg-[#FFBD2E]"></div>
                  <div className="w-3 h-3 rounded-full bg-[#27C93F]"></div>
                </div>
                <div className="text-[11px] text-gray-400 font-mono flex items-center gap-2">
                   <Lock size={10} /> previewflow-build-logs
                </div>
                <div className="w-12"></div>
              </div>
              <div className="p-0">
                 <TerminalSimulation />
              </div>
            </div>
          </div>
        </section>

        {/* --- WORKFLOW PIPELINE --- */}
        <section id="workflow" className="w-full bg-gray-50/50 py-32 border-y border-gray-200 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-[500px] h-[500px] bg-purple-100/50 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2 pointer-events-none"></div>
          
          <div className="max-w-6xl mx-auto px-6 relative z-10">
            <div className="text-center mb-20">
                <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-gray-900 mb-4">How it works</h2>
                <p className="text-gray-600 text-lg">From your terminal to a live URL, completely automated.</p>
            </div>
            
            <div className="flex flex-col lg:flex-row items-stretch justify-center gap-6 relative">
              <WorkflowCard step="01" title="Open a Pull Request" desc="Push your branch and open a PR. We detect the event via Webhooks instantly.">
                <div className="w-full h-32 bg-white rounded-lg border border-gray-200 shadow-[0_2px_8px_rgba(0,0,0,0.04)] flex flex-col overflow-hidden relative">
                   <div className="bg-gray-50 border-b border-gray-100 p-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                         <div className="bg-green-600 text-white p-0.5 rounded-sm"><GitPullRequest size={12}/></div>
                         <span className="text-[10px] font-bold text-gray-700">New Pull Request</span>
                      </div>
                   </div>
                   <div className="p-4 flex flex-col gap-2.5">
                      <div className="h-2 w-3/4 bg-gray-200 rounded animate-pulse"></div>
                      <div className="h-2 w-1/2 bg-gray-100 rounded"></div>
                      <div className="flex items-center gap-2 text-[10px] text-gray-600 font-mono mt-2">
                         <span className="bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded border border-blue-100">feat/dashboard-ui</span>
                         <ArrowRight size={8} />
                         <span className="bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded border border-gray-200">main</span>
                      </div>
                   </div>
                </div>
              </WorkflowCard>
              
              {/* Horizontal Chevron for Desktop, Vertical for Mobile */}
              <div className="hidden lg:flex flex-col justify-center text-gray-400"><ChevronRight size={32} strokeWidth={1.5} /></div>
              <div className="flex lg:hidden justify-center text-gray-400 py-1"><ChevronRight size={24} className="rotate-90" strokeWidth={1.5} /></div>
              
              <WorkflowCard step="02" title="Auto-Build & Deploy" desc="We clone your repo, install dependencies, and build a secluded environment.">
                <div className="w-full h-32 bg-[#1e1e1e] rounded-lg border border-gray-800 shadow-inner flex flex-col p-3 font-mono text-[10px] overflow-hidden relative">
                   <div className="text-gray-400 mb-2 flex justify-between border-b border-gray-700/50 pb-1 font-mono text-[11px]">
                      <span>Build #841</span>
                      <span className="text-emerald-400 flex items-center gap-1"><Loader2 size={10} className="animate-spin"/> Running</span>
                   </div>
                   <div className="space-y-1.5 opacity-90">
                      <div className="flex gap-2 text-gray-300"><span className="text-blue-400">➜</span><span>git clone repo...</span></div>
                      <div className="flex gap-2 text-gray-300"><span className="text-blue-400">➜</span><span>npm install...</span></div>
                      <div className="flex gap-2 text-white"><span className="text-emerald-400">➜</span><span>npm run build</span></div>
                   </div>
                   <div className="absolute bottom-0 left-0 w-full h-0.5 bg-gray-800 overflow-hidden">
                      <div className="h-full bg-emerald-500 w-1/3 animate-[loading_2s_ease-in-out_infinite]"></div>
                   </div>
                </div>
              </WorkflowCard>
              
              {/* Horizontal Chevron for Desktop, Vertical for Mobile */}
              <div className="hidden lg:flex flex-col justify-center text-gray-400"><ChevronRight size={32} strokeWidth={1.5} /></div>
              <div className="flex lg:hidden justify-center text-gray-400 py-1"><ChevronRight size={24} className="rotate-90" strokeWidth={1.5} /></div>

              <WorkflowCard step="03" title="Preview URL Ready" desc="Our bot comments the live URL directly on your PR. Click to review.">
                <div className="w-full h-32 bg-white rounded-lg border border-gray-200 shadow-[0_2px_8px_rgba(0,0,0,0.04)] flex flex-col p-4 relative justify-center">
                   <div className="flex gap-3">
                      <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center text-white shrink-0 shadow-sm border border-gray-200">
                         <Layout size={14} />
                      </div>
                      <div className="flex-1 bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-[10px] relative">
                         <div className="absolute top-3 -left-1.5 w-3 h-3 bg-gray-50 border-l border-b border-gray-200 transform rotate-45"></div>
                         <div className="font-bold text-gray-900 mb-1 flex items-center justify-between">
                            PreviewFlow Bot <span className="bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded text-[10px] font-semibold border border-gray-300">Bot</span>
                         </div>
                         <div className="text-gray-700 mb-2 leading-tight">Deployment successful! 🚀 <br/>Preview your changes here:</div>
                         <button
                            type="button"
                            onClick={handleCopyPreviewUrl}
                            className="w-full text-left bg-white text-blue-600 px-2 py-1.5 rounded border border-blue-100 font-mono shadow-sm cursor-pointer hover:bg-blue-50/50 flex items-center justify-between gap-1 group transition-colors"
                            title="Click to copy preview URL"
                         >
                            <span className="truncate group-hover:underline">https://pr-123.previewflow.app</span>
                            {copiedUrl ? (
                              <Check size={12} className="text-emerald-600 shrink-0" />
                            ) : (
                              <Copy size={12} className="text-gray-400 group-hover:text-blue-600 shrink-0" />
                            )}
                         </button>
                      </div>
                   </div>
                </div>
              </WorkflowCard>
            </div>
          </div>
        </section>

        {/* --- FEATURES GRID --- */}
        <section id="features" className="w-full bg-white border-t border-gray-100 relative z-10">
          <div className="max-w-7xl mx-auto py-24 px-6">
            <div className="mb-20 md:text-center max-w-3xl mx-auto">
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-gray-900 mb-6">Built for modern teams.</h2>
              <p className="text-gray-600 text-lg leading-relaxed">Everything you need to manage preview deployments at scale.</p>
            </div>
            <FeaturesSectionWithHoverEffects />
          </div>
        </section>

        {/* --- CTA SECTION --- */}
        <section className="w-full bg-black py-24 px-6 relative overflow-hidden">
           <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-white/10 rounded-full blur-[100px] pointer-events-none"></div>
           <div className="max-w-4xl mx-auto text-center relative z-10">
              <h2 className="text-4xl md:text-5xl font-bold text-white mb-6 tracking-tighter">Ready to ship faster?</h2>
              <p className="text-gray-300 text-lg mb-10 max-w-xl mx-auto">Join developers shipping code faster with automated previews. No credit card required.</p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <button 
                  type="button"
                  onClick={handlePrimaryAction} 
                  className="px-8 py-4 bg-white text-black rounded-full font-bold text-sm hover:bg-gray-200 transition-all shadow-[0_0_30px_rgba(255,255,255,0.2)] hover:scale-105 hover:shadow-[0_0_50px_rgba(255,255,255,0.4)]"
                >
                  {isLoggedIn ? "Go to Dashboard" : "Start for Free"}
                </button>
                <button 
                  type="button"
                  onClick={() => setShowContactModal(true)} 
                  className="px-8 py-4 bg-transparent border border-white/20 text-white rounded-full font-bold text-sm hover:bg-white/10 transition-all flex items-center gap-2"
                >
                  <Mail size={16} />
                  Contact Sales
                </button>
              </div>
           </div>
        </section>

      </main>

      <Footer />

      {/* --- QUICKSTART / DOCS MODAL --- */}
      {showDocsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl max-w-xl w-full p-6 shadow-2xl border border-gray-200 relative animate-in zoom-in-95 duration-200">
            <button 
              type="button"
              onClick={() => setShowDocsModal(false)}
              className="absolute top-4 right-4 p-2 text-gray-400 hover:text-black rounded-full hover:bg-gray-100 transition-colors"
              aria-label="Close modal"
            >
              <X size={18} />
            </button>
            <div className="flex items-center gap-2 text-black mb-3 font-bold text-lg">
              <BookOpen size={20} />
              Quickstart Documentation
            </div>
            <p className="text-sm text-gray-600 mb-5">
              Follow these three simple steps to enable automatic preview environments on your repository.
            </p>
            
            <div className="space-y-4 mb-6">
              <div className="p-3.5 bg-gray-50 rounded-xl border border-gray-100">
                <div className="text-xs font-bold text-gray-900 mb-1 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-black text-white inline-flex items-center justify-center text-[10px]">1</span>
                  Connect Your GitHub Repository
                </div>
                <p className="text-xs text-gray-600 pl-7">
                  Click "Connect with GitHub", authenticate via OAuth, and select which repositories to grant webhook and commit-status access.
                </p>
              </div>

              <div className="p-3.5 bg-gray-50 rounded-xl border border-gray-100">
                <div className="text-xs font-bold text-gray-900 mb-1 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-black text-white inline-flex items-center justify-center text-[10px]">2</span>
                  Configure Build Command
                </div>
                <p className="text-xs text-gray-600 pl-7">
                  PreviewFlow auto-detects Vite, React, Next.js, and static sites. Add optional environment variables directly from your dashboard.
                </p>
              </div>

              <div className="p-3.5 bg-gray-50 rounded-xl border border-gray-100">
                <div className="text-xs font-bold text-gray-900 mb-1 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-black text-white inline-flex items-center justify-center text-[10px]">3</span>
                  Open a Pull Request
                </div>
                <p className="text-xs text-gray-600 pl-7">
                  Every PR push creates an isolated ephemeral build. Our bot posts the live URL directly on your pull request!
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-gray-100 pt-4">
              <button
                type="button"
                onClick={() => {
                  setShowDocsModal(false);
                  handlePrimaryAction();
                }}
                className="px-5 py-2.5 bg-black text-white text-xs font-bold rounded-full hover:bg-gray-800 transition-all flex items-center gap-1.5 shadow-sm"
              >
                <Sparkles size={14} /> Get Started Now
              </button>
              <button
                type="button"
                onClick={() => setShowDocsModal(false)}
                className="px-4 py-2 text-xs font-medium text-gray-600 hover:text-black"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- CONTACT SALES / ENTERPRISE MODAL --- */}
      {showContactModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-gray-200 relative animate-in zoom-in-95 duration-200">
            <button 
              type="button"
              onClick={() => setShowContactModal(false)}
              className="absolute top-4 right-4 p-2 text-gray-400 hover:text-black rounded-full hover:bg-gray-100 transition-colors"
              aria-label="Close modal"
            >
              <X size={18} />
            </button>
            <div className="flex items-center gap-2 text-black mb-2 font-bold text-lg">
              <Mail size={20} />
              Talk to Our Enterprise Team
            </div>
            <p className="text-xs text-gray-600 mb-4">
              Looking for custom concurrency, self-hosted runners, VPC peering, or dedicated SLAs? Let's discuss your team's needs.
            </p>

            <form onSubmit={handleContactSubmit} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Work Email</label>
                <input 
                  type="email"
                  required
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="alex@company.com"
                  className="w-full px-3.5 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-black"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Tell us about your team</label>
                <textarea 
                  rows={3}
                  value={contactMsg}
                  onChange={(e) => setContactMsg(e.target.value)}
                  placeholder="Estimated team size, repositories, or specialized requirements..."
                  className="w-full px-3.5 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-black resize-none"
                />
              </div>

              <div className="pt-2 flex items-center justify-between">
                <a 
                  href="mailto:sales@previewflow.app?subject=PreviewFlow Enterprise Inquiry"
                  className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                >
                  <ExternalLink size={12} /> Email us directly
                </a>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-black text-white text-xs font-bold rounded-full hover:bg-gray-800 transition-all shadow-sm"
                >
                  Submit Inquiry
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <Toast 
          message={toast.message} 
          type={toast.type} 
          onClose={() => setToast(null)} 
        />
      )}
    </div>
  );
}

// --- SUBCOMPONENTS ---

function TechBadge({ icon, label }) {
  return (
    <div className="flex items-center gap-2 font-semibold text-gray-800">
      {icon} {label}
    </div>
  );
}

function FeaturesSectionWithHoverEffects() {
  const features = [
    { title: "GitHub Integration", description: "One-click connect via OAuth. We handle webhooks, commit statuses, and bot comments automatically.", icon: <Github className="w-6 h-6" /> },
    { title: "Live Build Logs", description: "Watch your build process stream in real-time via WebSockets. Debug failures instantly.", icon: <Terminal className="w-6 h-6" /> },
    { title: "Smart Caching", description: "We cache dependencies and build artifacts to make subsequent previews lightning fast.", icon: <Zap className="w-6 h-6" /> },
    { title: "Usage Limits", description: "Set hard limits on build minutes and concurrent projects to control costs.", icon: <BarChart3 className="w-6 h-6" /> },
    { title: "Instant Rollbacks", description: "Revert to a previous stable preview hash with one click from the dashboard.", icon: <RotateCcw className="w-6 h-6" /> },
    { title: "Team Collaboration", description: "Share unique URLs with stakeholders. Comments on the PR appear in the dashboard.", icon: <MessageSquare className="w-6 h-6" /> },
    { title: "Secure by Design", description: "Isolated environments for every build. Secrets are encrypted at rest.", icon: <ShieldCheck className="w-6 h-6" /> },
    { title: "Global Edge", description: "Deployments are served from the edge for minimal latency worldwide.", icon: <Globe className="w-6 h-6" /> },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 relative z-10 border-t border-l border-gray-200 bg-white shadow-xs rounded-2xl overflow-hidden">
      {features.map((feature, index) => (
        <Feature key={feature.title} {...feature} index={index} />
      ))}
    </div>
  );
}

const Feature = ({ title, description, icon }) => {
  return (
    <div className={cn("flex flex-col border-b border-r border-gray-200 py-10 relative group/feature bg-white hover:bg-gray-50/80 transition-colors duration-300")}>
      <div className="mb-4 relative z-10 px-10 text-gray-600 group-hover/feature:text-black transition-colors">{icon}</div>
      <h3 className="text-lg font-bold mb-2 relative z-10 px-10 text-gray-950">
        <div className="absolute left-0 top-1/2 -translate-y-1/2 h-6 group-hover/feature:h-8 w-1 rounded-tr-full rounded-br-full bg-gray-300 group-hover/feature:bg-black transition-all duration-200" />
        <span className="group-hover/feature:translate-x-2 transition duration-200 inline-block">{title}</span>
      </h3>
      <p className="text-sm text-gray-600 max-w-xs relative z-10 px-10 leading-relaxed">{description}</p>
    </div>
  );
};

function WorkflowCard({ step, title, desc, children }) {
  return (
    <div className="flex-1 w-full max-w-sm relative z-10 flex flex-col bg-white p-6 rounded-2xl border border-gray-200 shadow-[0_4px_20px_rgba(0,0,0,0.03)] hover:shadow-[0_10px_30px_rgba(0,0,0,0.08)] hover:border-gray-300 hover:-translate-y-1 transition-all duration-300 group">
      <div className="mb-6 rounded-xl transition-colors">{children}</div>
      <div className="flex items-center gap-3 mb-3">
        <span className="text-xs font-bold text-white bg-black w-6 h-6 rounded-full flex items-center justify-center font-mono shadow-md">{step}</span>
        <h3 className="text-lg font-bold text-gray-900 tracking-tight">{title}</h3>
      </div>
      <p className="text-gray-600 text-sm leading-relaxed">{desc}</p>
    </div>
  );
}

function TerminalSimulation() {
  const [lines, setLines] = useState([
    { text: "git push origin feature/dashboard", color: "text-white" },
  ]);
  const scrollRef = useRef(null); 

  useEffect(() => {
    const sequence = [
      { text: "remote: Resolving deltas: 100% (12/12), completed.", color: "text-gray-400", delay: 800 },
      { text: "remote: Build triggered for commit a1b2c3d", color: "text-blue-400", delay: 1600 },
      { text: "✓ Building environment...", color: "text-emerald-400", delay: 2400 },
      { text: "✓ Installing dependencies...", color: "text-emerald-400", delay: 3000 },
      { text: "✓ Optimizing assets...", color: "text-emerald-400", delay: 3800 },
      { text: "→ Deployment URL: https://previewflow-pr-123.app", color: "text-blue-400 underline decoration-blue-400/30", delay: 4500 },
    ];

    let timeouts = [];
    sequence.forEach((item) => {
      timeouts.push(setTimeout(() => {
        setLines(prev => [...prev, item]);
      }, item.delay));
    });

    return () => timeouts.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  return (
    <div 
      ref={scrollRef}
      className="font-mono text-xs md:text-[13px] p-6 space-y-2.5 h-[300px] flex flex-col justify-start text-left font-medium overflow-y-auto scrollbar-hide scroll-smooth"
    >
      {lines.map((line, i) => (
        <div key={i} className={`${line.color} animate-in fade-in slide-in-from-left-2 duration-300 flex gap-3 shrink-0`}>
          {i === 0 && <span className="text-emerald-500 font-bold">➜</span>}
          <span>{line.text}</span>
        </div>
      ))}
      <div className="flex items-center gap-2 text-gray-400 animate-pulse mt-1 shrink-0">
        <span className="text-emerald-500 font-bold">➜</span>
        <span className="w-2.5 h-5 bg-gray-500"></span>
      </div>
    </div>
  );
}
