import React from "react";
import { FolderGit2, Globe, Loader2, CheckCircle2 } from "lucide-react";

function StatCell({ label, value, subtext, icon: Icon, highlight = false, loading = false }) {
  if (loading) {
    return (
      <div className="px-5 py-4 flex flex-col gap-2">
        <div className="h-3 w-24 bg-neutral-100 rounded animate-pulse" />
        <div className="h-7 w-16 bg-neutral-200 rounded animate-pulse" />
        <div className="h-3 w-28 bg-neutral-100 rounded animate-pulse" />
      </div>
    );
  }

  return (
    <div className="px-5 py-4 flex flex-col justify-between gap-1.5">
      <div className="flex items-center justify-between text-xs font-medium text-neutral-500">
        <span>{label}</span>
        {Icon && <Icon className="w-3.5 h-3.5 text-neutral-400" />}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight text-neutral-950 tabular-nums">
          {value}
        </span>
        {highlight && (
          <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
        )}
      </div>
      <span className="text-xs text-neutral-500 font-mono truncate">{subtext}</span>
    </div>
  );
}

export default function DashboardStatsStrip({ stats, tierConfig, activeBuildsCount, loading = false }) {
  const maxConcurrentLabel =
    tierConfig?.concurrentBuilds === Infinity ? "Unlimited" : String(tierConfig?.concurrentBuilds ?? 1);

  const successLabel =
    stats?.successRate !== null && stats?.successRate !== undefined ? `${stats.successRate}%` : "—";

  const durationSubtext =
    stats?.avgBuildDurationSec !== null && stats?.avgBuildDurationSec !== undefined
      ? `Avg duration ${stats.avgBuildDurationSec}s`
      : `${stats?.totalBuilds || 0} total builds`;

  const webhookProjects = stats?.webhookProjects ?? null;
  const projectSubtext =
    webhookProjects !== null
      ? `${webhookProjects} webhook enabled`
      : `${stats?.totalPreviews || 0} total previews`;

  return (
    <section
      aria-label="Deployment overview statistics"
      className="bg-white border border-neutral-200 rounded-xl shadow-xs grid grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-neutral-200"
    >
      <StatCell
        label="Projects"
        value={stats?.totalProjects ?? 0}
        subtext={projectSubtext}
        icon={FolderGit2}
        loading={loading}
      />
      <StatCell
        label="Live Previews"
        value={stats?.livePreviews ?? 0}
        subtext={`${stats?.errorPreviews || 0} failing · ${stats?.archivedPreviews || 0} archived`}
        icon={Globe}
        highlight={(stats?.livePreviews ?? 0) > 0}
        loading={loading}
      />
      <StatCell
        label="Active Builds"
        value={activeBuildsCount}
        subtext={`Limit: ${activeBuildsCount} / ${maxConcurrentLabel} slots`}
        icon={Loader2}
        loading={loading}
      />
      <StatCell
        label="Build Success Rate"
        value={successLabel}
        subtext={durationSubtext}
        icon={CheckCircle2}
        loading={loading}
      />
    </section>
  );
}
