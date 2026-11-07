import { useEffect, useId, useState } from "react";
import type { HostMetrics } from "../types/ipc";
import { readAvailableMetric, useMonitorStore } from "../stores/monitorStore";
import { resourceSamples } from "../lib/resourceMetrics";
import { ChevronDownIcon, NetworkIcon } from "./ui/icons";

const rate = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, value!) : 0;
const speed = (value: number) => value < 1024 ? `${value.toFixed(0)} B/s`
  : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB/s` : `${(value / 1024 ** 2).toFixed(1)} MB/s`;
const total = (value: number | undefined) => {
  const bytes = rate(value);
  const unit = Math.min(4, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
};

/** 图表横轴展示最近 3 分钟，坐标按真实采样时间推进，数据点随刷新左移形成平滑滚动 */
const WINDOW_MS = 180_000;
const WIDTH = 200;
const TOP = 2;
const BASELINE = 38;
const FIELDS = ["net_tx_bps", "net_rx_bps"] as const;
type RateField = typeof FIELDS[number];
const readRate = (metrics: HostMetrics | null, field: string) => {
  const value = readAvailableMetric(metrics, field);
  return value !== null && value >= 0 ? value : null;
};

/** The chart and both directions share one scale, using actual monitor samples. */
export function NetworkTraffic({ metrics, mode = "sidebar" }: {
  metrics: HostMetrics | null;
  mode?: "sidebar" | "rail" | "dashboard";
}) {
  const history = useMonitorStore((state) => state.history);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const id = useId();

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (mode === "rail" || (mode === "sidebar" && collapsed) || reducedMotion) return;
    let frame = 0;
    let last = 0;
    const tick = (time: number) => {
      if (time - last >= 50) {
        last = time;
        setNow(Date.now());
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [collapsed, reducedMotion, mode]);

  const samples = resourceSamples(metrics, history);
  const observedPeak = Math.max(0, ...samples.flatMap((sample) => FIELDS.map((field) => readRate(sample, field) ?? 0)));
  const peak = Math.max(1024, observedPeak);
  // Reduced-motion charts still advance on collection; they just do not scroll between samples.
  const plotTime = reducedMotion || mode === "rail" ? metrics?.timestamp_ms ?? now : Math.max(now, metrics?.timestamp_ms ?? now);
  const xFor = (timestamp: number) =>
    Math.max(2, Math.min(WIDTH - 2, WIDTH - 2 - ((plotTime - timestamp) / WINDOW_MS) * (WIDTH - 4)));
  const yFor = (value: number | undefined) => BASELINE - rate(value) / peak * (BASELINE - TOP);
  const points = (segment: HostMetrics[], field: RateField) => segment
    .map((sample) => `${xFor(sample.timestamp_ms)},${yFor(sample[field])}`).join(" ");
  const segments = (field: RateField) => {
    const result: HostMetrics[][] = [[]];
    for (const sample of samples) {
      if (readRate(sample, field) === null) {
        if (result[result.length - 1].length) result.push([]);
      } else result[result.length - 1].push(sample);
    }
    return result.filter((segment) => segment.length);
  };
  const tx = readRate(metrics, "net_tx_bps");
  const rx = readRate(metrics, "net_rx_bps");
  const upload = tx === null ? "不可用" : speed(tx);
  const download = rx === null ? "不可用" : speed(rx);
  const totalLabel = (field: string) => {
    const value = readRate(metrics, field);
    return value === null ? "不可用" : total(value);
  };
  const graph = (fields: readonly RateField[], className: string, label: string) => (
    <svg viewBox="0 0 200 40" preserveAspectRatio="none" className={className}
      role="img" aria-label={label}>
      {mode !== "rail" && [TOP, 20, BASELINE].map((y) => <path key={y} d={`M2 ${y}H198`} fill="none"
        className="stroke-line/10" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />)}
      {fields.filter((field) => readRate(metrics, field) !== null).map((field) => <g key={field} className={field === "net_tx_bps" ? "text-accent" : "text-state-success"}>
        {segments(field).map((segment, index) => <g key={index}>
          <polyline points={points(segment, field)} fill="none" stroke="currentColor" strokeWidth="1.5"
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </g>)}
      </g>)}
    </svg>
  );

  if (mode === "rail") return (
    <div className="flex flex-col items-center gap-2" aria-label="网络传输速率"
      title={`上行 ${upload} · 下行 ${download}`}>
      {FIELDS.map((field) => <div key={field} className="flex items-center gap-1">
        <span aria-hidden="true" className={`text-[10px] leading-none ${field === "net_tx_bps" ? "text-accent" : "text-state-success"}`}>
          {field === "net_tx_bps" ? "↑" : "↓"}
        </span>
        {graph([field], "h-3 w-6 shrink-0", `${field === "net_tx_bps" ? "上行" : "下行"}速率历史：${field === "net_tx_bps" ? upload : download}`)}
      </div>)}
    </div>
  );

  const dashboard = mode === "dashboard";
  const speedValue = (label: string) => {
    const [value, unit] = label.split(" ");
    return <div className="mt-1 flex flex-wrap items-baseline gap-x-1 text-ink">
      <span className="font-mono text-lg font-semibold leading-tight tracking-tight tabular-nums">{value}</span>
      {unit && <span className="text-[10px] font-medium text-ink-tertiary"> {unit}</span>}
    </div>;
  };
  const heading = <><NetworkIcon className="h-3.5 w-3.5 text-accent" />
    <span className="flex-1 text-left">网络传输速率</span></>;

  return (
    <section aria-label="网络仪表盘" className={`min-w-0 rounded-2xl border border-line/10 shadow-apple-sm ${dashboard ? "liquid-glass-card p-4" : "bg-surface/80 p-3"}`}>
      {dashboard ? <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
        {heading}<span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${metrics ? "bg-state-success/10 text-state-success" : "bg-line/5 text-ink-tertiary"}`}>{metrics ? "实时" : "无数据"}</span>
      </div> : <button type="button" aria-expanded={!collapsed} aria-controls={`${id}-content`}
        onClick={() => setCollapsed((value) => !value)} className="flex w-full items-center gap-1.5 text-xs font-semibold text-ink">
        {heading}<ChevronDownIcon className={`h-3.5 w-3.5 text-ink-tertiary transition-transform motion-reduce:transition-none ${collapsed ? "-rotate-90" : ""}`} />
      </button>}
      {(!collapsed || dashboard) && <div id={`${id}-content`} className="mt-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0"><span className="text-[10px] font-medium text-accent">↑ 上行</span>{speedValue(upload)}<div className="mt-1 text-[9px] text-ink-tertiary">累计 {totalLabel("net_tx_total")}</div></div>
          <div className="min-w-0"><span className="text-[10px] font-medium text-state-success">↓ 下行</span>{speedValue(download)}<div className="mt-1 text-[9px] text-ink-tertiary">累计 {totalLabel("net_rx_total")}</div></div>
        </div>
        <figure className="space-y-1.5 border-t border-line/10 pt-2">
          <div className="text-right text-[9px] text-ink-tertiary">{samples.length > 1 ? `峰值 ${speed(observedPeak)}` : "等待更多采样"}</div>
          {graph(FIELDS, dashboard ? "h-20 w-full" : "h-12 w-full", `网络速率历史：上行 ${upload}，下行 ${download}`)}
          <figcaption className="flex justify-between text-[9px] text-ink-tertiary"><span>最近 3 分钟</span><span>现在</span></figcaption>
        </figure>
      </div>}
    </section>
  );
}
