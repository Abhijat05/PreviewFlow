import React, { useState } from "react";
import {
  Activity,
  CheckCircle2,
  Clock,
  GitCommit,
  History,
  Loader2,
  RefreshCw,
  Terminal,
  XCircle
} from "lucide-react";

function formatRelativeTime(timestamp) {
  if (!timestamp) return "";
  const ms = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function getBuildBadge(status) {
  switch (status) {
    case "COMPLETED":
      return {
        label: "Success",
        cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
        icon: <CheckCircle2 className="w-3 h-3" />
      };
    case "FAILED":
      return {
        label: "Failed",
        cls: "bg-red-50 text-red-700 border-red-200",
        icon: <XCircle className="w-3 h-3" />
      };
    case "RUNNING":
      return {
        label: "Running",
        cls: "bg-amber-50 text-amber-700 border-amber-200",
        icon: <Loader2 className="w-3 h-3 animate-spin" />
      };
    case "SUPERSEDED":
    case "CANCELLED":
      return {
        label: status === "CANCELLED" ? "Cancelled" : "Superseded",
        cls: "bg-neutral-100 text-neutral-600 border-neutral-200",
        icon: <Clock className="w-3 h-3" />
      };
    default:
      return {
        label: "Queued",
        cls: "bg-neutral-100 text-neutral-600 border-neutral-200",
        icon: <Clock className="w-3 h-3" />
      };
  }
}

export default function ActivityTimeline({
  recentBuilds = [],
  activity = [],
  loading = false,
  onViewLogs,
  onQuickRebuild
}) {
  const [tab, setTab] = useState("activity");

  if (loading) {
    return (
      <aside className="bg-white border border-neutral-200 rounded-xl p-5 space-y-4">
        <div className="h-5 w-36 bg-neutral-200 rounded animate-pulse" />
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="p-3 border border-neutral-100 rounded-lg space-y-2">
              <div className="h-3.5 w-3/4 bg-neutral-100 rounded animate-pulse" />
              <div className="h-3 w-1/2 bg-neutral-100 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Recent builds and activity timeline"
      className="bg-white border border-neutral-200 rounded-xl shadow-xs flex flex-col overflow-hidden"
    >
      <div className="px-4 py-3.5 border-b border-neutral-200 bg-neutral-50/60 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-neutral-600" />
          <h2 className="text-sm font-semibold text-neutral-950">Builds & Activity</h2>
        </div>

        <div className="inline-flex bg-neutral-200/70 p-0.5 rounded-lg text-xs">
          <button
            type="button"
            onClick={() => setTab("activity")}
            className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
              tab === "activity" ? "bg-white text-neutral-950 shadow-xs" : "text-neutral-600 hover:text-neutral-900"
            }`}
          >
            Activity
          </button>
          <button
            type="button"
            onClick={() => setTab("builds")}
            className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
              tab === "builds" ? "bg-white text-neutral-950 shadow-xs" : "text-neutral-600 hover:text-neutral-900"
            }`}
          >
            Builds ({recentBuilds.length})
          </button>
        </div>
      </div>

      <div className="divide-y divide-neutral-100 max-h-[680px] overflow-y-auto">
        {tab === "activity" ? (
          activity.length === 0 ? (
            <div className="p-8 text-center">
              <Activity className="w-5 h-5 text-neutral-300 mx-auto mb-2" />
              <p className="text-sm font-medium text-neutral-700">No activity recorded yet</p>
              <p className="text-xs text-neutral-500 mt-1">
                Repository connections, redeploys, and build completions appear here in real time.
              </p>
            </div>
          ) : (
            activity.map((item) => {
              const isFailure = item.status === "FAILURE" || item.status === "DENIED";
              return (
                <div key={item.id} className="px-4 py-3.5 hover:bg-neutral-50/80 transition-colors">
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${
                        isFailure ? "bg-red-500" : "bg-emerald-500"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-neutral-900 leading-snug">
                        {item.title}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 mt-1 text-[11px] text-neutral-500 font-mono">
                        <span>{formatRelativeTime(item.timestamp)}</span>
                        {item.commitSha && (
                          <span className="inline-flex items-center gap-0.5 text-neutral-600">
                            <GitCommit className="w-3 h-3" />
                            {String(item.commitSha).slice(0, 7)}
                          </span>
                        )}
                        {item.durationSec !== null && item.durationSec !== undefined && (
                          <span>{item.durationSec}s</span>
                        )}
                      </div>
                    </div>
                    {item.previewId && (
                      <button
                        type="button"
                        onClick={() => onViewLogs(item.previewId)}
                        className="p-1.5 text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors shrink-0"
                        title="Open build logs"
                        aria-label="Open build logs"
                      >
                        <Terminal className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )
        ) : recentBuilds.length === 0 ? (
          <div className="p-8 text-center">
            <Clock className="w-5 h-5 text-neutral-300 mx-auto mb-2" />
            <p className="text-sm font-medium text-neutral-700">No recent builds yet</p>
            <p className="text-xs text-neutral-500 mt-1">
              Trigger a pull request build or click Redeploy on any preview to inspect build runs.
            </p>
          </div>
        ) : (
          recentBuilds.map((b) => {
            const badge = getBuildBadge(b.status);
            return (
              <div key={b.id} className="px-4 py-3.5 hover:bg-neutral-50/80 transition-colors space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-neutral-900 truncate">
                      {b.repoName ? `${b.repoName} · PR #${b.prNumber}` : `Build #${b.buildNumber}`}
                    </p>
                    <p className="text-[11px] font-mono text-neutral-500 truncate mt-0.5">
                      {b.branch} · {String(b.commitSha || "head").slice(0, 7)}
                    </p>
                  </div>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${badge.cls}`}>
                    {badge.icon}
                    {badge.label}
                  </span>
                </div>

                <div className="flex items-center justify-between text-[11px] text-neutral-500">
                  <span className="font-mono">
                    {b.durationSec !== null && b.durationSec !== undefined ? `${b.durationSec}s · ` : ""}
                    {formatRelativeTime(b.completedAt || b.failedAt || b.queuedAt)}
                  </span>

                  {b.previewId && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onViewLogs(b.previewId)}
                        className="px-2 py-1 text-[11px] font-medium text-neutral-700 hover:bg-neutral-100 rounded inline-flex items-center gap-1"
                      >
                        <Terminal className="w-3 h-3" /> Logs
                      </button>
                      {b.status !== "RUNNING" && onQuickRebuild && (
                        <button
                          type="button"
                          onClick={() => onQuickRebuild({ id: b.previewId, prNumber: b.prNumber, status: "live" })}
                          className="px-2 py-1 text-[11px] font-medium text-neutral-700 hover:bg-neutral-100 rounded inline-flex items-center gap-1"
                        >
                          <RefreshCw className="w-3 h-3" /> Redeploy
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
