export function formatBytes(bytes, decimals = 1) {
  if (bytes === undefined || bytes === null) return "—";
  if (bytes === 0) return '0 MB';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.max(2, Math.floor(Math.log(bytes) / Math.log(k)));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

export function formatPercent(value, decimals = 1) {
  if (value === undefined || value === null) return "—";
  return `${Number(value).toFixed(decimals)}%`;
}

export function formatUptime(seconds) {
  if (seconds === undefined || seconds === null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

// Chart specific helpers
export function bytesToMB(bytes) {
  if (!bytes) return 0;
  return Number((bytes / (1024 * 1024)).toFixed(1));
}

export function getChartTimestamp(date = new Date()) {
  return date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}