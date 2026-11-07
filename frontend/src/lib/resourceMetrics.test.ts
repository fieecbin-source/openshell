import { expect, it } from "vitest";
import type { HostMetrics } from "../types/ipc";
import { memoryPercent, resourceSamples } from "./resourceMetrics";

const sample = (extra: Partial<HostMetrics> = {}) => ({
  session_id: "a", timestamp_ms: 200_000, memory_total_bytes: 100, memory_used_bytes: 50, ...extra,
}) as HostMetrics;

it("keeps real zero memory usage while rejecting missing or invalid capacity", () => {
  expect(memoryPercent(sample({ memory_used_bytes: 0 }))).toBe(0);
  expect(memoryPercent(sample({ memory_used_bytes: 150 }))).toBe(100);
  for (const extra of [
    { memory_total_bytes: 0 }, { memory_used_bytes: NaN }, { memory_used_bytes: -1 },
    { unavailable_fields: ["memory_used_bytes"] },
  ]) expect(memoryPercent(sample(extra))).toBeNull();
  expect(memoryPercent(null)).toBeNull();
});

it("orders and bounds history, drops other sessions and lets the current snapshot win", () => {
  const latest = sample({ cpu_percent: 32 });
  const history = [
    sample({ timestamp_ms: 197_000 }), sample({ timestamp_ms: 194_000 }),
    sample({ timestamp_ms: 19_999 }), sample({ timestamp_ms: 200_001 }),
    sample({ session_id: "b", timestamp_ms: 199_000 }), sample({ timestamp_ms: NaN }),
    sample({ cpu_percent: 99 }),
  ];
  expect(resourceSamples(latest, history).map((m) => m.timestamp_ms)).toEqual([194_000, 197_000, 200_000]);
  expect(resourceSamples(latest, history).at(-1)?.cpu_percent).toBe(32);
  expect(resourceSamples(null, history)).toEqual([]);
  expect(resourceSamples(latest, Array.from({ length: 90 }, (_, i) => sample({ timestamp_ms: 200_000 - i * 1000 })))).toHaveLength(60);
});
