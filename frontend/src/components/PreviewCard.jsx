import React from "react";
import { Globe, RefreshCw, Trash2 } from "lucide-react";
import { ResourceMonitor } from "./ResourceMonitor";
import { cn } from "../lib/utils";

const PreviewCard = React.memo(({ preview, previewStats, onRebuild, onDelete }) => {
  return (
    <div className="bg-white border border-neutral-200 rounded-xl p-5 flex flex-col shadow-sm">
      {/* Header Info */}
      <div className="flex justify-between items-start mb-2">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-neutral-900 flex items-center gap-2">
            PR #{preview.prNumber}
          </h3>
          <a 
            href={preview.url} 
            target="_blank" 
            rel="noreferrer"
            className="text-xs text-neutral-500 hover:text-neutral-900 transition-colors flex items-center gap-1.5"
          >
            <Globe className="w-3 h-3" />
            {preview.url?.replace(/^https?:\/\//, '') || 'Pending URL...'}
          </a>
        </div>
        <span className={cn(
          "text-[10px] font-mono px-2 py-1 rounded-full uppercase tracking-wider",
          preview.status === "live" ? "bg-green-100 text-green-700" : "bg-neutral-100 text-neutral-600"
        )}>
          {preview.status}
        </span>
      </div>

      {/* Live Resource Monitor */}
      {preview.status === "live" && (
        <ResourceMonitor stats={previewStats} />
      )}
      
      {/* Actions */}
      <div className="mt-5 pt-4 border-t border-neutral-100 flex gap-3">
        <button 
          onClick={() => onRebuild(preview.id)}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium text-neutral-600 bg-neutral-50 hover:bg-neutral-100 rounded-lg transition-colors border border-neutral-200"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Rebuild
        </button>
        <button 
          onClick={() => onDelete(preview.id)}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors border border-red-100"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Delete
        </button>
      </div>
    </div>
  );
});

export default PreviewCard;