import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { 
  Github, GitPullRequest, Terminal, Globe, Layout, 
  Zap, ArrowRight, Twitter, Linkedin, ShieldCheck, 
  RotateCcw, MessageSquare, BarChart3, ChevronRight, 
  Loader2, Code2, Box, Lock, Server
} from "lucide-react";
import Navbar from "../components/Navbar.jsx"; 
import Footer from "../components/Footer.jsx"; 
import { cn } from "../lib/utils.js"; 

export default function LandingPage() {
  const navigate = useNavigate();
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("token");
    setIsLoggedIn(!!token);
  }, []);

  const handlePrimaryAction = () => {
    if (isLoggedIn) {
      navigate("/dashboard");
    } else {
      window.location.href = "http://localhost:4000/auth/github";
    }
  };

  return (
    <div className="min-h-screen bg-white text-gray-900 font-sans selection:bg-black selection:text-white relative overflow-x-hidden">
      
      <Navbar />

      <main className="flex flex-col items-center w-full">
        
        {/* --- HERO SECTION --- */}
        <section className="w-full max-w-[1400px] px-6 pt-24 pb-20 text-center relative">
          
          {/* UPDATED: The "Box Grid" Background (Exact match from Pricing Page) */}
          <div className="absolute inset-0 -z-10 h-full w-full bg-white bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]"></div>

          <div className="animate-in fade-in slide-in-from-bottom-4 duration-700 mb-6 flex justify-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white/80 backdrop-blur-sm px-3 py-1 text-xs font-medium text-gray-600 transition-colors hover:border-gray-300 hover:text-black cursor-pointer shadow-sm">
              <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              <span>v1.0 Public Beta is Live</span>
              <ArrowRight size={10} className="text-gray-400" />
            </div>
          </div>

          <h1 className="text-5xl md:text-7xl lg:text-8xl font-bold tracking-tighter text-gray-950 mb-6 max-w-5xl mx-auto leading-[0.95] animate-in fade-in slide-in-from-bottom-6 duration-700">
            Automated previews <br className="hidden md:block" />
            for every <span className="text-gray-400">Pull Request.</span>
          </h1>

          <p className="text-lg md:text-xl text-gray-500 max-w-2xl mx-auto mb-8 leading-relaxed font-medium animate-in fade-in slide-in-from-bottom-8 duration-700">
             Stop waiting for staging. PreviewFlow automatically builds and deploys your PRs to a unique URL. 
             Review code changes live, instantly.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 animate-in fade-in slide-in-from-bottom-10 duration-700 mb-12">
            <button 
              onClick={handlePrimaryAction}
              className="h-12 px-8 rounded-full bg-black text-white font-medium text-sm hover:bg-gray-800 transition-all flex items-center gap-2 shadow-lg hover:shadow-xl hover:-translate-y-0.5"
            >
              {isLoggedIn ? <Layout size={18} /> : <Github size={18} />}
              {isLoggedIn ? "Go to Dashboard" : "Connect with GitHub"}
            </button>
            <button className="h-12 px-8 rounded-full bg-white text-gray-700 border border-gray-200 font-medium text-sm hover:bg-gray-50 hover:text-black transition-all flex items-center gap-2 shadow-sm hover:shadow-md">
              Read Documentation
            </button>
          </div>

          <div className="mb-16 animate-in fade-in slide-in-from-bottom-12 duration-1000">
             <p className="text-xs font-semibold text-gray-400 mb-6 uppercase tracking-widest">Works seamlessly with</p>
             <div className="flex flex-wrap justify-center gap-8 md:gap-16 opacity-60 grayscale hover:grayscale-0 transition-all duration-500">
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
                <div className="text-[11px] text-gray-500 font-mono flex items-center gap-2">
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
        <section className="w-full bg-gray-50/50 py-32 border-y border-gray-200 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-[500px] h-[500px] bg-purple-100/50 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2 pointer-events-none"></div>
          
          <div className="max-w-6xl mx-auto px-6 relative z-10">
            <div className="text-center mb-20">
                <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-gray-900 mb-4">How it works</h2>
                <p className="text-gray-500 text-lg">From your terminal to a live URL, completely automated.</p>
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
                      <div className="flex items-center gap-2 text-[10px] text-gray-500 font-mono mt-2">
                         <span className="bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded border border-blue-100">feat/dashboard-ui</span>
                         <ArrowRight size={8} />
                         <span className="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded border border-gray-200">main</span>
                      </div>
                   </div>
                </div>
              </WorkflowCard>
              <div className="hidden lg:flex flex-col justify-center text-gray-300"><ChevronRight size={32} strokeWidth={1.5} /></div>
              
              <WorkflowCard step="02" title="Auto-Build & Deploy" desc="We clone your repo, install dependencies, and build a secluded environment.">
                <div className="w-full h-32 bg-[#1e1e1e] rounded-lg border border-gray-800 shadow-inner flex flex-col p-3 font-mono text-[10px] overflow-hidden relative">
                   <div className="text-gray-500 mb-2 flex justify-between border-b border-gray-700/50 pb-1">
                      <span>Build #841</span>
                      <span className="text-emerald-400 flex items-center gap-1"><Loader2 size={8} className="animate-spin"/> Running</span>
                   </div>
                   <div className="space-y-1.5 opacity-90">
                      <div className="flex gap-2 text-gray-400"><span className="text-blue-500">➜</span><span>git clone repo...</span></div>
                      <div className="flex gap-2 text-gray-400"><span className="text-blue-500">➜</span><span>npm install...</span></div>
                      <div className="flex gap-2 text-white"><span className="text-emerald-500">➜</span><span>npm run build</span></div>
                   </div>
                   <div className="absolute bottom-0 left-0 w-full h-0.5 bg-gray-800">
                      <div className="h-full bg-emerald-500 w-2/3 animate-[loading_2s_ease-in-out_infinite]"></div>
                   </div>
                </div>
              </WorkflowCard>
              <div className="hidden lg:flex flex-col justify-center text-gray-300"><ChevronRight size={32} strokeWidth={1.5} /></div>

              <WorkflowCard step="03" title="Preview URL Ready" desc="Our bot comments the live URL directly on your PR. Click to review.">
                <div className="w-full h-32 bg-white rounded-lg border border-gray-200 shadow-[0_2px_8px_rgba(0,0,0,0.04)] flex flex-col p-4 relative justify-center">
                   <div className="flex gap-3">
                      <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center text-white shrink-0 shadow-sm border border-gray-200">
                         <Layout size={14} />
                      </div>
                      <div className="flex-1 bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-[10px] relative">
                         <div className="absolute top-3 -left-1.5 w-3 h-3 bg-gray-50 border-l border-b border-gray-200 transform rotate-45"></div>
                         <div className="font-bold text-gray-900 mb-1 flex items-center justify-between">
                            PreviewFlow Bot <span className="bg-gray-200 text-gray-600 px-1 rounded text-[8px] font-medium border border-gray-300">Bot</span>
                         </div>
                         <div className="text-gray-600 mb-2 leading-tight">Deployment successful! 🚀 <br/>Preview your changes here:</div>
                         <div className="bg-white text-blue-600 px-2 py-1.5 rounded border border-blue-100 truncate font-mono shadow-sm cursor-pointer hover:underline">
                            https://pr-123.previewflow.app
                         </div>
                      </div>
                   </div>
                </div>
              </WorkflowCard>
            </div>
          </div>
        </section>

        {/* --- FEATURES GRID --- */}
        <section className="w-full bg-white border-t border-gray-100 relative z-10">
          <div className="max-w-7xl mx-auto py-24 px-6">
            <div className="mb-20 md:text-center max-w-3xl mx-auto">
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-gray-900 mb-6">Built for modern teams.</h2>
              <p className="text-gray-500 text-lg leading-relaxed">Everything you need to manage preview deployments at scale.</p>
            </div>
            <FeaturesSectionWithHoverEffects />
          </div>
        </section>

        {/* --- CTA SECTION --- */}
        <section className="w-full bg-black py-24 px-6 relative overflow-hidden">
           <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-white/10 rounded-full blur-[100px] pointer-events-none"></div>
           <div className="max-w-4xl mx-auto text-center relative z-10">
              <h2 className="text-4xl md:text-5xl font-bold text-white mb-6 tracking-tighter">Ready to ship faster?</h2>
              <p className="text-gray-400 text-lg mb-10 max-w-xl mx-auto">Join developers shipping code faster with automated previews. No credit card required.</p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <button onClick={handlePrimaryAction} className="px-8 py-4 bg-white text-black rounded-full font-bold text-sm hover:bg-gray-200 transition-all shadow-[0_0_30px_rgba(255,255,255,0.2)] hover:scale-105 hover:shadow-[0_0_50px_rgba(255,255,255,0.4)]">
                  {isLoggedIn ? "Go to Dashboard" : "Start for Free"}
                </button>
                <button className="px-8 py-4 bg-transparent border border-white/20 text-white rounded-full font-bold text-sm hover:bg-white/10 transition-all">
                  Contact Sales
                </button>
              </div>
           </div>
        </section>

      </main>

      <Footer />
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
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 relative z-10 border-l border-t border-gray-200 bg-white shadow-sm">
      {features.map((feature, index) => (
        <Feature key={feature.title} {...feature} index={index} />
      ))}
    </div>
  );
}

const Feature = ({ title, description, icon, index }) => {
  return (
    <div className={cn("flex flex-col lg:border-r py-10 relative group/feature border-b border-gray-200 bg-white hover:bg-gray-50 transition-colors duration-300")}>
      <div className="mb-4 relative z-10 px-10 text-gray-600 group-hover/feature:text-black transition-colors">{icon}</div>
      <div className="text-lg font-bold mb-2 relative z-10 px-10">
        <div className="absolute left-0 inset-y-0 h-6 group-hover/feature:h-8 w-1 rounded-tr-full rounded-br-full bg-gray-300 group-hover/feature:bg-black transition-all duration-200 origin-center" />
        <span className="group-hover/feature:translate-x-2 transition duration-200 inline-block text-gray-900">{title}</span>
      </div>
      <p className="text-sm text-gray-500 max-w-xs relative z-10 px-10 leading-relaxed">{description}</p>
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
      <p className="text-gray-500 text-sm leading-relaxed">{desc}</p>
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
      { text: "remote: Resolving deltas: 100% (12/12), completed.", color: "text-gray-500", delay: 800 },
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
      <div className="flex items-center gap-2 text-gray-600 animate-pulse mt-1 shrink-0">
        <span className="text-emerald-500 font-bold">➜</span>
        <span className="w-2.5 h-5 bg-gray-600"></span>
      </div>
    </div>
  );
}