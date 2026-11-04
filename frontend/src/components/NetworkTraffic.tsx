import { useEffect, useId, useState } from "react";
import type { HostMetrics } from "../types/ipc";
import { useMonitorStore } from "../stores/monitorStore";
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
const WIDTH = 220;
const TOP = 6;
const BASELINE = 62;

/** The chart and both directions share one scale, using actual monitor samples. */
export function NetworkTraffic({ metrics }: { metrics: HostMetrics | null }) {
  const history = useMonitorStore((state) => state.history);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const id = useId();

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
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
  }, []);

  const ordered = [...history].sort((a, b) => a.timestamp_ms - b.timestamp_ms).slice(-60);
  const samples = metrics && metrics.timestamp_ms > (ordered[ordered.length - 1]?.timestamp_ms ?? 0)
    ? [...ordered.slice(-59), metrics] : ordered;
  const peak = Math.max(1024, ...samples.flatMap((sample) => [rate(sample.net_tx_bps), rate(sample.net_rx_bps)]));
  const xFor = (timestamp: number) =>
    Math.max(0, Math.min(WIDTH, WIDTH - ((now - timestamp) / WINDOW_MS) * WIDTH));
  const yFor = (value: number | undefined) => BASELINE - rate(value) / peak * (BASELINE - TOP);
  const points = (field: "net_tx_bps" | "net_rx_bps") => samples
    .map((sample) => `${xFor(sample.timestamp_ms)},${yFor(sample[field])}`).join(" ");
  const upload = speed(rate(metrics?.net_tx_bps));
  const download = speed(rate(metrics?.net_rx_bps));

  return (
    <section className="rounded-xl bg-surface/70 p-2.5 shadow-apple-sm">
      <button type="button" aria-expanded={!collapsed} aria-controls={`${id}-content`}
        onClick={() => setCollapsed((value) => !value)} className="flex w-full items-center gap-1.5 text-xs font-semibold text-ink">
        <NetworkIcon className="h-3.5 w-3.5 text-accent" />
        <span className="flex-1 text-left">网络传输速率</span>
        <ChevronDownIcon className={`h-3.5 w-3.5 text-ink-tertiary transition-transform ${collapsed ? "-rotate-90" : ""}`} />
      </button>
      {!collapsed && <div id={`${id}-content`} className="mt-3 space-y-2">
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <div><span className="text-accent">↑ 上行</span><div className="mt-0.5 font-mono text-xs font-semibold text-ink">{upload}</div><div className="mt-1 text-[9px] text-ink-tertiary">累计 {total(metrics?.net_tx_total)}</div></div>
          <div className="text-right"><span className="text-state-success">↓ 下行</span><div className="mt-0.5 font-mono text-xs font-semibold text-ink">{download}</div><div className="mt-1 text-[9px] text-ink-tertiary">累计 {total(metrics?.net_rx_total)}</div></div>
        </div>
        <svg viewBox="0 0 220 68" className="h-20 w-full" role="img" aria-label={`网络速率历史：上行 ${upload}，下行 ${download}`}>
          {[TOP, 34, BASELINE].map((y) => <path key={y} d={`M0 ${y}H${WIDTH}`} className="stroke-line/10" fill="none" />)}
          {(["net_tx_bps", "net_rx_bps"] as const).map((field) => <g key={field} className={field === "net_tx_bps" ? "text-accent" : "text-state-success"}>
            {samples.length > 1 && <polygon points={`${points(field)} ${WIDTH},${BASELINE} ${xFor(samples[0].timestamp_ms)},${BASELINE}`} fill="currentColor" fillOpacity="0.08" />}
            <polyline points={points(field)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
            {samples.length > 0 && <circle cx={xFor(samples[samples.length - 1].timestamp_ms)} cy={yFor(samples[samples.length - 1][field])} r="2.5" fill="currentColor" />}
          </g>)}
        </svg>
        <div className="flex justify-between text-[9px] text-ink-tertiary"><span>{samples.length < 2 ? "等待更多采样" : "最近 3 分钟 · 每 3 秒采样"}</span><span>现在</span></div>
      </div>}
    </section>
  );
}
