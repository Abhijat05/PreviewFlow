import { Activity, MemoryStick } from "lucide-react";
import { cn, formatBytesToMB } from "../lib/utils";

export function ResourceMonitor({ stats }) {
  // Skeleton state: Waiting for the first socket payload
  if (!stats) {
    return (
      <div className="mt-4 pt-4 border-t border-neutral-200 animate-pulse flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <div className="h-3 bg-neutral-100 rounded w-12"></div>
          <div className="h-1.5 bg-neutral-100 rounded-full w-full"></div>
        </div>
        <div className="flex flex-col gap-2">
          <div className="h-3 bg-neutral-100 rounded w-12"></div>
          <div className="h-1.5 bg-neutral-100 rounded-full w-3/4"></div>
        </div>
      </div>
    );
  }

  const { cpu, memory } = stats;
  const memoryMB = formatBytesToMB(memory);
  
  // Define thresholds
  const isCpuHigh = cpu > 70;
  // Assuming a container limit of 512MB for calculation
  const isMemoryHigh = memoryMB > 400; 

  return (
    <div className="mt-4 pt-4 border-t border-neutral-200 space-y-3">
      {/* CPU Monitor */}
      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between items-center text-[11px] text-neutral-500 font-mono uppercase tracking-wider">
          <span className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" />
            CPU
          </span>
          <span className={cn("transition-colors", isCpuHigh ? "text-red-500 font-medium" : "")}>
            {cpu.toFixed(1)}%
          </span>
        </div>
        <div className="h-1.5 w-full bg-neutral-100 rounded-full overflow-hidden">
          <div 
            className={cn(
              "h-full transition-all duration-500 ease-out",
              isCpuHigh ? "bg-red-500" : "bg-neutral-800"
            )}
            style={{ width: `${Math.min(cpu, 100)}%` }}
          />
        </div>
      </div>

      {/* Memory Monitor */}
      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between items-center text-[11px] text-neutral-500 font-mono uppercase tracking-wider">
          <span className="flex items-center gap-1.5">
            <MemoryStick className="w-3.5 h-3.5" />
            RAM
          </span>
          <span className={cn("transition-colors", isMemoryHigh ? "text-amber-500 font-medium" : "")}>
            {memoryMB} MB
          </span>
        </div>
        <div className="h-1.5 w-full bg-neutral-100 rounded-full overflow-hidden">
          <div 
            className={cn(
              "h-full transition-all duration-500 ease-out",
              isMemoryHigh ? "bg-amber-500" : "bg-neutral-800"
            )}
            style={{ width: `${Math.min((memoryMB / 512) * 100, 100)}%` }} 
          />
        </div>
      </div>
    </div>
  );
}