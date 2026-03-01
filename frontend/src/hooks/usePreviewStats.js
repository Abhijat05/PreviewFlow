import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import axios from 'axios';
import { bytesToMB, getChartTimestamp } from '../lib/metrics';

const socket = io("http://localhost:4000", { transports: ["websocket"] });

export function usePreviewStats(previewId, initialRange = '1h', maxSamples = 100) {
  const [history, setHistory] = useState([]);
  const [currentStats, setCurrentStats] = useState(null);
  
  // States for UI
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [error, setError] = useState(null);
  const [timeRange, setTimeRange] = useState(initialRange);

  // We use a ref to safely drop socket events while the API is still fetching
  // This prevents race conditions where a socket tick overwrites the history array
  const isFetchingRef = useRef(true);
  const token = localStorage.getItem("token");

  // 1. Fetch History on Mount or Range Change
  useEffect(() => {
    if (!previewId) return;
    let isMounted = true;

    const fetchHistory = async () => {
      isFetchingRef.current = true;
      setIsLoadingHistory(true);
      setError(null);

      try {
        const res = await axios.get(`http://localhost:4000/api/previews/${previewId}/metrics?range=${timeRange}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (!isMounted) return;

        // Map the API schema to match our existing UI schema
        const formattedHistory = (res.data.metrics || []).map(m => {
          const date = new Date(m.createdAt);
          return {
            time: getChartTimestamp(date),
            cpu: Number((m.cpu || 0).toFixed(1)),
            memory: m.memory || 0,
            memoryMB: bytesToMB(m.memory),
            networkRx: m.networkRx || 0,
            networkTx: m.networkTx || 0,
            networkRxMB: bytesToMB(m.networkRx),
            networkTxMB: bytesToMB(m.networkTx)
          };
        });

        setHistory(formattedHistory);
        if (formattedHistory.length > 0) {
          setCurrentStats(formattedHistory[formattedHistory.length - 1]);
        }
      } catch (err) {
        if (isMounted) setError(err.response?.data?.message || "Failed to load historical metrics");
      } finally {
        if (isMounted) {
          setIsLoadingHistory(false);
          isFetchingRef.current = false; // Open the gates for socket data
        }
      }
    };

    fetchHistory();

    return () => { isMounted = false; };
  }, [previewId, timeRange, token]);

  // 2. Real-time Socket Subscription
  useEffect(() => {
    if (!previewId) return;

    const handleStatsUpdate = (payload) => {
      if (payload.previewId !== previewId) return;
      
      // Drop socket events if we are currently loading history
      if (isFetchingRef.current) return;

      const newDataPoint = {
        time: getChartTimestamp(),
        cpu: payload.cpu ? Number(payload.cpu.toFixed(1)) : 0,
        memory: payload.memory,
        memoryMB: bytesToMB(payload.memory),
        memoryLimit: payload.memoryLimit,
        memoryPercent: payload.memoryPercent,
        networkRx: payload.networkRx,
        networkTx: payload.networkTx,
        networkRxMB: bytesToMB(payload.networkRx),
        networkTxMB: bytesToMB(payload.networkTx),
        uptime: payload.uptime
      };

      setCurrentStats(newDataPoint);

      setHistory((prev) => {
        // Prevent duplicate timestamps on the chart
        if (prev.length > 0 && prev[prev.length - 1].time === newDataPoint.time) {
          const newArr = [...prev];
          newArr[newArr.length - 1] = newDataPoint;
          return newArr;
        }
        return [...prev, newDataPoint].slice(-maxSamples);
      });
    };

    socket.on("preview-stats-update", handleStatsUpdate);
    return () => socket.off("preview-stats-update", handleStatsUpdate);
  }, [previewId, maxSamples]);

  // Derived peak calculations for the UI
  const peakCpu = history.length > 0 ? Math.max(...history.map(d => d.cpu)).toFixed(1) : 0;
  const peakMemory = history.length > 0 ? Math.max(...history.map(d => d.memoryMB)) : 0;
  
  // Network peak uses the highest of either RX or TX
  const peakNetwork = history.length > 0 ? Math.max(...history.map(d => Math.max(d.networkRxMB || 0, d.networkTxMB || 0))) : 0;

  return {
    history,
    currentStats,
    isLoadingHistory,
    error,
    peakCpu,
    peakMemory,
    peakNetwork,
    timeRange,
    setTimeRange
  };
}