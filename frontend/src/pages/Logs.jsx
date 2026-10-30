import React, { useEffect, useRef, useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api, { API_BASE_URL } from "../api.js";
import axios from "axios";
import { useSocket } from "../context/SocketContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { X, Copy, Loader2, ArrowDownCircle, Lock } from "lucide-react";

const ALLOW_SOCKET_TIERS = ['PRO', 'ENTERPRISE'];

const highlightKeywords = (text) => {
  if (!text) return "";
  const parts = text.split(/(\s+)/);
  return parts.map((part, i) => {
    if (part.match(/^[0-9.]+s$/)) return <span key={i} className="text-yellow-400 font-bold">{part}</span>;
    
    if (part.startsWith("http://") || part.startsWith("https://")) {
      return (
        <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline decoration-blue-400/30 hover:text-blue-300">
          {part}
        </a>
      );
    }

    if (part === "npm") return <span key={i} className="text-red-400 font-semibold">{part}</span>;
    if (["install", "run", "build", "dev"].includes(part)) return <span key={i} className="text-cyan-400">{part}</span>;
    if (part.startsWith("sha256:")) return <span key={i} className="text-purple-400">{part.substring(0, 12)}...</span>;
    return part;
  });
};

const parseLogLine = (line, index) => {
  const cleanLine = line ? line.replace(/\r/g, "").trimEnd() : "";
  if (!cleanLine) return null;

  if (cleanLine.startsWith("===") || cleanLine.includes("BUILD FINISHED")) {
    return <div key={index} className="py-4 mt-2 font-bold text-emerald-400 border-t border-white/10 tracking-wider">{cleanLine}</div>;
  }

  if (cleanLine.trim().startsWith("#")) {
    const stepMatch = cleanLine.match(/^(#\d+)\s+(.*)/);
    if (stepMatch) {
      return (
        <div key={index} className="flex gap-3 py-0.5 group hover:bg-white/5 -mx-2 px-2 rounded transition-colors">
          <span className="text-blue-500 font-bold min-w-[35px] shrink-0 select-none opacity-80 group-hover:opacity-100">{stepMatch[1]}</span>
          <span className="text-gray-300 break-all whitespace-pre-wrap">{highlightKeywords(stepMatch[2])}</span>
        </div>
      );
    }
  }

  if (cleanLine.toLowerCase().includes("error") || cleanLine.toLowerCase().includes("failed")) {
    return (
      <div key={index} className="flex border-l-[3px] border-red-500 bg-red-500/5 pl-4 py-1">
        <span className="text-red-400 break-all whitespace-pre-wrap leading-relaxed">{cleanLine}</span>
      </div>
    );
  }

  if (cleanLine.includes("DONE") || cleanLine.includes("success")) {
    return (
      <div key={index} className="flex gap-3 text-emerald-400 font-medium py-1">
        <span className="text-blue-500 font-bold min-w-[35px] shrink-0 opacity-50">✓</span>
        <span className="break-all whitespace-pre-wrap">{cleanLine}</span>
      </div>
    )
  }

  return <div key={index} className="text-gray-400 break-all whitespace-pre-wrap py-[1px] pl-[47px] hover:text-gray-200 transition-colors">{highlightKeywords(cleanLine)}</div>;
};

export default function Logs({ previewId, onClose }) {
  const params = useParams();
  const id = previewId || params.id;
  const isEmbedded = !!previewId;

  const [logs, setLogs] = useState("");
  const [status, setStatus] = useState("loading");
  const [autoScroll, setAutoScroll] = useState(true);
  const [error, setError] = useState(null);
  
  const { socket, joinPreview, leavePreview } = useSocket();
  const { tier: userTier } = useAuth();
  const isMounted = useRef(true);
  const token = localStorage.getItem("token");
  const navigate = useNavigate();
  const logContainerRef = useRef(null);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    if (!token) { if (!isEmbedded) navigate("/"); return; }
    
    // Initial Tier from Token
    const tier = getUserTier(token);
    if(isMounted.current) setUserTier(tier);

    const controller = new AbortController();

    setLogs(""); 
    setStatus("loading");
    setError(null);

    // Fetch Logs
    api.get(`/api/preview/${id}/logs`, { 
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    })
      .then((res) => { 
        if (isMounted.current) {
          setLogs((res.data.logs || "").replace(/\r/g, "")); 
          setStatus("ready"); 
        }
      })
      .catch((err) => { 
        if (axios.isCancel(err)) return;
        console.error(err); 
        if (isMounted.current) {
          setLogs((prev) => prev + "\n[Error fetching saved logs]"); 
          setStatus("ready"); 
        }
      });


    return () => controller.abort();
  }, [id, token, navigate, isEmbedded]);

  useEffect(() => {
    if (!token || !socket) return;
    
    // Use the State tier, not the token tier, to allow live update
    if (!ALLOW_SOCKET_TIERS.includes(userTier)) return;

    joinPreview(id);

    const handleLog = ({ chunk }) => { 
      if (!isMounted.current) return;
      setLogs((prev) => prev + chunk.replace(/\r/g, "")); 
      if (autoScroll) scrollToBottom(); 
    };
    
    const handleLogFinish = ({ url }) => {
      if (isMounted.current) setLogs((prev) => prev + `\n\n=== BUILD FINISHED: ${url} ===\n`);
    };
    
    const handleLogError = ({ message }) => {
      if (isMounted.current) setLogs((prev) => prev + `\n\n=== BUILD ERROR: ${message} ===\n`);
    };

    socket.on("log", handleLog);
    socket.on("log-finish", handleLogFinish);
    socket.on("log-error", handleLogError);

    return () => {
      socket.off("log", handleLog);
      socket.off("log-finish", handleLogFinish);
      socket.off("log-error", handleLogError);
      leavePreview(id);
    };
  }, [id, token, autoScroll, userTier, socket, joinPreview, leavePreview]); // Added userTier dependency

  const scrollToBottom = () => { if (logContainerRef.current) logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight; };
  useEffect(() => { scrollToBottom(); }, [logs]);

  const handleScroll = (e) => {
      const { scrollTop, scrollHeight, clientHeight } = e.target;
      const isAtBottom = scrollHeight - scrollTop <= clientHeight + 50;
      setAutoScroll(isAtBottom);
  }

  const logLines = useMemo(() => {
    try {
      return logs.split("\n").map((line, index) => parseLogLine(line, index));
    } catch (e) {
      console.error("Log Parsing Error:", e);
      return <div className="text-red-500 p-4">Error parsing logs. Raw output unavailable.</div>;
    }
  }, [logs]);

  const copyLogs = () => navigator.clipboard.writeText(logs);

  if (error) return <div className="text-red-500 p-6">Failed to load logs component.</div>;

  return (
    <div className={`flex flex-col h-full bg-[#09090b] text-gray-300 font-mono text-[13px] ${isEmbedded ? '' : 'min-h-screen'}`}>
      
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-[#09090b]/80 backdrop-blur-md sticky top-0 z-20 transition-all">
        <div className="flex items-center gap-4">
            <div className={`w-2.5 h-2.5 rounded-full shadow-[0_0_10px_rgba(234,179,8,0.4)] ${status === 'loading' ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500 shadow-[0_0_10px_rgba(34,197,94,0.4)]'}`} />
            <div>
                <h2 className="text-white font-semibold tracking-tight text-sm">Build Logs</h2>
                <div className="flex items-center gap-2 text-[11px] text-gray-500 font-mono mt-0.5">
                   <span>ID:</span><span className="bg-white/10 px-1.5 py-0.5 rounded text-gray-300">{id?.slice(0, 8)}</span>
                   {!ALLOW_SOCKET_TIERS.includes(userTier) && (
                     <span className="flex items-center gap-1 text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded ml-2 border border-amber-500/20">
                       <Lock size={10} /> Live logs locked
                     </span>
                   )}
                </div>
            </div>
        </div>
        
        <div className="flex items-center gap-2">
            {!autoScroll && (
                <button onClick={() => { setAutoScroll(true); scrollToBottom(); }} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500/10 text-blue-400 text-xs font-medium rounded-full hover:bg-blue-500/20 transition-all mr-2">
                    <ArrowDownCircle size={14} /><span>Resume</span>
                </button>
            )}
            <button onClick={copyLogs} className="p-2 hover:bg-white/10 rounded-lg transition-colors text-gray-500 hover:text-white" title="Copy"><Copy size={16} /></button>
            <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg transition-colors text-gray-500 hover:text-white" title="Close"><X size={18} /></button>
        </div>
      </div>

      <div ref={logContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overflow-x-hidden p-6 custom-scrollbar scroll-smooth">
        {status === "loading" && !logs ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-gray-600" />
            <span className="text-xs uppercase tracking-widest font-semibold">Initializing Environment...</span>
          </div>
        ) : (
          <div className="font-mono leading-relaxed tracking-wide text-[12px] md:text-[13px]">
            {logLines}
            <div className="mt-2 ml-[47px] animate-pulse w-2 h-4 bg-gray-500 inline-block align-middle" />
          </div>
        )}
      </div>
      <style>{`.custom-scrollbar::-webkit-scrollbar { width: 6px; } .custom-scrollbar::-webkit-scrollbar-track { background: transparent; } .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #333; border-radius: 20px; border: 1px solid #09090b; } .custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: #555; }`}</style>
    </div>
  );
}