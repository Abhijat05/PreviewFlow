import React, { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import io from "socket.io-client";
import { Activity, MemoryStick, Globe, HardDrive, ChevronRight } from "lucide-react";
import { formatBytesToMB } from "../lib/utils";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// Ultra-minimalist Vercel-style tooltip
const CustomTooltip = ({ active, payload, label, unit }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-gray-200 px-3 py-2 rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.08)] flex flex-col gap-1">
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

export default function PreviewMetrics() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  
  const preview = location.state?.preview || { prNumber: "...", id, url: "" };

  const [history, setHistory] = useState([]);
  const [currentStats, setCurrentStats] = useState({ cpu: 0, memory: 0 });

  useEffect(() => {
    const socket = io("http://localhost:4000", { transports: ["websocket"] });

    const handleStatsUpdate = (payload) => {
      if (payload.previewId === id) {
        setCurrentStats({ cpu: payload.cpu, memory: payload.memory });
        
        setHistory((prev) => {
          const now = new Date();
          const timeString = now.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
          
          return [...prev, {
            time: timeString,
            cpu: Number(payload.cpu.toFixed(1)),
            memoryMB: Number(formatBytesToMB(payload.memory))
          }].slice(-40); // Increased to 40 for a smoother, longer chart
        });
      }
    };

    socket.on("preview-stats-update", handleStatsUpdate);
    return () => socket.disconnect();
  }, [id]);

  const currentMem = formatBytesToMB(currentStats.memory);
  const peakCpu = history.length ? Math.max(...history.map(d => d.cpu)).toFixed(1) : 0;
  const peakMem = history.length ? Math.max(...history.map(d => d.memoryMB)) : 0;

  return (
    <div className="min-h-screen bg-[#fafafa] font-sans selection:bg-blue-100 selection:text-blue-900">
      
      {/* Vercel-style Breadcrumb Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center text-sm">
            <button onClick={() => navigate('/dashboard')} className="text-gray-500 hover:text-black transition-colors font-medium">
              Dashboard
            </button>
            <ChevronRight className="w-4 h-4 mx-1.5 text-gray-300" />
            <span className="text-gray-900 font-medium flex items-center gap-2">
              PR #{preview.prNumber}
            </span>
            <ChevronRight className="w-4 h-4 mx-1.5 text-gray-300" />
            <span className="text-gray-500">Telemetry</span>
          </div>

          {preview.url && (
            <a href={preview.url} target="_blank" rel="noreferrer" className="text-xs font-medium text-gray-600 hover:text-black bg-gray-50 hover:bg-gray-100 border border-gray-200 px-3 py-1.5 rounded-md transition-all flex items-center gap-2">
              <Globe className="w-3.5 h-3.5" /> Visit URL
            </a>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="p-6 max-w-6xl mx-auto space-y-6 mt-4">
        
        {/* Header Section */}
        <div className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Live Telemetry</h1>
          <p className="text-sm text-gray-500 mt-1 font-mono">{id}</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          
          {/* CPU Chart Card - Minimalist Black/White */}
          <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm flex flex-col hover:border-gray-300 transition-colors">
            <div className="flex justify-between items-start mb-6">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 text-sm font-medium text-gray-600">
                  <Activity className="w-4 h-4" /> CPU Usage
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-4xl font-semibold tracking-tighter text-gray-900 font-mono">
                    {currentStats.cpu.toFixed(1)}<span className="text-2xl text-gray-400 font-normal"> %</span>
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
                    <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#000000" stopOpacity={0.08}/>
                      <stop offset="95%" stopColor="#000000" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  {/* Faint dotted grid, horizontal only */}
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                  <XAxis dataKey="time" hide={true} /> 
                  <YAxis hide={true} domain={[0, 'dataMax + 20']} /> 
                  <Tooltip content={<CustomTooltip unit="%" />} cursor={{ stroke: '#d1d5db', strokeWidth: 1, strokeDasharray: '4 4' }} />
                  <Area type="monotone" dataKey="cpu" stroke="#000000" strokeWidth={2} fillOpacity={1} fill="url(#colorCpu)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Memory Chart Card - Vercel Blue */}
          <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm flex flex-col hover:border-gray-300 transition-colors">
            <div className="flex justify-between items-start mb-6">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 text-sm font-medium text-gray-600">
                  <MemoryStick className="w-4 h-4" /> RAM Usage
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-4xl font-semibold tracking-tighter text-gray-900 font-mono">
                    {currentMem}<span className="text-2xl text-gray-400 font-normal ml-1">MB</span>
                  </span>
                </div>
              </div>
              <div className="text-right">
                <span className="text-[10px] text-gray-400 uppercase tracking-widest block mb-1">Peak</span>
                <span className="text-sm font-mono text-gray-900">{peakMem} MB</span>
              </div>
            </div>

            <div className="h-[200px] w-full mt-auto -mx-1">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={history}>
                  <defs>
                    <linearGradient id="colorMem" x1="0" y1="0" x2="0" y2="1">
                      {/* Using exact Vercel Blue #0070F3 */}
                      <stop offset="5%" stopColor="#0070F3" stopOpacity={0.15}/>
                      <stop offset="95%" stopColor="#0070F3" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                  <XAxis dataKey="time" hide={true} />
                  <YAxis hide={true} domain={[0, 'dataMax + 50']} />
                  <Tooltip content={<CustomTooltip unit=" MB" />} cursor={{ stroke: '#d1d5db', strokeWidth: 1, strokeDasharray: '4 4' }} />
                  <Area type="monotone" dataKey="memoryMB" stroke="#0070F3" strokeWidth={2} fillOpacity={1} fill="url(#colorMem)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

        </div>

        {/* Future Backend Stats Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
            <div className="bg-[#fafafa] border border-gray-200 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-gray-400 min-h-[160px] hover:bg-gray-50 transition-colors">
                <Globe className="w-5 h-5 mb-3 text-gray-300" />
                <p className="text-sm font-medium text-gray-600">Network I/O</p>
                <p className="text-xs text-gray-400 mt-1">Coming Soon</p>
            </div>
            <div className="bg-[#fafafa] border border-gray-200 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-gray-400 min-h-[160px] hover:bg-gray-50 transition-colors">
                <HardDrive className="w-5 h-5 mb-3 text-gray-300" />
                <p className="text-sm font-medium text-gray-600">Storage / Disk</p>
                <p className="text-xs text-gray-400 mt-1">Coming Soon</p>
            </div>
        </div>

      </div>
    </div>
  );
}