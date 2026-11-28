import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../../api.js";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Github,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Search,
  X
} from "lucide-react";

const FRAMEWORK_OPTIONS = [
  { value: "", label: "Auto-detect on first build" },
  { value: "nextjs", label: "Next.js" },
  { value: "vite", label: "Vite / React SPA" },
  { value: "node-backend", label: "Node.js API" },
  { value: "static", label: "Static HTML" },
  { value: "dockerfile", label: "Custom Dockerfile" }
];

export default function QuickCreateProjectDrawer({
  isOpen,
  onClose,
  existingProjects = [],
  userTier = "FREE",
  onProjectCreated,
  showToast
}) {
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFramework, setSelectedFramework] = useState("");
  const [connectingFullName, setConnectingFullName] = useState(null);
  const navigate = useNavigate();

  const loadRepos = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get("/api/repos");
      setRepos(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      setError(
        err.response?.data?.error ||
          err.response?.data?.message ||
          "Could not load GitHub repositories."
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadRepos();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const connectedSet = new Set(
    existingProjects.map((p) => `${p.repoOwner}/${p.repoName}`.toLowerCase())
  );

  const filteredRepos = repos.filter((r) =>
    String(r.fullName || `${r.owner}/${r.name}`)
      .toLowerCase()
      .includes(searchQuery.toLowerCase())
  );

  const handleConnect = async (repo) => {
    const fullName = repo.fullName || `${repo.owner}/${repo.name}`;
    setConnectingFullName(fullName);
    try {
      const res = await api.post("/api/connect-repo", {
        repoOwner: repo.owner,
        repoName: repo.name,
        ...(selectedFramework ? { framework: selectedFramework } : {})
      });

      const createdProject = res.data?.project;
      const allowWebhook = userTier === "PRO" || userTier === "ENTERPRISE";
      if (allowWebhook && createdProject?.id && !res.data?.webhookCreated && res.data?.note !== "already_connected") {
        await api.post("/api/create-webhook", { projectId: createdProject.id }).catch(() => {});
      }

      if (showToast) {
        showToast(`${repo.name} connected cleanly!`, "success");
      }
      if (onProjectCreated) {
        await onProjectCreated();
      }
      onClose();
    } catch (err) {
      if (showToast) {
        showToast(
          err.response?.data?.message ||
            err.response?.data?.error ||
            "Failed to connect project.",
          "error"
        );
      }
    } finally {
      setConnectingFullName(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="fixed inset-0 bg-neutral-900/25 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Create Project"
        className="relative z-10 w-full max-w-lg bg-white h-full border-l border-neutral-200 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200"
      >
        <div className="px-6 py-4 border-b border-neutral-200 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-neutral-950">Create Project</h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Connect a GitHub repository to enable automatic PR previews.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 rounded-lg transition-colors"
            aria-label="Close drawer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-4 border-b border-neutral-100 space-y-3 bg-neutral-50/50">
          <div className="relative">
            <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search repositories..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900/10 focus:border-neutral-400"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <label htmlFor="framework-preset" className="text-xs font-medium text-neutral-600 shrink-0">
              Framework preset
            </label>
            <select
              id="framework-preset"
              value={selectedFramework}
              onChange={(e) => setSelectedFramework(e.target.value)}
              className="text-xs bg-white border border-neutral-200 rounded-md px-2.5 py-1.5 text-neutral-800 focus:outline-none focus:border-neutral-400"
            >
              {FRAMEWORK_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-2.5">
          {loading ? (
            <div className="space-y-2.5">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="p-3.5 border border-neutral-200 rounded-lg flex justify-between items-center">
                  <div className="space-y-2">
                    <div className="h-3.5 w-40 bg-neutral-200 rounded animate-pulse" />
                    <div className="h-3 w-20 bg-neutral-100 rounded animate-pulse" />
                  </div>
                  <div className="h-8 w-20 bg-neutral-100 rounded animate-pulse" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="p-6 border border-red-200 bg-red-50/70 rounded-xl text-center space-y-3">
              <AlertCircle className="w-5 h-5 text-red-600 mx-auto" />
              <p className="text-sm font-medium text-red-900">{error}</p>
              <button
                type="button"
                onClick={loadRepos}
                className="px-3.5 py-1.5 text-xs font-medium bg-white border border-red-200 text-red-700 hover:bg-red-50 rounded-md inline-flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Retry
              </button>
            </div>
          ) : filteredRepos.length === 0 ? (
            <div className="p-8 text-center border border-dashed border-neutral-200 rounded-xl">
              <Github className="w-5 h-5 text-neutral-300 mx-auto mb-2" />
              <p className="text-sm font-medium text-neutral-700">No matching repositories</p>
              <p className="text-xs text-neutral-500 mt-1">
                Try another search term or open the full import view.
              </p>
            </div>
          ) : (
            filteredRepos.map((repo) => {
              const fullName = repo.fullName || `${repo.owner}/${repo.name}`;
              const isConnected = connectedSet.has(fullName.toLowerCase());
              const isBusy = connectingFullName === fullName;

              return (
                <div
                  key={fullName}
                  className="p-3.5 border border-neutral-200 rounded-lg hover:border-neutral-300 transition-colors flex items-center justify-between gap-3 bg-white"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-neutral-900 truncate">{fullName}</span>
                      {repo.isPrivate && <Lock className="w-3 h-3 text-neutral-400 shrink-0" />}
                    </div>
                    {repo.language && (
                      <span className="text-[11px] font-mono text-neutral-500">{repo.language}</span>
                    )}
                  </div>

                  {isConnected ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 shrink-0">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Connected
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleConnect(repo)}
                      disabled={isBusy || connectingFullName !== null}
                      className="px-3 py-1.5 text-xs font-medium bg-neutral-900 hover:bg-black disabled:opacity-50 text-white rounded-md inline-flex items-center gap-1.5 transition-colors shrink-0"
                    >
                      {isBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Plus className="w-3.5 h-3.5" />
                      )}
                      Connect
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="px-6 py-3.5 border-t border-neutral-200 bg-neutral-50 flex items-center justify-between text-xs text-neutral-500">
          <span>Need quota details or troubleshooting?</span>
          <button
            type="button"
            onClick={() => {
              onClose();
              navigate("/connect");
            }}
            className="font-medium text-neutral-800 hover:text-black inline-flex items-center gap-1"
          >
            Full import page <ExternalLink className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
