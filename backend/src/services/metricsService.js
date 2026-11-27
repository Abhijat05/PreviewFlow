// backend/src/services/metricsService.js
import { prisma as defaultPrisma } from "../db.js";

function escapeLabelValue(val) {
  return String(val ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function escapeHelp(val) {
  return String(val ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n");
}

function makeLabelKey(labelNames, labels = {}) {
  if (!labelNames || labelNames.length === 0) return "";
  return labelNames.map((name) => `${name}\u0000${String(labels[name] ?? "")}`).join("\u0001");
}

function formatLabels(labelNames, labels = {}, extra = {}) {
  const parts = [];
  for (const name of labelNames) {
    parts.push(`${name}="${escapeLabelValue(labels[name] ?? "")}"`);
  }
  for (const [k, v] of Object.entries(extra)) {
    parts.push(`${k}="${escapeLabelValue(v)}"`);
  }
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

function extractLabels(labelNames, key) {
  if (!labelNames || labelNames.length === 0 || !key) return {};
  const labels = {};
  for (const pair of key.split("\u0001")) {
    const idx = pair.indexOf("\u0000");
    if (idx !== -1) {
      labels[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
  }
  return labels;
}

class CounterMetric {
  constructor({ name, help, labelNames = [] }) {
    this.type = "counter";
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.values = new Map();
  }

  inc(labels = {}, value = 1) {
    const key = makeLabelKey(this.labelNames, labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  get(labels = {}) {
    return this.values.get(makeLabelKey(this.labelNames, labels)) || 0;
  }

  reset() {
    this.values.clear();
  }

  serialize() {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0 && this.labelNames.length === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [key, val] of this.values.entries()) {
        const labels = extractLabels(this.labelNames, key);
        lines.push(`${this.name}${formatLabels(this.labelNames, labels)} ${val}`);
      }
    }
    return lines;
  }
}

class GaugeMetric {
  constructor({ name, help, labelNames = [] }) {
    this.type = "gauge";
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.values = new Map();
  }

  set(labelsOrVal = {}, maybeVal) {
    if (typeof labelsOrVal === "number" && maybeVal === undefined) {
      this.values.set("", labelsOrVal);
      return;
    }
    const key = makeLabelKey(this.labelNames, labelsOrVal);
    this.values.set(key, Number(maybeVal) || 0);
  }

  inc(labelsOrVal = {}, maybeVal) {
    const hasLabels = typeof labelsOrVal === "object" && labelsOrVal !== null;
    const labels = hasLabels ? labelsOrVal : {};
    const delta = hasLabels ? (maybeVal ?? 1) : (labelsOrVal ?? 1);
    const key = makeLabelKey(this.labelNames, labels);
    this.values.set(key, (this.values.get(key) || 0) + delta);
  }

  dec(labelsOrVal = {}, maybeVal) {
    const hasLabels = typeof labelsOrVal === "object" && labelsOrVal !== null;
    const labels = hasLabels ? labelsOrVal : {};
    const delta = hasLabels ? (maybeVal ?? 1) : (labelsOrVal ?? 1);
    this.inc(labels, -delta);
  }

  get(labels = {}) {
    return this.values.get(makeLabelKey(this.labelNames, labels)) || 0;
  }

  reset() {
    this.values.clear();
  }

  serialize() {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} gauge`];
    if (this.values.size === 0 && this.labelNames.length === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [key, val] of this.values.entries()) {
        const labels = extractLabels(this.labelNames, key);
        lines.push(`${this.name}${formatLabels(this.labelNames, labels)} ${val}`);
      }
    }
    return lines;
  }
}

class HistogramMetric {
  constructor({ name, help, labelNames = [], buckets = [0.01, 0.05, 0.1, 0.5, 1, 5, 10] }) {
    this.type = "histogram";
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.series = new Map();
  }

  observe(labels = {}, value = 0) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return;

    const key = makeLabelKey(this.labelNames, labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = {
        counts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0
      };
      this.series.set(key, entry);
    }

    for (let i = 0; i < this.buckets.length; i++) {
      if (num <= this.buckets[i]) {
        entry.counts[i] += 1;
      }
    }
    entry.sum += num;
    entry.count += 1;
  }

  reset() {
    this.series.clear();
  }

  serialize() {
    const lines = [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} histogram`];
    for (const [key, entry] of this.series.entries()) {
      const labels = extractLabels(this.labelNames, key);
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${this.name}_bucket${formatLabels(this.labelNames, labels, { le: this.buckets[i] })} ${entry.counts[i]}`
        );
      }
      lines.push(
        `${this.name}_bucket${formatLabels(this.labelNames, labels, { le: "+Inf" })} ${entry.count}`
      );
      lines.push(`${this.name}_sum${formatLabels(this.labelNames, labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${formatLabels(this.labelNames, labels)} ${entry.count}`);
    }
    return lines;
  }
}

export function createMetricsRegistry() {
  const metrics = [];

  const register = (metric) => {
    metrics.push(metric);
    return metric;
  };

  const httpRequestsTotal = register(
    new CounterMetric({
      name: "previewflow_http_requests_total",
      help: "Total HTTP requests processed by route and status class",
      labelNames: ["method", "route", "status_class"]
    })
  );

  const httpRequestDurationSeconds = register(
    new HistogramMetric({
      name: "previewflow_http_request_duration_seconds",
      help: "HTTP request latency in seconds",
      labelNames: ["method", "route"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
    })
  );

  const buildsTotal = register(
    new CounterMetric({
      name: "previewflow_builds_total",
      help: "Total preview builds partitioned by outcome status and source",
      labelNames: ["status", "source"]
    })
  );

  const buildDurationSeconds = register(
    new HistogramMetric({
      name: "previewflow_build_duration_seconds",
      help: "Preview build execution duration in seconds",
      labelNames: ["status", "tier"],
      buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1200]
    })
  );

  const buildQueueDepth = register(
    new GaugeMetric({
      name: "previewflow_build_queue_depth",
      help: "Current number of builds in QUEUED, RUNNING, or RETRYING state",
      labelNames: ["status"]
    })
  );

  const previewsByStatus = register(
    new GaugeMetric({
      name: "previewflow_previews_by_status",
      help: "Current preview count partitioned by status",
      labelNames: ["status"]
    })
  );

  const webhooksTotal = register(
    new CounterMetric({
      name: "previewflow_webhooks_total",
      help: "Total incoming GitHub webhooks processed by event and outcome",
      labelNames: ["event", "outcome"]
    })
  );

  const auditEventsTotal = register(
    new CounterMetric({
      name: "previewflow_audit_events_total",
      help: "Total security and lifecycle audit events recorded",
      labelNames: ["action", "status"]
    })
  );

  const alertsTriggeredTotal = register(
    new CounterMetric({
      name: "previewflow_alerts_triggered_total",
      help: "Total health or security anomaly alerts triggered",
      labelNames: ["rule", "severity"]
    })
  );

  const socketConnectionsActive = register(
    new GaugeMetric({
      name: "previewflow_socket_connections_active",
      help: "Number of currently authenticated active Socket.IO connections"
    })
  );

  function serializeRuntimeMetrics() {
    const mem = process.memoryUsage();
    return [
      "# HELP previewflow_process_uptime_seconds Node.js process uptime in seconds",
      "# TYPE previewflow_process_uptime_seconds gauge",
      `previewflow_process_uptime_seconds ${Math.round(process.uptime())}`,
      "# HELP previewflow_process_resident_memory_bytes Resident set size in bytes",
      "# TYPE previewflow_process_resident_memory_bytes gauge",
      `previewflow_process_resident_memory_bytes ${mem.rss}`,
      "# HELP previewflow_nodejs_heap_used_bytes V8 heap used memory in bytes",
      "# TYPE previewflow_nodejs_heap_used_bytes gauge",
      `previewflow_nodejs_heap_used_bytes ${mem.heapUsed}`,
      "# HELP previewflow_nodejs_heap_total_bytes V8 heap total memory in bytes",
      "# TYPE previewflow_nodejs_heap_total_bytes gauge",
      `previewflow_nodejs_heap_total_bytes ${mem.heapTotal}`
    ];
  }

  return {
    httpRequestsTotal,
    httpRequestDurationSeconds,
    buildsTotal,
    buildDurationSeconds,
    buildQueueDepth,
    previewsByStatus,
    webhooksTotal,
    auditEventsTotal,
    alertsTriggeredTotal,
    socketConnectionsActive,
    reset() {
      for (const m of metrics) m.reset();
    },
    formatPrometheus() {
      const blocks = [];
      for (const m of metrics) {
        blocks.push(...m.serialize());
      }
      blocks.push(...serializeRuntimeMetrics());
      return `${blocks.join("\n")}\n`;
    }
  };
}

export const defaultMetrics = createMetricsRegistry();

export function recordHttpRequest({ method, route, statusCode, durationSeconds }) {
  const statusClass = `${Math.floor((Number(statusCode) || 500) / 100)}xx`;
  defaultMetrics.httpRequestsTotal.inc({
    method: method || "GET",
    route: route || "/unmatched",
    status_class: statusClass
  });
  defaultMetrics.httpRequestDurationSeconds.observe(
    { method: method || "GET", route: route || "/unmatched" },
    durationSeconds
  );
}

export function recordBuildMetric({ status, source = "UNKNOWN", tier = "FREE", durationSeconds = null }) {
  defaultMetrics.buildsTotal.inc({ status, source });
  if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds)) {
    defaultMetrics.buildDurationSeconds.observe({ status, tier }, durationSeconds);
  }
}

export function recordWebhookMetric({ event = "unknown", outcome = "unknown" }) {
  defaultMetrics.webhooksTotal.inc({ event, outcome });
}

export function recordAuditMetric({ action = "UNKNOWN", status = "SUCCESS" }) {
  defaultMetrics.auditEventsTotal.inc({ action, status });
}

export function recordAlertMetric({ rule = "UNKNOWN", severity = "warning" }) {
  defaultMetrics.alertsTriggeredTotal.inc({ rule, severity });
}

export function incActiveSockets() {
  defaultMetrics.socketConnectionsActive.inc(1);
}

export function decActiveSockets() {
  if (defaultMetrics.socketConnectionsActive.get() > 0) {
    defaultMetrics.socketConnectionsActive.dec(1);
  }
}

/**
 * Refreshes database-backed queue depth and preview status gauges safely with graceful degradation.
 */
export async function refreshDatabaseGauges(client = defaultPrisma) {
  const buildStatuses = ["QUEUED", "RUNNING", "RETRYING"];
  const previewStatuses = ["live", "building", "error"];
  const result = { queuedCount: 0, runningCount: 0, retryingCount: 0, degraded: false };

  try {
    const buildCounts = await Promise.all(
      buildStatuses.map((status) =>
        client.build.count({ where: { status } }).catch(() => null)
      )
    );
    const previewCounts = await Promise.all(
      previewStatuses.map((status) =>
        client.preview.count({ where: { status } }).catch(() => null)
      )
    );

    buildStatuses.forEach((status, i) => {
      if (typeof buildCounts[i] === "number") {
        defaultMetrics.buildQueueDepth.set({ status }, buildCounts[i]);
        if (status === "QUEUED") result.queuedCount = buildCounts[i];
        if (status === "RUNNING") result.runningCount = buildCounts[i];
        if (status === "RETRYING") result.retryingCount = buildCounts[i];
      } else {
        result.degraded = true;
      }
    });

    previewStatuses.forEach((status, i) => {
      if (typeof previewCounts[i] === "number") {
        defaultMetrics.previewsByStatus.set({ status }, previewCounts[i]);
      } else {
        result.degraded = true;
      }
    });
  } catch {
    result.degraded = true;
  }

  return result;
}

export function formatPrometheusMetrics() {
  return defaultMetrics.formatPrometheus();
}

export function resetMetrics() {
  defaultMetrics.reset();
}
