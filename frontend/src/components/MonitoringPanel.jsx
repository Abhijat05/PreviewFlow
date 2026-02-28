import React from 'react';
import { Activity, MemoryStick, Loader2, ArrowDownUp, Clock } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatBytes, formatPercent, formatUptime } from '../lib/metrics';
import { usePreviewStats } from '../hooks/usePreviewStats';

// Vercel-style custom tooltip
const CustomTooltip = ({ active, payload, label, unit }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-gray-200 px-3 py-2 rounded-lg shadow-sm flex flex-col gap-1">
        <p className="text-[10px] text-gray-500 font-mono uppercase tracking-wider">{label}</p>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: payload[0].stroke }} />
          <span className="text-sm font-semibold text-gray-900 font-mono">
            {payload[0].value}{unit}
          </span>
        </div>
      </div>
    );
  }
  return null;
};

export default function MonitoringPanel({ previewId, status }) {
  const { history, currentStats, isReceiving, peakCpu, peakMemory } = usePreviewStats(previewId);

  // Handle stopped states
  if (status !== 'live') {
    return (
      <div className="flex flex-col items-center justify-center p-8 border border-gray-200 border-dashed rounded-xl text-gray-400 bg-gray-50 min-h-[300px]">
        <Activity className="w-6 h-6 mb-2 opacity-50" />
        <p className="text-sm font-medium text-gray-600">Telemetry Offline</p>
        <p className="text-xs">Container must be running to view metrics.</p>
      </div>
    );
  }

  // Handle loading states
  if (!currentStats && !isReceiving) {
    return (
      <div className="flex flex-col items-center justify-center p-8 border border-gray-200 rounded-xl text-gray-500 min-h-[300px]">
        <Loader2 className="w-5 h-5 mb-3 animate-spin text-blue-500" />
        <p className="text-sm">Connecting to telemetry stream...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      
      {/* Top Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* CPU Panel */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm flex flex-col hover:border-gray-300 transition-colors">
          <div className="flex justify-between items-start mb-6">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-600">
                <Activity className="w-4 h-4 text-black" /> CPU Usage
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-semibold tracking-tighter text-gray-900 font-mono">
                  {formatPercent(currentStats?.cpu).replace('%', '')}
                  <span className="text-2xl text-gray-400 font-normal ml-1">%</span>
                </span>
              </div>
            </div>
            <div className="text-right">
              <span className="text-[10px] text-gray-400 uppercase tracking-widest block mb-1">Peak</span>
              <span className="text-sm font-mono text-gray-900">{peakCpu}%</span>
            </div>
          </div>
          
          <div className="h-[200px] w-full mt-auto -mx-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history}>
                <defs>
                  <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#000000" stopOpacity={0.08}/>
                    <stop offset="95%" stopColor="#000000" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                <XAxis dataKey="time" hide />
                <YAxis hide domain={[0, 'dataMax + 20']} />
                <Tooltip content={<CustomTooltip unit="%" />} cursor={{ stroke: '#d1d5db', strokeWidth: 1, strokeDasharray: '4 4' }} />
                <Area type="monotone" dataKey="cpu" stroke="#000000" strokeWidth={2} fillOpacity={1} fill="url(#cpuGrad)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Memory Panel */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm flex flex-col hover:border-gray-300 transition-colors">
          <div className="flex justify-between items-start mb-6">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-600">
                <MemoryStick className="w-4 h-4 text-[#0070F3]" /> RAM Usage
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-semibold tracking-tighter text-gray-900 font-mono">
                  {/* Backward compatible: Uses existing 'memory' field */}
                  {formatBytes(currentStats?.memory).replace(' MB', '')}
                  <span className="text-2xl text-gray-400 font-normal ml-1">MB</span>
                </span>
              </div>
              {/* NEW: Incremental add-ons */}
              <div className="text-xs text-gray-500 font-medium mt-1">
                Limit: {formatBytes(currentStats?.memoryLimit)} ({formatPercent(currentStats?.memoryPercent)})
              </div>
            </div>
            <div className="text-right">
              <span className="text-[10px] text-gray-400 uppercase tracking-widest block mb-1">Peak</span>
              <span className="text-sm font-mono text-gray-900">{peakMemory} MB</span>
            </div>
          </div>

          <div className="h-[200px] w-full mt-auto -mx-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history}>
                <defs>
                  <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0070F3" stopOpacity={0.15}/>
                    <stop offset="95%" stopColor="#0070F3" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                <XAxis dataKey="time" hide />
                <YAxis hide domain={[0, 'dataMax + 50']} />
                <Tooltip content={<CustomTooltip unit=" MB" />} cursor={{ stroke: '#d1d5db', strokeWidth: 1, strokeDasharray: '4 4' }} />
                <Area type="monotone" dataKey="memoryMB" stroke="#0070F3" strokeWidth={2} fillOpacity={1} fill="url(#memGrad)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Bottom Panel: New Additive Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Network I/O */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm flex items-center justify-between hover:border-gray-300 transition-colors">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl">
              <ArrowDownUp className="w-5 h-5 text-gray-500" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">Network I/O</p>
              <p className="text-xs text-gray-500 mt-0.5">Total traffic received & transmitted</p>
            </div>
          </div>
          <div className="text-right font-mono text-sm">
            <div className="flex items-center gap-2 justify-end">
              <span className="text-[10px] text-gray-400 uppercase tracking-widest">RX</span>
              <span className="font-semibold text-gray-900">{formatBytes(currentStats?.networkRx)}</span>
            </div>
            <div className="flex items-center gap-2 justify-end mt-1">
              <span className="text-[10px] text-gray-400 uppercase tracking-widest">TX</span>
              <span className="font-semibold text-gray-900">{formatBytes(currentStats?.networkTx)}</span>
            </div>
          </div>
        </div>

        {/* Uptime */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm flex items-center justify-between hover:border-gray-300 transition-colors">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-gray-50 border border-gray-100 rounded-xl">
              <Clock className="w-5 h-5 text-gray-500" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">Container Uptime</p>
              <p className="text-xs text-gray-500 mt-0.5">Time since preview booted</p>
            </div>
          </div>
          <div className="text-xl font-mono font-semibold tracking-tight text-gray-900">
            {formatUptime(currentStats?.uptime)}
          </div>
        </div>
        
      </div>
    </div>
  );
}