import React, { useEffect, useState, useRef, useCallback } from "react";
import axios from "axios";
import io from "socket.io-client";
import { useNavigate } from "react-router-dom";
import Logs from "./Logs.jsx"; 
import PlanChangeModal from "../components/PlanChangeModal.jsx"; 

import {
  GitPullRequest, RefreshCw, Trash2, ExternalLink, CheckCircle2, XCircle, Clock, Terminal, Loader2,
  AlertCircle, ArrowRight, Globe, Ban, Archive, Layout, PlusCircle, Github, Zap, Lock, Crown, AlertTriangle, X, CheckCircle, Settings,
  Activity, MemoryStick // Added these for the Resource Monitor
} from "lucide-react";

// --- TIER CONFIGURATION ---
const TIER_CONFIG = {
  FREE: { label: 'Free', color: 'bg-gray-100 text-gray-600 border-gray-200', concurrentBuilds: 1 },
  HOBBY: { label: 'Hobby', color: 'bg-blue-50 text-blue-600 border-blue-200', concurrentBuilds: 1 },
  PRO: { label: 'Pro', color: 'bg-indigo-50 text-indigo-600 border-indigo-200', concurrentBuilds: Infinity },
  ENTERPRISE: { label: 'Enterprise', color: 'bg-slate-900 text-amber-400 border-slate-700', concurrentBuilds: Infinity }
};

const getUserTier = (token) => {
  try {
    if (!token) return 'FREE';
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(window.atob(base64));
    return (payload.tier || 'FREE').toUpperCase();
  } catch (e) {
    return 'FREE';
  }
};

const socket = io("http://localhost:4000", { transports: ["websocket"] });

// --- HELPERS ---
function formatDuration(seconds) { 
  if (!seconds && seconds !== 0) return ""; 
  const numSeconds = parseFloat(seconds); 
  if (numSeconds < 60) return `${numSeconds.toFixed(0)}s`; 
  const m = Math.floor(numSeconds / 60); 
  const s = Math.floor(numSeconds % 60); 
  return `${m}m ${s}s`; 
}

function getStatusVisuals(status) { 
  switch (status) { 
    case "live": return { badge: "bg-emerald-50 text-emerald-700 border-emerald-200 shadow-[0_0_10px_rgba(16,185,129,0.1)]", icon: <CheckCircle2 className="w-3.5 h-3.5" />, label: "Ready", border: "group-hover:border-emerald-500/50 bg-white border-gray-200", ring: "" }; 
    case "building": return { badge: "bg-amber-50 text-amber-700 border-amber-200", icon: <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-600" />, label: "Building", border: "border-amber-400 bg-white", ring: "ring-4 ring-amber-500/10" }; 
    case "error": return { badge: "bg-red-50 text-red-700 border-red-200", icon: <XCircle className="w-3.5 h-3.5" />, label: "Error", border: "group-hover:border-red-500/50 bg-white border-gray-200", ring: "" }; 
    case "deleted": return { badge: "bg-gray-100 text-gray-600 border-gray-200", icon: <Archive className="w-3.5 h-3.5" />, label: "Archived", border: "border-gray-300 border-dashed bg-gray-50/50", ring: "" }; 
    default: return { badge: "bg-gray-100 text-gray-600 border-gray-200", icon: <Clock className="w-3.5 h-3.5" />, label: "Queued", border: "group-hover:border-gray-400/50 bg-white border-gray-200", ring: "" }; 
  } 
}

function formatBytesToMB(bytes) {
  if (bytes === 0 || !bytes) return 0;
  return (bytes / (1024 * 1024)).toFixed(0);
}

// --- COMPONENTS ---
const LiveBuildTimer = ({ startTime }) => {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = new Date(startTime).getTime();
    const interval = setInterval(() => setElapsed((Date.now() - start) / 1000), 1000);
    return () => clearInterval(interval);
  }, [startTime]);
  return <span>{formatDuration(elapsed)}</span>;
};

// Toast Component
const Toast = ({ message, type, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 4000); 
    return () => clearTimeout(timer);
  }, [onClose]);

  const styles = {
    error: 'bg-red-50 border-red-200 text-red-800',
    warning: 'bg-amber-50 border-amber-200 text-amber-800',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  };

  const icons = {
    error: <AlertCircle size={18} />,
    warning: <AlertTriangle size={18} />,
    success: <CheckCircle size={18} />,
  };

  return (
    <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-5 fade-in duration-300">
      <div className={`flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border ${styles[type] || styles.warning}`}>
        {icons[type] || icons.warning}
        <span className="text-sm font-medium">{message}</span>
        <button onClick={onClose} className="ml-2 hover:bg-black/5 p-1 rounded-full transition-colors"><X size={14} /></button>
      </div>
    </div>
  );
};

// --- NEW: Resource Monitor Component ---
const ResourceMonitor = ({ stats }) => {
  if (!stats) {
    return (
      <div className="mt-3 pt-3 border-t border-gray-100 animate-pulse flex flex-col gap-2">
        <div className="h-1.5 bg-gray-100 rounded-full w-full"></div>
        <div className="h-1.5 bg-gray-100 rounded-full w-3/4"></div>
      </div>
    );
  }

  const { cpu, memory } = stats;
  const memoryMB = formatBytesToMB(memory);
  
  const isCpuHigh = cpu > 70;
  const isMemoryHigh = memoryMB > 400; // Adjust max threshold as needed

  return (
    <div className="mt-3 pt-3 border-t border-gray-100 space-y-2.5">
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center text-[10px] text-gray-500 font-mono uppercase">
          <span className="flex items-center gap-1"><Activity className="w-3 h-3" /> CPU</span>
          <span className={isCpuHigh ? "text-red-500 font-bold" : ""}>{cpu.toFixed(1)}%</span>
        </div>
        <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
          <div 
            className={`h-full transition-all duration-500 ease-out ${isCpuHigh ? "bg-red-500" : "bg-gray-800"}`}
            style={{ width: `${Math.min(cpu, 100)}%` }}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-center text-[10px] text-gray-500 font-mono uppercase">
          <span className="flex items-center gap-1"><MemoryStick className="w-3 h-3" /> RAM</span>
          <span className={isMemoryHigh ? "text-amber-500 font-bold" : ""}>{memoryMB} MB</span>
        </div>
        <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
          <div 
            className={`h-full transition-all duration-500 ease-out ${isMemoryHigh ? "bg-amber-500" : "bg-gray-800"}`}
            style={{ width: `${Math.min((memoryMB / 512) * 100, 100)}%` }} 
          />
        </div>
      </div>
    </div>
  );
};

// --- NEW: Memoized Preview Card ---
// This prevents all cards from re-rendering when one card gets a stats socket update
const PreviewCard = React.memo(({ pre, stats, isProcessing, onRebuild, onDeleteConfirm, onViewLogs }) => {
  const statusStyle = getStatusVisuals(pre.status);
  const isDeleted = pre.status === "deleted";
  const isBuilding = pre.status === "building";
  const showTime = !isDeleted && pre.status !== 'queued';

  let timeDisplay = null;
  if (isBuilding) {
    timeDisplay = <span className="text-amber-600 animate-pulse"><LiveBuildTimer startTime={pre.buildStartedAt} /></span>;
  } else if (pre.buildCompletedAt && pre.buildStartedAt) {
    const diff = (new Date(pre.buildCompletedAt) - new Date(pre.buildStartedAt)) / 1000;
    timeDisplay = formatDuration(diff);
  } else {
    timeDisplay = "Pending...";
  }

  return (
    // Changed h-[280px] to min-h-[280px] h-auto so the new monitor fits without squishing
    <div className={`group relative border rounded-2xl shadow-sm transition-all duration-300 ease-out flex flex-col overflow-hidden min-h-[280px] h-auto ${statusStyle.border} ${statusStyle.ring} ${!isDeleted && !isBuilding ? 'hover:shadow-xl hover:-translate-y-1' : ''}`}>
      {isBuilding && (
        <div className="absolute bottom-0 left-0 w-full h-1 bg-amber-100 overflow-hidden z-20">
          <div className="h-full bg-amber-400 animate-progress-indeterminate origin-left"></div>
        </div>
      )}

      <div className="p-6 flex-1 flex flex-col">
        <div className="flex justify-between items-start mb-4">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1"><GitPullRequest size={10} /> Pull Request</span>
            <span className={`text-3xl font-mono font-bold tracking-tighter ${isDeleted ? 'text-gray-500' : 'text-gray-900'}`}>#{pre.prNumber}</span>
          </div>
          <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-[11px] font-bold uppercase tracking-wide transition-all ${statusStyle.badge}`}>{statusStyle.icon}<span>{statusStyle.label}</span></div>
        </div>
        
        <div className="space-y-3 flex-1">
            <div className={`flex items-center gap-2 text-xs text-gray-500 font-medium bg-gray-50 w-fit px-2 py-1 rounded-md border border-gray-100 transition-opacity duration-300 ${showTime ? 'opacity-100' : 'opacity-0 select-none'}`}>
                <Clock size={12} />
                {timeDisplay}
            </div>
            
            <div className="mt-2 flex items-center w-full">
            {pre.status === "live" && pre.url ? (
              <a href={pre.url} target="_blank" rel="noopener noreferrer" className="group/link flex items-center justify-between w-full bg-gray-50 hover:bg-white border border-gray-200 hover:border-blue-300 p-2 rounded-lg transition-all duration-200">
                <div className="flex items-center gap-2 overflow-hidden"><div className="bg-white p-1 rounded-md border border-gray-200 text-gray-500 shrink-0"><Globe size={12} /></div><span className="text-xs font-mono text-gray-600 group-hover/link:text-blue-600 truncate">{pre.url.replace(/^https?:\/\//, '')}</span></div><ArrowRight size={12} className="text-gray-300 group-hover/link:text-blue-500 -translate-x-2 opacity-0 group-hover/link:opacity-100 group-hover/link:translate-x-0 transition-all" />
              </a>
            ) : (
                <div className="w-full h-10 flex items-center px-1 text-xs text-gray-400 font-mono">{isBuilding ? <span className="flex items-center gap-2 text-amber-600">Building environment...</span> : isDeleted ? <span className="text-gray-500 flex items-center gap-2"><Ban size={12}/> Deployment inactive</span> : 'Waiting for deployment...'}</div>
            )}
          </div>

          {/* Inject Resource Monitor Here */}
          {pre.status === "live" && (
            <ResourceMonitor stats={stats} />
          )}

        </div>
      </div>
      
      <div className="px-6 py-4 border-t border-gray-200/50 bg-gray-50/50 flex items-center justify-between backdrop-blur-[2px] mt-auto">
          <button onClick={() => onViewLogs(pre.id)} className="text-xs font-semibold text-gray-700 bg-white border border-gray-200 hover:border-gray-300 hover:shadow-sm px-4 py-2 rounded-full flex items-center gap-2 transition-all active:scale-95 group/btn"><Terminal size={13} className="text-gray-400 group-hover/btn:text-black transition-colors" /> View Logs</button>
          <div className="flex items-center gap-1">
            <button onClick={() => onRebuild(pre)} disabled={isProcessing} className={`p-2 rounded-full transition-all active:scale-90 ${isBuilding ? 'text-gray-300 cursor-not-allowed' : 'text-gray-400 hover:text-blue-600 hover:bg-blue-50'}`} title="Redeploy"><RefreshCw size={16} className={isProcessing ? "animate-spin" : ""} /></button>
            <button onClick={() => onDeleteConfirm(pre)} disabled={isProcessing || isDeleted} className={`p-2 rounded-full transition-all active:scale-90 ${isDeleted ? 'text-gray-200 cursor-not-allowed' : 'text-gray-400 hover:text-red-600 hover:bg-red-50'}`} title="Delete"><Trash2 size={16} /></button>
          </div>
      </div>
    </div>
  );
});

export default function Dashboard() {
  const [projects, setProjects] = useState([]);
  const [processingPreview, setProcessingPreview] = useState(null);
  const [activeLogId, setActiveLogId] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [currentTier, setCurrentTier] = useState("FREE");
  const [toast, setToast] = useState(null);
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false);
  
  // NEW: State to store live container resources
  const [stats, setStats] = useState({});

  const token = localStorage.getItem("token");
  const navigate = useNavigate();

  const refreshData = async () => {
    if (!token) return;
    try {
      const [projRes, userRes] = await Promise.all([
        axios.get("http://localhost:4000/api/projects", { headers: { Authorization: `Bearer ${token}` } }),
        axios.get("http://localhost:4000/api/user/me", { headers: { Authorization: `Bearer ${token}` } })
      ]);
      setProjects(projRes.data);
      if (userRes.data.tier) setCurrentTier(userRes.data.tier.toUpperCase());
    } catch (err) {
      console.error("Failed to refresh data", err);
    }
  };
  
  useEffect(() => {
    if (!token) return;
    
    setCurrentTier(getUserTier(token));
    refreshData();

    const controller = new AbortController();

    const handleStatusUpdate = (update) => {
      setProjects((old) => old.map((project) => {
          if (project.id !== update.projectId) return project;
          return { ...project, previews: project.previews.map((pre) => pre.prNumber === update.prNumber ? { ...pre, ...update } : pre) };
        })
      );
    };

    // NEW: Handle the 4-second stat ticks
    const handleStatsUpdate = (payload) => {
      setStats((prev) => ({
        ...prev,
        [payload.previewId]: {
          cpu: payload.cpu,
          memory: payload.memory,
        },
      }));
    };

    socket.on("preview-status-update", handleStatusUpdate);
    socket.on("preview-stats-update", handleStatsUpdate);
    
    return () => {
      socket.off("preview-status-update", handleStatusUpdate);
      socket.off("preview-stats-update", handleStatsUpdate);
      controller.abort();
    };
  }, [token]);

  const activeBuildsCount = projects.reduce((acc, proj) => 
    acc + proj.previews.filter(p => p.status === 'building').length, 0
  );
  
  const tierConfig = TIER_CONFIG[currentTier] || TIER_CONFIG.FREE;

  // Wrapped in useCallback so React.memo doesn't fail on the cards
  const handleRebuild = useCallback(async (pre) => {
    if (activeBuildsCount >= tierConfig.concurrentBuilds) {
      setToast({ 
        type: 'warning', 
        message: `Build Queue Full. ${tierConfig.label} tier limit: ${tierConfig.concurrentBuilds}.` 
      });
      return;
    }

    setProcessingPreview(pre.id);
    try { await axios.post(`http://localhost:4000/api/preview/${pre.id}/rebuild`, {}, { headers: { Authorization: `Bearer ${token}` } }); } catch(e) { console.error(e); }
    setProcessingPreview(null);
  }, [activeBuildsCount, tierConfig, token]);

  // Wrapped in useCallback
  const handleDeleteConfirm = useCallback((pre) => {
    setDeleteConfirm(pre);
  }, []);

  // Wrapped in useCallback
  const handleViewLogs = useCallback((id) => {
    setActiveLogId(id);
  }, []);

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    const pre = deleteConfirm;
    setProcessingPreview(pre.id);
    setDeleteConfirm(null);
    try { await axios.post(`http://localhost:4000/api/preview/${pre.id}/delete`, {}, { headers: { Authorization: `Bearer ${token}` } }); } catch(e) { console.error(e); }
    setProcessingPreview(null);
  };

  return (
    <div className="min-h-screen bg-[#fafafa] text-gray-900 font-sans p-8 md:p-12 relative overflow-x-hidden">
      <div className="absolute inset-0 z-0 opacity-[0.4] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <PlanChangeModal 
        isOpen={isPlanModalOpen} 
        onClose={() => setIsPlanModalOpen(false)}
        currentTier={currentTier}
        onPlanChanged={refreshData}
        showToast={(msg, type) => setToast({ message: msg, type })}
      />

      <div className="max-w-7xl mx-auto relative z-10">
        
        {/* Header */}
        <div className="flex items-center justify-between mb-12">
           <div className="flex items-center gap-4">
              <div className="p-2.5 bg-white border border-gray-200 rounded-xl shadow-sm"><Layout className="w-6 h-6 text-black" /></div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-gray-900">Dashboard</h1>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-gray-500 font-medium">Current Plan:</span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide uppercase border ${tierConfig.color} flex items-center gap-1`}>
                    {currentTier === 'PRO' || currentTier === 'ENTERPRISE' ? <Crown size={10} /> : <Lock size={10} />}
                    {tierConfig.label}
                  </span>
                  
                  <button 
                    onClick={() => setIsPlanModalOpen(true)}
                    className="ml-2 px-2 py-0.5 text-[10px] font-medium bg-white border border-gray-200 rounded hover:bg-gray-50 hover:text-black text-gray-500 transition-colors flex items-center gap-1"
                  >
                    <Settings size={10} /> Change Plan
                  </button>
                </div>
              </div>
           </div>

           <button onClick={() => navigate('/connect')} className="group bg-black hover:bg-gray-800 text-white px-5 py-2.5 rounded-full text-sm font-semibold flex items-center gap-2 transition-all shadow-sm hover:shadow-md active:scale-95">
              <PlusCircle size={16} className="text-gray-400 group-hover:text-white transition-colors" /> Import Repository
           </button>
        </div>

        {/* Project List */}
        <div className="space-y-16">
          {projects.map((project) => (
            <div key={project.id} className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex items-center gap-3 mb-6 ml-1">
                <GitPullRequest className="w-5 h-5 text-gray-400" />
                <h2 className="text-xl font-bold tracking-tight text-gray-900">{project.repoName}<span className="text-gray-400 font-normal ml-2 text-base">/{project.repoOwner}</span></h2>
              </div>

              {project.previews.length === 0 ? (
                 <div className="p-12 border border-dashed border-gray-300 rounded-2xl bg-white/60 backdrop-blur-sm text-center"><p className="text-gray-500 text-sm">Waiting for Pull Requests...</p></div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {project.previews.map((pre) => (
                    // We render our extracted Memo component here to save performance
                    <PreviewCard
                      key={pre.id}
                      pre={pre}
                      stats={stats[pre.id]}
                      isProcessing={processingPreview === pre.id}
                      onRebuild={handleRebuild}
                      onDeleteConfirm={handleDeleteConfirm}
                      onViewLogs={handleViewLogs}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className={`fixed inset-0 bg-black/20 backdrop-blur-[2px] z-40 transition-opacity duration-300 ${activeLogId ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`} onClick={() => setActiveLogId(null)} />
      <div className={`fixed top-0 right-0 h-full w-full md:w-[650px] lg:w-[900px] bg-[#09090b] shadow-2xl z-50 transform transition-transform duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] ${activeLogId ? "translate-x-0" : "translate-x-full"}`}>
        {activeLogId && <Logs previewId={activeLogId} onClose={() => setActiveLogId(null)} />}
      </div>
      
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="absolute inset-0 bg-white/80 backdrop-blur-sm" onClick={() => setDeleteConfirm(null)} />
          <div className="relative bg-white border border-gray-100 rounded-2xl shadow-2xl ring-1 ring-black/5 max-w-sm w-full p-6 zoom-in-95">
            <div className="w-10 h-10 bg-red-50 rounded-full flex items-center justify-center mb-4"><Trash2 className="w-5 h-5 text-red-600" /></div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Delete Deployment?</h3>
            <p className="text-gray-500 text-sm leading-relaxed mb-6">This will permanently remove <span className="font-mono font-bold text-gray-900 bg-gray-100 px-1.5 py-0.5 rounded">PR-{deleteConfirm.prNumber}</span>.</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setDeleteConfirm(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg">Cancel</button>
              <button onClick={confirmDelete} className="px-4 py-2 text-sm text-white bg-red-600 hover:bg-red-700 rounded-lg shadow-sm transition-all active:scale-95">Confirm</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes progress-indeterminate {
          0% { transform: translateX(-100%) scaleX(0.2); }
          50% { transform: translateX(0%) scaleX(0.5); }
          100% { transform: translateX(100%) scaleX(0.2); }
        }
        .animate-progress-indeterminate {
          animation: progress-indeterminate 1.5s infinite linear;
        }
      `}</style>
    </div>
  );
}