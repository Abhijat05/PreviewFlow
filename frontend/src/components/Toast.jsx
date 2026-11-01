import React, { useEffect } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, X } from "lucide-react";

export default function Toast({ message, type = "info", onClose }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const styles = {
    error: "bg-red-50 border-red-200 text-red-800",
    warning: "bg-amber-50 border-amber-200 text-amber-800",
    success: "bg-emerald-50 border-emerald-200 text-emerald-800",
    info: "bg-blue-50 border-blue-200 text-blue-800",
  };

  const icons = {
    error: <AlertCircle size={18} />,
    warning: <AlertTriangle size={18} />,
    success: <CheckCircle2 size={18} />,
    info: <AlertCircle size={18} />,
  };

  return (
    <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-5 fade-in duration-300">
      <div className={`flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border ${styles[type] || styles.warning}`}>
        {icons[type] || icons.warning}
        <span className="text-sm font-medium">{message}</span>
        <button
          onClick={onClose}
          className="ml-2 hover:bg-black/5 p-1 rounded-full transition-colors"
          aria-label="Close notification"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
