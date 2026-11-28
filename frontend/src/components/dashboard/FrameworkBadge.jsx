import React from "react";
import { Box, Code2, Cpu, FileCode2, Layers, Sparkles } from "lucide-react";

const FRAMEWORK_META = {
  nextjs: {
    label: "Next.js",
    icon: Layers,
    className: "bg-neutral-900 text-white border-neutral-900"
  },
  vite: {
    label: "Vite",
    icon: Sparkles,
    className: "bg-indigo-50 text-indigo-700 border-indigo-200"
  },
  "node-backend": {
    label: "Node.js",
    icon: Cpu,
    className: "bg-emerald-50 text-emerald-700 border-emerald-200"
  },
  static: {
    label: "Static",
    icon: FileCode2,
    className: "bg-sky-50 text-sky-700 border-sky-200"
  },
  dockerfile: {
    label: "Dockerfile",
    icon: Box,
    className: "bg-slate-100 text-slate-700 border-slate-200"
  }
};

export default function FrameworkBadge({ framework }) {
  const key = framework ? String(framework).toLowerCase() : "";
  const config = FRAMEWORK_META[key] || {
    label: framework || "Auto-detect",
    icon: Code2,
    className: "bg-neutral-100 text-neutral-600 border-neutral-200"
  };

  const Icon = config.icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[11px] font-medium tracking-tight ${config.className}`}
      title={`Framework: ${config.label}`}
    >
      <Icon className="w-3 h-3 shrink-0" />
      <span>{config.label}</span>
    </span>
  );
}
