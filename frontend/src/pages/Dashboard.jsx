import React, { useEffect, useState, useCallback } from "react";
import api, { API_BASE_URL } from "../api.js";
import io from "socket.io-client";
import { useNavigate } from "react-router-dom";
import Logs from "./Logs.jsx"; 
import PlanChangeModal from "../components/PlanChangeModal.jsx"; 

import {
  GitPullRequest, RefreshCw, Trash2, CheckCircle2, XCircle, Clock, Terminal, Loader2,
  AlertCircle, Globe, Ban, Archive, Layout, PlusCircle, Lock, Crown, AlertTriangle, X, Settings,
  Activity, MemoryStick, ExternalLink
} from "lucide-react";

// --- TIER CONFIGURATION ---
const TIER_CONFIG = {
  FREE: { label: 'Free', color: 'bg-neutral-100 text-neutral-600 border-neutral-200', concurrentBuilds: 1 },
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

const socket = io(API_BASE_URL, { transports: ["websocket"] });

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
    case "live": 
    case "ready": return { badge: "bg-emerald-50 text-emerald-700 border-emerald-200", icon: <CheckCircle2 className="w-3 h-3" />, label: "Ready", border: "hover:border-emerald-300", ring: "" }; 
    case "building": return { badge: "bg-amber-50 text-amber-700 border-amber-200", icon: <Loader2 className="w-3 h-3 animate-spin text-amber-600" />, label: "Building", border: "border-amber-300", ring: "ring-4 ring-amber-500/10" }; 
    case "error": return { badge: "bg-red-50 text-red-700 border-red-200", icon: <XCircle className="w-3 h-3" />, label: "Error", border: "hover:border-red-300", ring: "" }; 
    case "deleted": return { badge: "bg-neutral-100 text-neutral-500 border-neutral-200", icon: <Archive className="w-3 h-3" />, label: "Archived", border: "border-neutral-200 border-dashed bg-neutral-50/50", ring: "" }; 
    default: return { badge: "bg-neutral-100 text-neutral-600 border-neutral-200", icon: <Clock className="w-3 h-3" />, label: "Queued", border: "hover:border-neutral-300", ring: "" }; 
  } 
}

export function formatBytesToMB(bytes) {
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
    success: <CheckCircle2 size={18} />,
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

// Polished Vercel-style Resource Monitor for Dashboard Cards
const ResourceMonitor = ({ stats, onClick }) => {
  if (!stats) {
    return (
      <div className="mt-4 pt-4 border-t border-neutral-100 flex flex-col gap-3 opacity-60">
        <div className="flex justify-between items-center">
          <div className="h-3 w-8 bg-neutral-200 rounded animate-pulse"></div>
          <div className="h-3 w-12 bg-neutral-100 rounded animate-pulse"></div>
        </div>
        <div className="flex justify-between items-center">
          <div className="h-3 w-8 bg-neutral-200 rounded animate-pulse"></div>
          <div className="h-3 w-16 bg-neutral-100 rounded animate-pulse"></div>
        </div>
      </div>
    );
  }

  const { cpu, memory } = stats;
  const memoryMB = formatBytesToMB(memory);
  
  const isCpuHigh = cpu > 70;
  const isMemoryHigh = memoryMB > 400;

  return (
    <div 
      onClick={onClick}
      className="mt-4 pt-4 border-t border-neutral-100 space-y-3.5 cursor-pointer hover:bg-neutral-50/80 p-3 -mx-3 rounded-xl transition-all group/monitor"
      title="View Telemetry"
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between items-baseline text-xs font-mono tracking-tight">
          <span className="text-neutral-500 flex items-center gap-1.5 uppercase tracking-wider text-[10px]">
            <Activity className="w-3 h-3 text-neutral-400 group-hover/monitor:text-black transition-colors" /> CPU
          </span>
          <span className={isCpuHigh ? "text-red-500 font-bold" : "text-neutral-900 font-semibold"}>
            {cpu.toFixed(1)}%
          </span>
        </div>
        <div className="h-1 w-full bg-neutral-100 rounded-full overflow-hidden">
          <div 
            className={`h-full transition-all duration-500 ease-out ${isCpuHigh ? "bg-red-500" : "bg-neutral-900"}`}
            style={{ width: `${Math.min(cpu, 100)}%` }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between items-baseline text-xs font-mono tracking-tight">
          <span className="text-neutral-500 flex items-center gap-1.5 uppercase tracking-wider text-[10px]">
            <MemoryStick className="w-3 h-3 text-neutral-400 group-hover/monitor:text-[#0070F3] transition-colors" /> RAM
          </span>
          <span className={isMemoryHigh ? "text-amber-500 font-bold" : "text-neutral-900 font-semibold"}>
            {memoryMB} MB
          </span>
        </div>
        <div className="h-1 w-full bg-neutral-100 rounded-full overflow-hidden">
          <div 
            className={`h-full transition-all duration-500 ease-out ${isMemoryHigh ? "bg-amber-500" : "bg-[#0070F3]"}`}
            style={{ width: `${Math.min((memoryMB / 512) * 100, 100)}%` }} 
          />
        </div>
      </div>
    </div>
  );
};

// Refined Preview Card (Vercel Aesthetic)
const PreviewCard = React.memo(({ pre, stats, isProcessing, onRebuild, onDeleteConfirm, onViewLogs, onOpenStats }) => {
  const statusStyle = getStatusVisuals(pre.status);
  const isDeleted = pre.status === "deleted";
  const isBuilding = pre.status === "building";

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
    <div className={`group relative bg-white border rounded-xl shadow-sm transition-all duration-300 ease-out flex flex-col h-full overflow-hidden ${statusStyle.border} ${statusStyle.ring} ${!isDeleted && !isBuilding ? 'hover:shadow-md hover:border-neutral-300' : ''}`}>
      
      {/* Top Header */}
      <div className="p-5 pb-0">
        <div className="flex justify-between items-start mb-4">
          <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] font-semibold text-neutral-400 uppercase tracking-widest flex items-center gap-1.5">
              <GitPullRequest className="w-3.5 h-3.5" /> Pull Request
            </span>
            <span className={`text-2xl font-semibold tracking-tight ${isDeleted ? 'text-neutral-400' : 'text-neutral-900'}`}>
              #{pre.prNumber}
            </span>
          </div>
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-bold uppercase tracking-wider transition-all ${statusStyle.badge}`}>
            {statusStyle.icon}<span>{statusStyle.label}</span>
          </div>
        </div>

        {/* Time & URL Section */}
        <div className="space-y-3">
            <div className={`flex items-center gap-2 text-xs text-neutral-500 font-medium transition-opacity duration-300 ${isDeleted ? 'opacity-0' : 'opacity-100'}`}>
                <Clock className="w-3.5 h-3.5 text-neutral-400" />
                {timeDisplay}
            </div>
            
            {pre.status === "live" || pre.status === "ready" ? (
              <a href={pre.url} target="_blank" rel="noopener noreferrer" className="group/url flex items-center justify-between w-full bg-neutral-50 hover:bg-neutral-100 border border-neutral-200 px-3 py-2.5 rounded-lg transition-all duration-200">
                <div className="flex items-center gap-2 overflow-hidden">
                  <Globe className="w-4 h-4 text-neutral-400" />
                  <span className="text-xs font-mono text-neutral-700 truncate group-hover/url:text-blue-600 transition-colors">
                    {pre.url?.replace(/^https?:\/\//, '')}
                  </span>
                </div>
                <ExternalLink className="w-3.5 h-3.5 text-neutral-400 opacity-0 group-hover/url:opacity-100 transition-opacity group-hover/url:text-blue-500" />
              </a>
            ) : (
                <div className="w-full h-[42px] flex items-center px-3 bg-neutral-50/50 border border-neutral-100 border-dashed rounded-lg text-xs text-neutral-400 font-mono">
                  {isBuilding ? <span className="flex items-center gap-2 text-amber-600">Building environment...</span> : isDeleted ? <span className="text-neutral-400 flex items-center gap-2"><Ban className="w-3.5 h-3.5"/> Deployment inactive</span> : 'Waiting for deployment...'}
                </div>
            )}
        </div>

        {/* Live Resource Monitor */}
        {(pre.status === "live" || pre.status === "ready") && (
          <ResourceMonitor stats={stats} onClick={() => onOpenStats(pre)} />
        )}
      </div>
      
      {/* Separated Action Footer */}
      <div className="mt-auto p-4 border-t border-neutral-100 bg-neutral-50/50 flex items-center justify-between">
          <button onClick={() => onViewLogs(pre.id)} className="text-xs font-semibold text-neutral-700 bg-white border border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50 px-4 py-2 rounded-lg flex items-center gap-2 transition-all active:scale-95 shadow-sm group/btn">
            <Terminal className="w-3.5 h-3.5 text-neutral-500 group-hover/btn:text-neutral-900 transition-colors" /> View Logs
          </button>
          
          <div className="flex items-center gap-1.5">
            <button onClick={() => onRebuild(pre)} disabled={isProcessing} className={`p-2 border border-transparent rounded-lg transition-all active:scale-90 ${isBuilding ? 'text-neutral-300 cursor-not-allowed' : 'text-neutral-500 hover:text-blue-600 hover:bg-blue-50 hover:border-blue-100'}`} title="Redeploy">
              <RefreshCw className={`w-4 h-4 ${isProcessing ? "animate-spin" : ""}`} />
            </button>
            <button onClick={() => onDeleteConfirm(pre)} disabled={isProcessing || isDeleted} className={`p-2 border border-transparent rounded-lg transition-all active:scale-90 ${isDeleted ? 'text-neutral-200 cursor-not-allowed' : 'text-neutral-500 hover:text-red-600 hover:bg-red-50 hover:border-red-100'}`} title="Delete">
              <Trash2 className="w-4 h-4" />
            </button>
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
  const [stats, setStats] = useState({});

  const token = localStorage.getItem("token");
  const navigate = useNavigate();

  const refreshData = async () => {
    if (!token) return;
    try {
      const [projRes, userRes] = await Promise.all([
        api.get("/api/projects"),
        api.get("/api/user/me")
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

    const handleStatsUpdate = (payload) => {
      setStats((prev) => ({
        ...prev,
        [payload.previewId]: {
          cpu: payload.cpu,
          memory: payload.memory,
          memoryLimit: payload.memoryLimit,
          memoryPercent: payload.memoryPercent,
          networkRx: payload.networkRx,
          networkTx: payload.networkTx,
          uptime: payload.uptime
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

  const handleRebuild = useCallback(async (pre) => {
    if (activeBuildsCount >= tierConfig.concurrentBuilds) {
      setToast({ type: 'warning', message: `Build Queue Full. ${tierConfig.label} tier limit: ${tierConfig.concurrentBuilds}.` });
      return;
    }
    setProcessingPreview(pre.id);
    try { await api.post(`/api/preview/${pre.id}/rebuild`, {}); } catch(e) { console.error(e); }
    setProcessingPreview(null);
  }, [activeBuildsCount, tierConfig, token]);

  const handleDeleteConfirm = useCallback((pre) => setDeleteConfirm(pre), []);
  const handleViewLogs = useCallback((id) => setActiveLogId(id), []);
  const handleOpenStats = useCallback((pre) => navigate(`/metrics/${pre.id}`, { state: { preview: pre } }), [navigate]);

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    const pre = deleteConfirm;
    setProcessingPreview(pre.id);
    setDeleteConfirm(null);
    try { await api.post(`/api/preview/${pre.id}/delete`, {}); } catch(e) { console.error(e); }
    setProcessingPreview(null);
  };

  return (
    <div className="min-h-screen bg-white text-neutral-900 font-sans p-8 md:p-12 relative overflow-x-hidden">
      {/* Subtle Dot Grid Background */}
      <div className="absolute inset-0 z-0 opacity-[0.25] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#d4d4d8 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <PlanChangeModal isOpen={isPlanModalOpen} onClose={() => setIsPlanModalOpen(false)} currentTier={currentTier} onPlanChanged={refreshData} showToast={(msg, type) => setToast({ message: msg, type })} />

      <div className="max-w-7xl mx-auto relative z-10">
        
        {/* Main Header */}
        <div className="flex items-center justify-between mb-16 border-b border-neutral-200 pb-6">
           <div className="flex items-center gap-4">
              <div className="p-2.5 bg-white border border-neutral-200 rounded-xl shadow-sm"><Layout className="w-6 h-6 text-neutral-900" /></div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Dashboard</h1>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-xs text-neutral-500 font-medium tracking-wide">Current Plan:</span>
                  <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wider uppercase border ${tierConfig.color} flex items-center gap-1`}>
                    {currentTier === 'PRO' || currentTier === 'ENTERPRISE' ? <Crown size={10} /> : <Lock size={10} />}
                    {tierConfig.label}
                  </span>
                  <button onClick={() => setIsPlanModalOpen(true)} className="ml-2 px-2 py-0.5 text-[10px] font-medium bg-white border border-neutral-200 rounded-md hover:bg-neutral-50 hover:text-black text-neutral-500 transition-colors flex items-center gap-1">
                    <Settings size={10} /> Change Plan
                  </button>
                </div>
              </div>
           </div>
           <button onClick={() => navigate('/connect')} className="group bg-neutral-900 hover:bg-black text-white px-5 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 transition-all shadow-sm hover:shadow active:scale-95">
              <PlusCircle size={16} className="text-neutral-400 group-hover:text-white transition-colors" /> Import Repository
           </button>
        </div>

        {/* Project List */}
        <div className="space-y-16">
          {projects.map((project) => (
            <div key={project.id} className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex items-center gap-3 mb-6 ml-1">
                <GitPullRequest className="w-5 h-5 text-neutral-400" />
                <h2 className="text-xl font-semibold tracking-tight text-neutral-900">
                  {project.repoName}
                  <span className="text-neutral-400 font-normal ml-1 text-base">/{project.repoOwner}</span>
                </h2>
              </div>

              {project.previews.length === 0 ? (
                 <div className="p-12 border border-dashed border-neutral-300 rounded-2xl bg-white text-center"><p className="text-neutral-500 text-sm">Waiting for Pull Requests...</p></div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {project.previews.map((pre) => (
                    <PreviewCard key={pre.id} pre={pre} stats={stats[pre.id]} isProcessing={processingPreview === pre.id} onRebuild={handleRebuild} onDeleteConfirm={handleDeleteConfirm} onViewLogs={handleViewLogs} onOpenStats={handleOpenStats} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Logs Overlay */}
      <div className={`fixed inset-0 bg-neutral-900/20 backdrop-blur-[2px] z-40 transition-opacity duration-300 ${activeLogId ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`} onClick={() => setActiveLogId(null)} />
      <div className={`fixed top-0 right-0 h-full w-full md:w-[650px] lg:w-[900px] bg-[#09090b] shadow-2xl z-50 transform transition-transform duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] ${activeLogId ? "translate-x-0" : "translate-x-full"}`}>
        {activeLogId && <Logs previewId={activeLogId} onClose={() => setActiveLogId(null)} />}
      </div>
      
      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="absolute inset-0 bg-white/80 backdrop-blur-sm" onClick={() => setDeleteConfirm(null)} />
          <div className="relative bg-white border border-neutral-200 rounded-2xl shadow-xl max-w-sm w-full p-6 zoom-in-95">
            <div className="w-10 h-10 bg-red-50 rounded-full flex items-center justify-center mb-4"><Trash2 className="w-5 h-5 text-red-600" /></div>
            <h3 className="text-lg font-semibold tracking-tight text-neutral-900 mb-2">Delete Deployment?</h3>
            <p className="text-neutral-500 text-sm leading-relaxed mb-6">This will permanently remove <span className="font-mono font-bold text-neutral-900 bg-neutral-100 px-1.5 py-0.5 rounded border border-neutral-200">PR-{deleteConfirm.prNumber}</span>.</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setDeleteConfirm(null)} className="px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50 rounded-lg transition-colors border border-transparent">Cancel</button>
              <button onClick={confirmDelete} className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg shadow-sm transition-all active:scale-95">Confirm</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes progress-indeterminate { 0% { transform: translateX(-100%) scaleX(0.2); } 50% { transform: translateX(0%) scaleX(0.5); } 100% { transform: translateX(100%) scaleX(0.2); } }
        .animate-progress-indeterminate { animation: progress-indeterminate 1.5s infinite linear; }
      `}</style>
    </div>
  );
}