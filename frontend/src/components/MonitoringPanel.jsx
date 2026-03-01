import React from 'react';
import { Activity, MemoryStick, Loader2, ArrowDownUp, Clock, AlertCircle } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatBytes, formatPercent, formatUptime } from '../lib/metrics';
import { usePreviewStats } from '../hooks/usePreviewStats';

// Vercel-style minimalist tooltip
const CustomTooltip = ({ active, payload, label, unit }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-neutral-200 px-3 py-2 rounded-lg shadow-lg flex flex-col gap-1.5 min-w-[120px]">
        <p className="text-[10px] text-neutral-400 font-mono uppercase tracking-widest">{label}</p>
        {payload.map((entry, index) => (
          <div key={index} className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: entry.stroke || entry.fill }} />
              <span className="text-xs text-neutral-600 uppercase font-medium tracking-wide">{entry.name}</span>
            </div>
            <span className="text-sm font-semibold text-neutral-900 font-mono tracking-tight">
              {entry.value}{unit}
            </span>
          </div>
        ))}
      </div>
    );
  }
  return null;
};

export default function MonitoringPanel({ previewId, status }) {
  const { history, currentStats, isLoadingHistory, error, peakCpu, peakMemory, peakNetwork, timeRange, setTimeRange } = usePreviewStats(previewId, '1h', 100);

  if (status !== 'live' && status !== 'ready') {
    return (
      <div className="flex flex-col items-center justify-center p-8 border border-neutral-200 border-dashed rounded-2xl text-neutral-400 bg-neutral-50/50 min-h-[300px]">
        <Activity className="w-6 h-6 mb-3 opacity-40" />
        <p className="text-sm font-medium text-neutral-600">Telemetry Offline</p>
        <p className="text-xs mt-1">Container must be running to view metrics.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center p-8 border border-red-100 bg-red-50/50 rounded-2xl text-red-600 min-h-[300px]">
        <AlertCircle className="w-6 h-6 mb-3 opacity-80" />
        <p className="text-sm font-medium">Failed to load telemetry</p>
        <p className="text-xs opacity-80 mt-1">{error}</p>
      </div>
    );
  }

  if (isLoadingHistory) {
    return (
      <div className="flex flex-col items-center justify-center p-8 border border-neutral-100 rounded-2xl text-neutral-500 min-h-[300px] bg-white shadow-sm">
        <Loader2 className="w-5 h-5 mb-3 animate-spin text-neutral-400" />
        <p className="text-sm font-medium">Fetching historical data...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      
      {/* Segmented Control Header */}
      <div className="flex justify-end mb-4">
        <div className="inline-flex bg-neutral-100/80 p-0.5 rounded-lg border border-neutral-200/50 items-center">
          <button 
            onClick={() => setTimeRange('1h')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-200 ${timeRange === '1h' ? 'bg-white text-neutral-900 shadow-[0_1px_3px_rgba(0,0,0,0.1)]' : 'text-neutral-500 hover:text-neutral-800'}`}
          >
            Last 1h
          </button>
          <button 
            onClick={() => setTimeRange('24h')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-200 ${timeRange === '24h' ? 'bg-white text-neutral-900 shadow-[0_1px_3px_rgba(0,0,0,0.1)]' : 'text-neutral-500 hover:text-neutral-800'}`}
          >
            Last 24h
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* CPU Panel */}
        <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm flex flex-col hover:border-neutral-300 transition-colors duration-300">
          <div className="flex justify-between items-start mb-6">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-neutral-500 uppercase tracking-widest">
                <Activity className="w-3.5 h-3.5 text-neutral-800" /> CPU Usage
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-4xl font-semibold tracking-tighter text-neutral-900 font-mono">
                  {formatPercent(currentStats?.cpu).replace('%', '')}
                </span>
                <span className="text-xl text-neutral-400 font-medium">%</span>
              </div>
            </div>
            <div className="text-right">
              <span className="text-[9px] text-neutral-400 uppercase tracking-widest block mb-0.5">Peak</span>
              <span className="text-xs font-mono font-medium text-neutral-700">{peakCpu}%</span>
            </div>
          </div>
          
          <div className="h-[180px] w-full mt-auto -mx-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history}>
                <defs>
                  <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#000000" stopOpacity={0.06}/>
                    <stop offset="100%" stopColor="#000000" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f5f5f5" />
                <XAxis dataKey="time" hide />
                <YAxis hide domain={[0, 'dataMax + 10']} />
                <Tooltip content={<CustomTooltip unit="%" />} cursor={{ stroke: '#e5e5e5', strokeWidth: 1, strokeDasharray: '4 4' }} />
                <Area type="monotone" name="CPU" dataKey="cpu" stroke="#000000" strokeWidth={1.5} fillOpacity={1} fill="url(#cpuGrad)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Memory Panel */}
        <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm flex flex-col hover:border-neutral-300 transition-colors duration-300">
          <div className="flex justify-between items-start mb-6">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-neutral-500 uppercase tracking-widest">
                <MemoryStick className="w-3.5 h-3.5 text-[#0070F3]" /> RAM Usage
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-4xl font-semibold tracking-tighter text-neutral-900 font-mono">
                  {formatBytes(currentStats?.memory).replace(' MB', '')}
                </span>
                <span className="text-xl text-neutral-400 font-medium">MB</span>
              </div>
              <div className="text-[10px] text-neutral-400 font-medium tracking-wide mt-1 uppercase">
                Limit: {formatBytes(currentStats?.memoryLimit)} ({formatPercent(currentStats?.memoryPercent)})
              </div>
            </div>
            <div className="text-right">
              <span className="text-[9px] text-neutral-400 uppercase tracking-widest block mb-0.5">Peak</span>
              <span className="text-xs font-mono font-medium text-neutral-700">{peakMemory} MB</span>
            </div>
          </div>

          <div className="h-[180px] w-full mt-auto -mx-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history}>
                <defs>
                  <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0070F3" stopOpacity={0.1}/>
                    <stop offset="100%" stopColor="#0070F3" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f5f5f5" />
                <XAxis dataKey="time" hide />
                <YAxis hide domain={[0, 'dataMax + 20']} />
                <Tooltip content={<CustomTooltip unit=" MB" />} cursor={{ stroke: '#e5e5e5', strokeWidth: 1, strokeDasharray: '4 4' }} />
                <Area type="monotone" name="RAM" dataKey="memoryMB" stroke="#0070F3" strokeWidth={1.5} fillOpacity={1} fill="url(#memGrad)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Network Chart Panel */}
        <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm flex flex-col hover:border-neutral-300 transition-colors duration-300">
          <div className="flex justify-between items-start mb-6">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-neutral-500 uppercase tracking-widest">
                <ArrowDownUp className="w-3.5 h-3.5 text-emerald-500" /> Network I/O
              </div>
              <div className="flex items-baseline gap-4 mt-1">
                <span className="text-sm font-mono font-medium text-neutral-900"><span className="text-neutral-400 mr-1.5 text-[10px] tracking-widest">RX</span>{formatBytes(currentStats?.networkRx)}</span>
                <span className="text-sm font-mono font-medium text-neutral-900"><span className="text-neutral-400 mr-1.5 text-[10px] tracking-widest">TX</span>{formatBytes(currentStats?.networkTx)}</span>
              </div>
            </div>
            <div className="text-right">
              <span className="text-[9px] text-neutral-400 uppercase tracking-widest block mb-0.5">Peak</span>
              <span className="text-xs font-mono font-medium text-neutral-700">{peakNetwork.toFixed(1)} MB</span>
            </div>
          </div>

          <div className="h-[100px] w-full mt-auto -mx-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f5f5f5" />
                <XAxis dataKey="time" hide />
                <YAxis hide domain={[0, 'dataMax + 2']} />
                <Tooltip content={<CustomTooltip unit=" MB" />} cursor={{ stroke: '#e5e5e5', strokeWidth: 1, strokeDasharray: '4 4' }} />
                <Area type="monotone" name="RX" dataKey="networkRxMB" stroke="#10b981" strokeWidth={1.5} fillOpacity={0.05} fill="#10b981" isAnimationActive={false} />
                <Area type="monotone" name="TX" dataKey="networkTxMB" stroke="#f59e0b" strokeWidth={1.5} fillOpacity={0.05} fill="#f59e0b" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Uptime Panel */}
        <div className="bg-white border border-neutral-200 rounded-2xl p-6 shadow-sm flex flex-col justify-center hover:border-neutral-300 transition-colors duration-300">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-neutral-50/80 border border-neutral-100 rounded-xl">
              <Clock className="w-5 h-5 text-neutral-600" />
            </div>
            <div>
              <p className="text-[13px] font-semibold text-neutral-900 tracking-tight">Container Uptime</p>
              <p className="text-[11px] text-neutral-500 mt-0.5">Time since preview successfully booted</p>
            </div>
          </div>
          <div className="mt-6 text-3xl font-mono font-semibold tracking-tighter text-neutral-900">
            {formatUptime(currentStats?.uptime)}
          </div>
        </div>
        
      </div>
    </div>
  );
}