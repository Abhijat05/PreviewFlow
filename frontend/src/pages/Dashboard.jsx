import React, { useEffect, useState, useCallback, useMemo } from "react";
import api from "../api.js";
import { useSocket } from "../context/SocketContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { useNavigate } from "react-router-dom";
import Logs from "./Logs.jsx";
import PlanChangeModal from "../components/PlanChangeModal.jsx";
import Toast from "../components/Toast.jsx";
import DashboardStatsStrip from "../components/dashboard/DashboardStatsStrip.jsx";
import ProjectCard from "../components/dashboard/ProjectCard.jsx";
import ActivityTimeline from "../components/dashboard/ActivityTimeline.jsx";
import QuickCreateProjectDrawer from "../components/dashboard/QuickCreateProjectDrawer.jsx";

import {
  AlertCircle,
  Crown,
  FolderGit2,
  GitPullRequest,
  Globe,
  Layout,
  Lock,
  PlusCircle,
  RefreshCw,
  Search,
  Settings,
  Terminal,
  Trash2
} from "lucide-react";

const TIER_CONFIG = {
  FREE: { label: "Free", color: "bg-neutral-100 text-neutral-600 border-neutral-200", concurrentBuilds: 1 },
  HOBBY: { label: "Hobby", color: "bg-blue-50 text-blue-600 border-blue-200", concurrentBuilds: 1 },
  PRO: { label: "Pro", color: "bg-indigo-50 text-indigo-600 border-indigo-200", concurrentBuilds: Infinity },
  ENTERPRISE: { label: "Enterprise", color: "bg-slate-900 text-amber-400 border-slate-700", concurrentBuilds: Infinity }
};

function deriveFallbackStats(projects = []) {
  let livePreviews = 0;
  let buildingPreviews = 0;
  let errorPreviews = 0;
  let archivedPreviews = 0;
  let totalPreviews = 0;
  let webhookProjects = 0;

  for (const proj of projects) {
    if (proj.hasWebhook) webhookProjects++;
    for (const pre of proj.previews || []) {
      const s = String(pre.status || "").toLowerCase();
      if (s === "deleted") {
        archivedPreviews++;
      } else {
        totalPreviews++;
        if (s === "live" || s === "ready") livePreviews++;
        else if (s === "building") buildingPreviews++;
        else if (s === "error") errorPreviews++;
      }
    }
  }

  return {
    totalProjects: projects.length,
    totalPreviews,
    livePreviews,
    buildingPreviews,
    errorPreviews,
    archivedPreviews,
    webhookProjects,
    totalBuilds: 0,
    completedBuilds: 0,
    failedBuilds: 0,
    successRate: null,
    avgBuildDurationSec: null
  };
}

function ProjectCardSkeleton() {
  return (
    <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-neutral-100 bg-neutral-50/50 flex justify-between items-center">
        <div className="space-y-2">
          <div className="h-4 w-44 bg-neutral-200 rounded animate-pulse" />
          <div className="h-3 w-32 bg-neutral-100 rounded animate-pulse" />
        </div>
        <div className="h-8 w-28 bg-neutral-200 rounded animate-pulse" />
      </div>
      <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        {[1, 2].map((i) => (
          <div key={i} className="border border-neutral-200 rounded-lg p-4 space-y-3">
            <div className="flex justify-between">
              <div className="h-5 w-16 bg-neutral-200 rounded animate-pulse" />
              <div className="h-5 w-16 bg-neutral-100 rounded-full animate-pulse" />
            </div>
            <div className="h-8 w-full bg-neutral-100 rounded animate-pulse" />
            <div className="h-7 w-24 bg-neutral-100 rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [projects, setProjects] = useState([]);
  const [serverStats, setServerStats] = useState(null);
  const [recentBuilds, setRecentBuilds] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [processingPreview, setProcessingPreview] = useState(null);
  const [activeLogId, setActiveLogId] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [toast, setToast] = useState(null);
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [stats, setStats] = useState({});

  const token = localStorage.getItem("token");
  const navigate = useNavigate();
  const { socket, joinPreview } = useSocket();
  const { tier: currentTier, refreshUser } = useAuth();

  const applyDashboardPayload = useCallback((payload) => {
    if (Array.isArray(payload)) {
      setProjects(payload);
      setServerStats(null);
      setRecentBuilds([]);
      setActivity([]);
      return;
    }

    if (payload && Array.isArray(payload.projects)) {
      setProjects(payload.projects);
      setServerStats(payload.stats || null);
      setRecentBuilds(Array.isArray(payload.recentBuilds) ? payload.recentBuilds : []);
      setActivity(Array.isArray(payload.activity) ? payload.activity : []);
    }
  }, []);

  const refreshData = useCallback(
    async ({ silent = false } = {}) => {
      if (!token) {
        setLoading(false);
        return;
      }

      if (silent) setRefreshing(true);
      else setLoading(true);
      setLoadError(null);

      try {
        let overviewRes;
        try {
          overviewRes = await api.get("/api/dashboard/overview");
        } catch (err) {
          if (err?.response?.status === 404) {
            overviewRes = await api.get("/api/projects");
          } else {
            throw err;
          }
        }

        await refreshUser().catch(() => {});
        applyDashboardPayload(overviewRes?.data);
      } catch (err) {
        const message =
          err?.response?.data?.message ||
          err?.response?.data?.error ||
          err?.message ||
          "Unable to load dashboard data.";
        setLoadError(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [token, refreshUser, applyDashboardPayload]
  );

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }

    refreshData();

    const handleStatusUpdate = (update) => {
      setProjects((old) =>
        old.map((project) => {
          if (project.id !== update.projectId) return project;
          const exists = (project.previews || []).some((pre) => pre.prNumber === update.prNumber);
          const nextPreviews = exists
            ? project.previews.map((pre) => (pre.prNumber === update.prNumber ? { ...pre, ...update } : pre))
            : [{ id: update.previewId, ...update }, ...(project.previews || [])];
          return { ...project, previews: nextPreviews };
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
        }
      }));
    };

    if (socket) {
      socket.on("preview-status-update", handleStatusUpdate);
      socket.on("preview-stats-update", handleStatsUpdate);
    }

    return () => {
      if (socket) {
        socket.off("preview-status-update", handleStatusUpdate);
        socket.off("preview-stats-update", handleStatsUpdate);
      }
    };
  }, [token, socket, refreshData]);

  // Subscribe to active preview rooms for telemetry & build status updates
  useEffect(() => {
    if (!projects.length) return;
    projects.forEach((proj) => {
      proj.previews?.forEach((pre) => {
        if (pre.status === "live" || pre.status === "building") {
          joinPreview(pre.id);
        }
      });
    });
  }, [projects, joinPreview]);

  const activeBuildsCount = useMemo(
    () =>
      projects.reduce(
        (acc, proj) => acc + (proj.previews || []).filter((p) => p.status === "building").length,
        0
      ),
    [projects]
  );

  const computedStats = useMemo(() => {
    const derived = deriveFallbackStats(projects);
    if (!serverStats) return derived;
    return {
      ...derived,
      ...serverStats,
      webhookProjects: derived.webhookProjects
    };
  }, [projects, serverStats]);

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return projects
      .map((proj) => {
        const repoMatches =
          !query ||
          proj.repoName.toLowerCase().includes(query) ||
          proj.repoOwner.toLowerCase().includes(query) ||
          (proj.framework && proj.framework.toLowerCase().includes(query));

        const previews = (proj.previews || []).filter((pre) => {
          if (statusFilter === "live" && pre.status !== "live" && pre.status !== "ready") return false;
          if (statusFilter === "building" && pre.status !== "building") return false;
          if (statusFilter === "error" && pre.status !== "error") return false;
          if (query && !repoMatches) {
            return `#${pre.prNumber}`.includes(query) || String(pre.prNumber).includes(query);
          }
          return true;
        });

        if (statusFilter !== "all" && previews.length === 0) return null;
        if (query && !repoMatches && previews.length === 0) return null;

        return {
          ...proj,
          previews: statusFilter === "all" && repoMatches ? proj.previews || [] : previews
        };
      })
      .filter(Boolean);
  }, [projects, searchQuery, statusFilter]);

  const tierConfig = TIER_CONFIG[currentTier] || TIER_CONFIG.FREE;

  const handleRebuild = useCallback(
    async (pre) => {
      if (activeBuildsCount >= tierConfig.concurrentBuilds) {
        setToast({
          type: "warning",
          message: `Build queue full (${tierConfig.label} limit: ${tierConfig.concurrentBuilds}).`
        });
        return;
      }

      setProcessingPreview(pre.id);
      try {
        await api.post(`/api/preview/${pre.id}/rebuild`, {});
        setProjects((old) =>
          old.map((proj) => ({
            ...proj,
            previews: (proj.previews || []).map((item) =>
              item.id === pre.id ? { ...item, status: "building", buildStartedAt: new Date().toISOString() } : item
            )
          }))
        );
        setToast({ type: "success", message: `Redeploy triggered for PR #${pre.prNumber}.` });
      } catch (err) {
        setToast({
          type: "error",
          message:
            err?.response?.data?.message ||
            err?.response?.data?.error ||
            "Failed to trigger redeploy."
        });
      } finally {
        setProcessingPreview(null);
      }
    },
    [activeBuildsCount, tierConfig]
  );

  const handleDeleteConfirm = useCallback((pre) => setDeleteConfirm(pre), []);
  const handleViewLogs = useCallback((id) => setActiveLogId(id), []);
  const handleOpenStats = useCallback(
    (pre) => navigate(`/metrics/${pre.id}`, { state: { preview: pre } }),
    [navigate]
  );

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    const pre = deleteConfirm;
    setProcessingPreview(pre.id);
    setDeleteConfirm(null);
    try {
      await api.post(`/api/preview/${pre.id}/delete`, {});
      setProjects((old) =>
        old.map((proj) => ({
          ...proj,
          previews: (proj.previews || []).map((item) =>
            item.id === pre.id ? { ...item, status: "deleted", url: null } : item
          )
        }))
      );
      setToast({ type: "success", message: `Preview PR #${pre.prNumber} deleted.` });
    } catch (err) {
      setToast({
        type: "error",
        message:
          err?.response?.data?.message ||
          err?.response?.data?.error ||
          "Failed to delete preview."
      });
    } finally {
      setProcessingPreview(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#fafafa] text-neutral-900 font-sans relative overflow-x-hidden">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <PlanChangeModal
        isOpen={isPlanModalOpen}
        onClose={() => setIsPlanModalOpen(false)}
        currentTier={currentTier}
        onPlanChanged={() => refreshData({ silent: true })}
        showToast={(msg, type) => setToast({ message: msg, type })}
      />

      <QuickCreateProjectDrawer
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        existingProjects={projects}
        userTier={currentTier}
        onProjectCreated={() => refreshData({ silent: true })}
        showToast={(msg, type) => setToast({ message: msg, type })}
      />

      {/* Sticky Top Control Bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-neutral-200">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <button
              type="button"
              onClick={() => navigate("/")}
              className="p-2 bg-neutral-950 text-white rounded-lg shadow-xs hover:bg-neutral-800 transition-colors"
              aria-label="PreviewFlow home"
            >
              <Layout className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-neutral-950">Dashboard</h1>
              <div className="flex flex-wrap items-center gap-2 mt-0.5">
                <span className="text-xs text-neutral-500">Current Plan:</span>
                <span
                  className={`px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wider uppercase border ${tierConfig.color} inline-flex items-center gap-1`}
                >
                  {currentTier === "PRO" || currentTier === "ENTERPRISE" ? <Crown size={10} /> : <Lock size={10} />}
                  {tierConfig.label}
                </span>
                <button
                  type="button"
                  onClick={() => setIsPlanModalOpen(true)}
                  className="px-2 py-0.5 text-[11px] font-medium bg-white border border-neutral-200 rounded-md hover:bg-neutral-50 text-neutral-600 transition-colors inline-flex items-center gap-1"
                >
                  <Settings size={10} /> Change Plan
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => refreshData({ silent: true })}
              disabled={loading || refreshing}
              className="px-3 py-2 text-xs font-medium bg-white border border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50 text-neutral-700 rounded-lg inline-flex items-center gap-1.5 transition-colors disabled:opacity-50"
              title="Refresh overview"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </button>

            <button
              type="button"
              onClick={() => setIsCreateOpen(true)}
              className="bg-neutral-950 hover:bg-black text-white px-4 py-2 rounded-lg text-sm font-medium inline-flex items-center gap-2 transition-colors shadow-xs"
            >
              <PlusCircle size={15} />
              Create Project
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 md:px-10 py-8 space-y-6">
        {/* Deployment Statistics Strip */}
        <DashboardStatsStrip
          stats={computedStats}
          tierConfig={tierConfig}
          activeBuildsCount={activeBuildsCount}
          loading={loading && projects.length === 0}
        />

        {/* Non-blocking Error Banner when cached data exists */}
        {loadError && projects.length > 0 && (
          <div
            role="alert"
            className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3"
          >
            <div className="flex items-center gap-2.5 text-sm text-red-900">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
              <span>Failed to refresh overview: {loadError}</span>
            </div>
            <button
              type="button"
              onClick={() => refreshData({ silent: true })}
              className="px-3 py-1 text-xs font-medium bg-white border border-red-200 text-red-700 hover:bg-red-50 rounded-md"
            >
              Retry
            </button>
          </div>
        )}

        {/* Initial Loading Skeleton State */}
        {loading && projects.length === 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-8 space-y-5">
              <ProjectCardSkeleton />
              <ProjectCardSkeleton />
            </div>
            <div className="lg:col-span-4">
              <ActivityTimeline loading />
            </div>
          </div>
        ) : loadError && projects.length === 0 ? (
          /* Full Error Recovery State */
          <div
            role="alert"
            className="bg-white border border-red-200 rounded-xl p-10 text-center max-w-xl mx-auto shadow-xs space-y-4"
          >
            <div className="w-11 h-11 rounded-full bg-red-50 border border-red-100 flex items-center justify-center mx-auto">
              <AlertCircle className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-neutral-950">Could not load your dashboard</h2>
              <p className="text-sm text-neutral-600 mt-1">{loadError}</p>
            </div>
            <div className="flex justify-center gap-3">
              <button
                type="button"
                onClick={() => refreshData()}
                className="px-4 py-2 text-sm font-medium bg-neutral-950 hover:bg-black text-white rounded-lg inline-flex items-center gap-2"
              >
                <RefreshCw className="w-4 h-4" /> Retry Load
              </button>
            </div>
          </div>
        ) : projects.length === 0 ? (
          /* First-Run Onboarding Empty State */
          <div className="bg-white border border-neutral-200 rounded-xl p-10 text-center shadow-xs space-y-8">
            <div className="max-w-md mx-auto space-y-2">
              <div className="w-11 h-11 rounded-xl bg-neutral-100 border border-neutral-200 flex items-center justify-center mx-auto">
                <FolderGit2 className="w-5 h-5 text-neutral-800" />
              </div>
              <h2 className="text-lg font-semibold text-neutral-950">Connect your first repository</h2>
              <p className="text-sm text-neutral-600">
                Link a GitHub repository to automatically spin up isolated preview environments and live logs on every pull request.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl mx-auto text-left">
              <div className="p-4 border border-neutral-200 rounded-lg bg-neutral-50/50 space-y-1">
                <FolderGit2 className="w-4 h-4 text-neutral-700" />
                <p className="text-xs font-semibold text-neutral-900">1. Create project</p>
                <p className="text-xs text-neutral-500">Pick any repository you maintain on GitHub.</p>
              </div>
              <div className="p-4 border border-neutral-200 rounded-lg bg-neutral-50/50 space-y-1">
                <GitPullRequest className="w-4 h-4 text-neutral-700" />
                <p className="text-xs font-semibold text-neutral-900">2. Open a Pull Request</p>
                <p className="text-xs text-neutral-500">Webhooks detect your framework and build commits.</p>
              </div>
              <div className="p-4 border border-neutral-200 rounded-lg bg-neutral-50/50 space-y-1">
                <Terminal className="w-4 h-4 text-neutral-700" />
                <p className="text-xs font-semibold text-neutral-900">3. Inspect & verify</p>
                <p className="text-xs text-neutral-500">Stream build logs, live CPU/RAM metrics, and URLs.</p>
              </div>
            </div>

            <div className="flex flex-wrap justify-center gap-3">
              <button
                type="button"
                onClick={() => navigate("/connect")}
                className="bg-neutral-950 hover:bg-black text-white px-5 py-2.5 rounded-lg text-sm font-medium inline-flex items-center gap-2 transition-colors"
              >
                <PlusCircle size={16} />
                Import Repository
              </button>
              <button
                type="button"
                onClick={() => setIsCreateOpen(true)}
                className="bg-white border border-neutral-200 hover:border-neutral-300 text-neutral-800 px-4 py-2.5 rounded-lg text-sm font-medium inline-flex items-center gap-2 transition-colors"
              >
                Quick Connect Drawer
              </button>
            </div>
          </div>
        ) : (
          /* Populated Control-Plane Workspace */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-8 space-y-5">
              {/* Search & Status Filter Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter projects, frameworks, or #PR..."
                    aria-label="Filter projects"
                    className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900/10 focus:border-neutral-400"
                  />
                </div>

                <div className="inline-flex bg-white border border-neutral-200 p-0.5 rounded-lg text-xs">
                  {[
                    { key: "all", label: "All" },
                    { key: "live", label: "Live" },
                    { key: "building", label: "In Progress" },
                    { key: "error", label: "Errors" }
                  ].map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setStatusFilter(opt.key)}
                      className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                        statusFilter === opt.key
                          ? "bg-neutral-900 text-white"
                          : "text-neutral-600 hover:text-neutral-900"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {filteredProjects.length === 0 ? (
                <div className="bg-white border border-dashed border-neutral-300 rounded-xl p-10 text-center space-y-3">
                  <Globe className="w-5 h-5 text-neutral-300 mx-auto" />
                  <p className="text-sm font-medium text-neutral-800">No deployments match your filters</p>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery("");
                      setStatusFilter("all");
                    }}
                    className="px-3.5 py-1.5 text-xs font-medium bg-white border border-neutral-200 hover:border-neutral-300 rounded-md text-neutral-700"
                  >
                    Reset filters
                  </button>
                </div>
              ) : (
                filteredProjects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    statsMap={stats}
                    processingPreview={processingPreview}
                    onRebuild={handleRebuild}
                    onDeleteConfirm={handleDeleteConfirm}
                    onViewLogs={handleViewLogs}
                    onOpenStats={handleOpenStats}
                  />
                ))
              )}
            </div>

            <div className="lg:col-span-4 lg:sticky lg:top-24">
              <ActivityTimeline
                recentBuilds={recentBuilds}
                activity={activity}
                loading={loading}
                onViewLogs={handleViewLogs}
                onQuickRebuild={handleRebuild}
              />
            </div>
          </div>
        )}
      </main>

      {/* Logs Overlay Drawer */}
      <div
        className={`fixed inset-0 bg-neutral-900/20 backdrop-blur-[2px] z-40 transition-opacity duration-300 ${
          activeLogId ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setActiveLogId(null)}
      />
      <div
        className={`fixed top-0 right-0 h-full w-full md:w-[650px] lg:w-[900px] bg-[#09090b] shadow-2xl z-50 transform transition-transform duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] ${
          activeLogId ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {activeLogId && <Logs previewId={activeLogId} onClose={() => setActiveLogId(null)} />}
      </div>

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="absolute inset-0 bg-neutral-950/30 backdrop-blur-[1px]" onClick={() => setDeleteConfirm(null)} />
          <div className="relative bg-white border border-neutral-200 rounded-xl shadow-xl max-w-sm w-full p-6">
            <div className="w-10 h-10 bg-red-50 rounded-full flex items-center justify-center mb-4">
              <Trash2 className="w-5 h-5 text-red-600" />
            </div>
            <h3 className="text-base font-semibold tracking-tight text-neutral-950 mb-1.5">
              Delete Deployment?
            </h3>
            <p className="text-neutral-600 text-sm leading-relaxed mb-6">
              This will permanently remove{" "}
              <span className="font-mono font-semibold text-neutral-900 bg-neutral-100 px-1.5 py-0.5 rounded border border-neutral-200">
                PR-{deleteConfirm.prNumber}
              </span>
              .
            </p>
            <div className="flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg shadow-xs transition-colors"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
