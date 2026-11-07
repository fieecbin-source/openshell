import type { HostMetrics } from "../types/ipc";
import { readAvailableMetric } from "../stores/monitorStore";

export function memoryPercent(metrics: HostMetrics | null): number | null {
  const used = readAvailableMetric(metrics, "memory_used_bytes");
  const total = readAvailableMetric(metrics, "memory_total_bytes");
  return used === null || used < 0 || total === null || total <= 0
    ? null : Math.min(100, used / total * 100);
}

/** Same-session samples in the last three minutes; latest wins on duplicate timestamps. */
export function resourceSamples(metrics: HostMetrics | null, history: HostMetrics[]): HostMetrics[] {
  if (!metrics || !Number.isFinite(metrics.timestamp_ms)) return [];
  const byTime = new Map<number, HostMetrics>();
  for (const sample of [...history, metrics]) {
    if (sample.session_id === metrics.session_id && Number.isFinite(sample.timestamp_ms)
      && sample.timestamp_ms <= metrics.timestamp_ms && sample.timestamp_ms >= metrics.timestamp_ms - 180_000) {
      byTime.set(sample.timestamp_ms, sample);
    }
  }
  return [...byTime.values()].sort((a, b) => a.timestamp_ms - b.timestamp_ms).slice(-60);
}
