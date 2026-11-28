import React, { useEffect, useState } from "react";
import {
  Activity,
  Archive,
  Ban,
  CheckCircle2,
  Clock,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Loader2,
  MemoryStick,
  RefreshCw,
  Terminal,
  Trash2,
  Webhook,
  XCircle
} from "lucide-react";
import FrameworkBadge from "./FrameworkBadge.jsx";
import { formatBytesToMB } from "../../lib/utils.js";

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "";
  const numSeconds = parseFloat(seconds);
  if (!Number.isFinite(numSeconds) || numSeconds < 0) return "";
  if (numSeconds < 60) return `${numSeconds.toFixed(0)}s`;
  const m = Math.floor(numSeconds / 60);
  const s = Math.floor(numSeconds % 60);
  return `${m}m ${s}s`;
}

function getStatusVisuals(status) {
  switch (status) {
    case "live":
    case "ready":
      return {
        badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
        icon: <CheckCircle2 className="w-3 h-3" />,
        label: "Ready",
        rowBorder: "border-neutral-200 hover:border-emerald-300"
      };
    case "building":
      return {
        badge: "bg-amber-50 text-amber-700 border-amber-200",
        icon: <Loader2 className="w-3 h-3 animate-spin text-amber-600" />,
        label: "Building",
        rowBorder: "border-amber-300 bg-amber-50/20"
      };
    case "error":
      return {
        badge: "bg-red-50 text-red-700 border-red-200",
        icon: <XCircle className="w-3 h-3" />,
        label: "Error",
        rowBorder: "border-red-200 hover:border-red-300"
      };
    case "deleted":
      return {
        badge: "bg-neutral-100 text-neutral-500 border-neutral-200",
        icon: <Archive className="w-3 h-3" />,
        label: "Archived",
        rowBorder: "border-neutral-200 border-dashed bg-neutral-50/60"
      };
    default:
      return {
        badge: "bg-neutral-100 text-neutral-600 border-neutral-200",
        icon: <Clock className="w-3 h-3" />,
        label: "Queued",
        rowBorder: "border-neutral-200"
      };
  }
}

function LiveBuildTimer({ startTime }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) return;
    const start = new Date(startTime).getTime();
    setElapsed(Math.max(0, (Date.now() - start) / 1000));
    const interval = setInterval(() => {
      setElapsed(Math.max(0, (Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  return <span>{formatDuration(elapsed) || "0s"}</span>;
}

function CompactResourceMonitor({ stats, onClick }) {
  if (!stats) {
    return (
      <div className="mt-3 pt-3 border-t border-neutral-100 grid grid-cols-2 gap-3 opacity-60">
        <div className="space-y-1.5">
          <div className="h-2.5 w-12 bg-neutral-200 rounded animate-pulse" />
          <div className="h-1 w-full bg-neutral-100 rounded-full" />
        </div>
        <div className="space-y-1.5">
          <div className="h-2.5 w-14 bg-neutral-200 rounded animate-pulse" />
          <div className="h-1 w-full bg-neutral-100 rounded-full" />
        </div>
      </div>
    );
  }

  const cpu = Number(stats.cpu) || 0;
  const memoryMB = formatBytesToMB(stats.memory || 0);
  const isCpuHigh = cpu > 70;
  const isMemoryHigh = memoryMB > 400;

  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-3 pt-3 border-t border-neutral-100 w-full text-left grid grid-cols-2 gap-3 hover:bg-neutral-50 rounded-lg px-2 py-1.5 -mx-2 transition-colors group/monitor"
      title="View live resource telemetry"
    >
      <div className="space-y-1">
        <div className="flex justify-between items-center text-[11px] font-mono">
          <span className="text-neutral-500 flex items-center gap-1 uppercase text-[10px]">
            <Activity className="w-3 h-3 text-neutral-400 group-hover/monitor:text-neutral-900" />
            CPU
          </span>
          <span className={isCpuHigh ? "text-red-600 font-semibold" : "text-neutral-900 font-medium"}>
            {cpu.toFixed(1)}%
          </span>
        </div>
        <div className="h-1 w-full bg-neutral-100 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${isCpuHigh ? "bg-red-500" : "bg-neutral-900"}`}
            style={{ width: `${Math.min(cpu, 100)}%` }}
          />
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex justify-between items-center text-[11px] font-mono">
          <span className="text-neutral-500 flex items-center gap-1 uppercase text-[10px]">
            <MemoryStick className="w-3 h-3 text-neutral-400 group-hover/monitor:text-blue-600" />
            RAM
          </span>
          <span className={isMemoryHigh ? "text-amber-600 font-semibold" : "text-neutral-900 font-medium"}>
            {memoryMB} MB
          </span>
        </div>
        <div className="h-1 w-full bg-neutral-100 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${isMemoryHigh ? "bg-amber-500" : "bg-blue-600"}`}
            style={{ width: `${Math.min((memoryMB / 512) * 100, 100)}%` }}
          />
        </div>
      </div>
    </button>
  );
}

const DeploymentItem = React.memo(function DeploymentItem({
  pre,
  stats,
  isProcessing,
  onRebuild,
  onDeleteConfirm,
  onViewLogs,
  onOpenStats
}) {
  const statusStyle = getStatusVisuals(pre.status);
  const isDeleted = pre.status === "deleted";
  const isBuilding = pre.status === "building";
  const isLive = pre.status === "live" || pre.status === "ready";

  let timeDisplay = "Pending...";
  if (isBuilding && pre.buildStartedAt) {
    timeDisplay = (
      <span className="text-amber-700 font-medium">
        <LiveBuildTimer startTime={pre.buildStartedAt} />
      </span>
    );
  } else if (pre.buildCompletedAt && pre.buildStartedAt) {
    const diff = (new Date(pre.buildCompletedAt) - new Date(pre.buildStartedAt)) / 1000;
    timeDisplay = formatDuration(diff) || "Completed";
  }

  return (
    <div
      className={`border rounded-lg p-4 bg-white transition-all duration-200 flex flex-col justify-between ${statusStyle.rowBorder}`}
    >
      <div>
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] font-mono text-neutral-500">
              <GitPullRequest className="w-3.5 h-3.5 text-neutral-400" />
              <span>Pull Request</span>
            </div>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className={`text-lg font-semibold tracking-tight ${isDeleted ? "text-neutral-400" : "text-neutral-950"}`}>
                #{pre.prNumber}
              </span>
              {!isDeleted && (
                <span className="text-xs text-neutral-500 inline-flex items-center gap-1">
                  <Clock className="w-3 h-3 text-neutral-400" />
                  {timeDisplay}
                </span>
              )}
            </div>
          </div>

          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wider shrink-0 ${statusStyle.badge}`}
          >
            {statusStyle.icon}
            <span>{statusStyle.label}</span>
          </span>
        </div>

        {isLive && pre.url ? (
          <a
            href={pre.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between gap-2 w-full bg-neutral-50 hover:bg-neutral-100 border border-neutral-200 px-2.5 py-2 rounded-md transition-colors group/url"
          >
            <span className="text-xs font-mono text-neutral-700 truncate group-hover/url:text-blue-600">
              {pre.url.replace(/^https?:\/\//, "")}
            </span>
            <ExternalLink className="w-3.5 h-3.5 text-neutral-400 group-hover/url:text-blue-600 shrink-0" />
          </a>
        ) : (
          <div className="w-full h-[34px] flex items-center px-2.5 bg-neutral-50 border border-neutral-100 border-dashed rounded-md text-xs text-neutral-400 font-mono">
            {isBuilding ? (
              <span className="text-amber-700">Building environment...</span>
            ) : isDeleted ? (
              <span className="inline-flex items-center gap-1.5">
                <Ban className="w-3 h-3" /> Deployment archived
              </span>
            ) : (
              "Waiting for deployment..."
            )}
          </div>
        )}

        {isLive && <CompactResourceMonitor stats={stats} onClick={() => onOpenStats(pre)} />}
      </div>

      <div className="mt-4 pt-3 border-t border-neutral-100 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onViewLogs(pre.id)}
          className="text-xs font-medium text-neutral-700 bg-white border border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50 px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 transition-colors"
        >
          <Terminal className="w-3.5 h-3.5 text-neutral-500" />
          View Logs
        </button>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onRebuild(pre)}
            disabled={isProcessing || isBuilding}
            className={`p-1.5 rounded-md border border-transparent transition-colors ${
              isBuilding || isProcessing
                ? "text-neutral-300 cursor-not-allowed"
                : "text-neutral-500 hover:text-blue-600 hover:bg-blue-50 hover:border-blue-100"
            }`}
            title="Redeploy"
            aria-label={`Redeploy PR #${pre.prNumber}`}
          >
            <RefreshCw className={`w-4 h-4 ${isProcessing ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => onDeleteConfirm(pre)}
            disabled={isProcessing || isDeleted}
            className={`p-1.5 rounded-md border border-transparent transition-colors ${
              isDeleted || isProcessing
                ? "text-neutral-300 cursor-not-allowed"
                : "text-neutral-500 hover:text-red-600 hover:bg-red-50 hover:border-red-100"
            }`}
            title="Delete"
            aria-label={`Delete PR #${pre.prNumber}`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
});

export default function ProjectCard({
  project,
  statsMap,
  processingPreview,
  onRebuild,
  onDeleteConfirm,
  onViewLogs,
  onOpenStats
}) {
  const previews = project.previews || [];
  const liveCount = previews.filter((p) => p.status === "live" || p.status === "ready").length;
  const buildingCount = previews.filter((p) => p.status === "building").length;
  const errorCount = previews.filter((p) => p.status === "error").length;

  const latestActivePreview =
    previews.find((p) => p.status !== "deleted") || previews[0] || null;

  let overallLabel = "Idle";
  let overallBadge = "bg-neutral-100 text-neutral-600 border-neutral-200";
  if (buildingCount > 0) {
    overallLabel = `${buildingCount} Building`;
    overallBadge = "bg-amber-50 text-amber-700 border-amber-200";
  } else if (liveCount > 0) {
    overallLabel = `${liveCount} Live`;
    overallBadge = "bg-emerald-50 text-emerald-700 border-emerald-200";
  } else if (errorCount > 0) {
    overallLabel = `${errorCount} Failing`;
    overallBadge = "bg-red-50 text-red-700 border-red-200";
  }

  return (
    <article className="bg-white border border-neutral-200 rounded-xl shadow-xs overflow-hidden">
      {/* Project Header */}
      <div className="px-5 py-4 border-b border-neutral-200 bg-neutral-50/60 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          <div className="p-2 bg-white border border-neutral-200 rounded-lg text-neutral-700 shrink-0">
            <GitBranch className="w-4 h-4" />
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight text-neutral-950 truncate">
                {project.repoName}
              </h2>
              <span className="text-sm text-neutral-500 font-mono">
                /{project.repoOwner}
              </span>
              <a
                href={`https://github.com/${project.repoOwner}/${project.repoName}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-neutral-400 hover:text-neutral-800 transition-colors"
                title={`Open ${project.repoOwner}/${project.repoName} on GitHub`}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>

            <div className="flex flex-wrap items-center gap-2 mt-1">
              <FrameworkBadge framework={project.framework} />
              <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-medium ${overallBadge}`}>
                {overallLabel}
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] text-neutral-500">
                <Webhook className="w-3 h-3 text-neutral-400" />
                {project.hasWebhook ? "Webhook active" : "Manual sync"}
              </span>
            </div>
          </div>
        </div>

        {/* Project Quick Actions */}
        {latestActivePreview && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onViewLogs(latestActivePreview.id)}
              className="px-2.5 py-1.5 text-xs font-medium bg-white border border-neutral-200 hover:border-neutral-300 text-neutral-700 rounded-md inline-flex items-center gap-1.5 transition-colors"
            >
              <Terminal className="w-3.5 h-3.5 text-neutral-500" />
              Latest Logs
            </button>
            <button
              type="button"
              onClick={() => onRebuild(latestActivePreview)}
              disabled={processingPreview === latestActivePreview.id || latestActivePreview.status === "building"}
              className="px-2.5 py-1.5 text-xs font-medium bg-neutral-900 hover:bg-black disabled:opacity-40 text-white rounded-md inline-flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${processingPreview === latestActivePreview.id ? "animate-spin" : ""}`} />
              Redeploy PR #{latestActivePreview.prNumber}
            </button>
          </div>
        )}
      </div>

      {/* Deployments Body */}
      <div className="p-5">
        {previews.length === 0 ? (
          <div className="py-10 px-6 border border-dashed border-neutral-300 rounded-lg bg-neutral-50/60 text-center">
            <GitPullRequest className="w-5 h-5 text-neutral-400 mx-auto mb-2" />
            <p className="text-sm font-medium text-neutral-700">Waiting for Pull Requests...</p>
            <p className="text-xs text-neutral-500 mt-1 max-w-md mx-auto">
              Open or push to a pull request in{" "}
              <span className="font-mono text-neutral-700">
                {project.repoOwner}/{project.repoName}
              </span>{" "}
              to spin up your first preview URL.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {previews.map((pre) => (
              <DeploymentItem
                key={pre.id}
                pre={pre}
                stats={statsMap?.[pre.id]}
                isProcessing={processingPreview === pre.id}
                onRebuild={onRebuild}
                onDeleteConfirm={onDeleteConfirm}
                onViewLogs={onViewLogs}
                onOpenStats={onOpenStats}
              />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
