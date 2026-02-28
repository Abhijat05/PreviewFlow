import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { bytesToMB, getChartTimestamp } from '../lib/metrics';

const socket = io("http://localhost:4000", { transports: ["websocket"] });

export function usePreviewStats(previewId, maxSamples = 40) {
  const [history, setHistory] = useState([]);
  const [currentStats, setCurrentStats] = useState(null);
  const [isReceiving, setIsReceiving] = useState(false);

  // 1. Reset state cleanly ONLY when previewId changes (Prevents infinite loops)
  useEffect(() => {
    setHistory([]);
    setCurrentStats(null);
    setIsReceiving(false);
  }, [previewId]);

  // 2. Socket Listener
  useEffect(() => {
    if (!previewId) return;

    const handleStatsUpdate = (payload) => {
      if (payload.previewId !== previewId) return;
      setIsReceiving(true);

      // Additive state shape: Preserves existing, adds new
      const newDataPoint = {
        time: getChartTimestamp(),
        
        // --- EXISTING FIELDS (Do not modify usage) ---
        cpu: payload.cpu,
        memory: payload.memory,
        memoryMB: bytesToMB(payload.memory), // Used strictly for Recharts Y-Axis
        
        // --- NEW OPTIONAL FIELDS ---
        memoryLimit: payload.memoryLimit,
        memoryPercent: payload.memoryPercent,
        networkRx: payload.networkRx,
        networkTx: payload.networkTx,
        uptime: payload.uptime
      };

      setCurrentStats(newDataPoint);

      // Functional update to prevent stale closures
      setHistory((prevHistory) => {
        const updatedHistory = [...prevHistory, newDataPoint];
        return updatedHistory.slice(-maxSamples);
      });
    };

    socket.on("preview-stats-update", handleStatsUpdate);
    return () => socket.off("preview-stats-update", handleStatsUpdate);
  }, [previewId, maxSamples]);

  // Derived peak values for the UI
  const peakCpu = history.length > 0 ? Math.max(...history.map(d => d.cpu)).toFixed(1) : 0;
  const peakMemory = history.length > 0 ? Math.max(...history.map(d => d.memoryMB)) : 0;

  return {
    history,
    currentStats,
    isReceiving,
    peakCpu,
    peakMemory
  };
}