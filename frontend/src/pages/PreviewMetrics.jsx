import React from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { ChevronRight, Globe } from "lucide-react";
import MonitoringPanel from "../components/MonitoringPanel.jsx"; 

export default function PreviewMetrics() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  
  // Get preview data passed from Dashboard, fallback to "live" status if refreshed directly
  const preview = location.state?.preview || { prNumber: "...", id, url: "", status: "live" };

  return (
    <div className="min-h-screen bg-[#fafafa] font-sans selection:bg-blue-100 selection:text-blue-900">
      
      {/* Vercel-style Breadcrumb Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center text-sm">
            <button onClick={() => navigate('/')} className="text-gray-500 hover:text-black transition-colors font-medium">
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

        {/* The Monitoring Panel now handles all the charts, network, and uptime elements */}
        <MonitoringPanel previewId={id} status={preview.status} />

      </div>
    </div>
  );
}