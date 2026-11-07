import { useEffect, useId, useMemo, useState } from "react";
import type { HostMetrics } from "../types/ipc";
import { readAvailableMetric, useMonitorStore } from "../stores/monitorStore";
import { resourceSamples } from "../lib/resourceMetrics";
import { ChevronDownIcon, NetworkIcon } from "./ui/icons";

const rate = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, value!) : 0;
const speed = (value: number) => {
  const unit = Math.min(6, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B/s", "KB/s", "MB/s", "GB/s", "TB/s", "PB/s", "EB/s"][unit]}`;
};
const total = (value: number | undefined) => {
  const bytes = rate(value);
  const unit = Math.min(4, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
};

/** 图表横轴展示最近 3 分钟，坐标按真实采样时间推进，数据点随刷新左移形成平滑滚动 */
const WINDOW_MS = 180_000;
const MAX_SAMPLE_GAP_MS = 15_000;
const WIDTH = 200;
const TOP = 2;
const BASELINE = 38;
const FIELDS = ["net_tx_bps", "net_rx_bps"] as const;
type RateField = typeof FIELDS[number];
const readRate = (metrics: HostMetrics | null, field: string) => {
  const value = readAvailableMetric(metrics, field);
  return value !== null && value >= 0 ? value : null;
};

/** At most three number characters, with the unit on its own line in an 18px column. */
const railSpeed = (bps: number | null) => {
  if (bps === null) return { value: "—", unit: "" };
  const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s", "PB/s", "EB/s"];
  let value = bps;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1024; unit += 1; }
  let rounded = unit && value < 10 ? Number(value.toFixed(1)) : Math.round(value);
  if (rounded >= 1000 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
    rounded = Number(value.toFixed(1));
  }
  return { value: unit && rounded < 10 ? rounded.toFixed(1) : String(rounded), unit: units[unit] };
};

/** The chart and both directions share one scale, using actual monitor samples. */
export function NetworkTraffic({ metrics, mode = "sidebar" }: {
  metrics: HostMetrics | null;
  mode?: "sidebar" | "rail" | "dashboard";
}) {
  const history = useMonitorStore((state) => state.history);
  const [collapsed, setCollapsed] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
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
      if (time - last >= 100) {
        last = time;
        setNow(Date.now());
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [collapsed, reducedMotion, mode]);

  const samples = useMemo(() => resourceSamples(metrics, history), [metrics, history]);
  const observedPeak = Math.max(0, ...samples.flatMap((sample) => FIELDS.map((field) => readRate(sample, field) ?? 0)));
  // Rounded shared scale leaves headroom and makes axis labels easy to scan.
  const target = Math.max(1024, observedPeak * 1.12);
  const magnitude = 1024 ** Math.floor(Math.log(target) / Math.log(1024));
  const peak = ([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024].find((step) => step * magnitude >= target) ?? 1024) * magnitude;
  const axisUnit = speed(peak).split(" ")[1];
  const axisDivisor = 1024 ** Math.min(6, Math.floor(Math.log(peak) / Math.log(1024)));
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
      } else {
        const segment = result[result.length - 1];
        if (segment.length && sample.timestamp_ms - segment[segment.length - 1].timestamp_ms > MAX_SAMPLE_GAP_MS) result.push([]);
        result[result.length - 1].push(sample);
      }
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
  const hovered = hoverTime === null || !samples.length ? null : samples.reduce((nearest, sample) =>
    Math.abs(sample.timestamp_ms - hoverTime) < Math.abs(nearest.timestamp_ms - hoverTime) ? sample : nearest);
  const graph = (fields: readonly RateField[], className: string, label: string) => (
    <svg viewBox="0 0 200 40" preserveAspectRatio="none" className={className}
      role="img" aria-label={label}
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (!bounds.width) return;
        const x = Math.max(2, Math.min(198, (event.clientX - bounds.left) / bounds.width * WIDTH));
        setHoverTime(plotTime - (198 - x) / 196 * WINDOW_MS);
      }} onPointerLeave={() => setHoverTime(null)}>
      <defs>
        {fields.map((field) => <linearGradient key={field} id={`${id}-${field}`} x1="0" y1="0" x2="0" y2="1"
          className={field === "net_tx_bps" ? "text-accent" : "text-state-success"}>
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.015" />
        </linearGradient>)}
      </defs>
      {[TOP, 11, 20, 29, BASELINE].map((y) => <path key={y} d={`M2 ${y}H198`} fill="none"
        className="stroke-line/10" strokeDasharray={y === BASELINE ? undefined : "3 4"} vectorEffect="non-scaling-stroke" />)}
      {[2, 67.33, 132.67, 198].map((x) => <path key={x} d={`M${x} ${TOP}V${BASELINE}`} fill="none"
        className="stroke-line/5" vectorEffect="non-scaling-stroke" />)}
      {fields.map((field) => <g key={field} className={field === "net_tx_bps" ? "text-accent" : "text-state-success"}>
        {segments(field).map((segment, index) => <g key={index}>
          {segment.length > 1 && <path data-network-area d={`M${xFor(segment[0].timestamp_ms)} ${BASELINE} L${points(segment, field).replaceAll(" ", " L")} L${xFor(segment[segment.length - 1].timestamp_ms)} ${BASELINE} Z`}
            fill={`url(#${id}-${field})`} />}
          <polyline points={points(segment, field)} fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {segment.length === 1 && <path d={`M${xFor(segment[0].timestamp_ms)} ${yFor(segment[0][field])}h0.01`} stroke="currentColor" strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
        </g>)}
      </g>)}
      {hovered && <path d={`M${xFor(hovered.timestamp_ms)} ${TOP}V${BASELINE}`} className="stroke-ink-tertiary/50"
        strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
    </svg>
  );

  if (mode === "rail") return (
    <div className="relative grid w-[38px] grid-cols-2 gap-x-0.5" aria-label="网络传输速率">
      <span aria-hidden="true" className="pointer-events-none absolute left-1/2 top-4 bottom-0 w-px bg-line/10" />
      {FIELDS.map((field) => {
        const value = field === "net_tx_bps" ? tx : rx;
        const label = field === "net_tx_bps" ? "上行" : "下行";
        const formatted = field === "net_tx_bps" ? upload : download;
        const compact = railSpeed(value);
        const scale = Math.max(peak, tx ?? 0, rx ?? 0);
        return <div key={field} role="meter" aria-label={`${label}速率：${formatted}`}
          aria-valuemin={0} aria-valuemax={scale} aria-valuenow={value ?? undefined} aria-valuetext={formatted}
          title={`${label} ${formatted} · 双向统一刻度上限 ${speed(scale)}`}
          className="flex w-[18px] flex-col items-center gap-1">
          <span aria-hidden="true" className={`text-[10px] leading-3 ${field === "net_tx_bps" ? "text-accent" : "text-state-success"}`}>
            {field === "net_tx_bps" ? "↑" : "↓"}
          </span>
          <div className="flex h-12 w-1.5 flex-col justify-end overflow-hidden rounded-full bg-line/10">
            <div data-network-fill className={`w-full rounded-full transition-[height] duration-300 motion-reduce:transition-none ${field === "net_tx_bps" ? "bg-action" : "bg-state-success"}`}
              style={{ height: `${value === null ? 0 : value / scale * 100}%`, minHeight: value !== null && value > 0 ? "2px" : 0 }} />
          </div>
          <div className="w-full min-w-0 text-center font-mono tabular-nums">
            <div className={`text-[9px] leading-3 ${field === "net_tx_bps" ? "text-accent" : "text-state-success"}`}>{compact.value}</div>
            <div className="text-[8px] leading-3 tracking-[-0.25px] text-ink-tertiary">{compact.unit || "\u00a0"}</div>
          </div>
        </div>;
      })}
    </div>
  );

  const dashboard = mode === "dashboard";
  const speedValue = (label: string) => {
    const [value, unit] = label.split(" ");
    return <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-ink">
      <span className={`${dashboard ? "text-2xl" : "text-xl"} font-semibold leading-tight tracking-tight tabular-nums`}>{value}</span>
      {unit && <span className="text-[11px] font-medium text-ink-tertiary"> {unit}</span>}
    </div>;
  };
  const heading = <><NetworkIcon className="h-3.5 w-3.5 text-accent" />
    <span className="flex-1 text-left">网络传输速率</span></>;

  return (
    <section aria-label="网络仪表盘" className={`min-w-0 rounded-xl border border-line/10 ${dashboard ? "bg-surface p-4" : "bg-surface p-3"}`}>
      {dashboard ? <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
        {heading}<span className={`flex items-center gap-1.5 text-[10px] font-medium ${tx !== null || rx !== null ? "text-state-success" : "text-ink-tertiary"}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{tx !== null || rx !== null ? "实时" : "无数据"}</span>
      </div> : <button type="button" aria-expanded={!collapsed} aria-controls={`${id}-content`}
        onClick={() => setCollapsed((value) => !value)} className="flex w-full items-center gap-1.5 text-xs font-semibold text-ink">
        {heading}<ChevronDownIcon className={`h-3.5 w-3.5 text-ink-tertiary transition-transform motion-reduce:transition-none ${collapsed ? "-rotate-90" : ""}`} />
      </button>}
      {(!collapsed || dashboard) && <div id={`${id}-content`} className="mt-4 space-y-4">
        <div className="grid grid-cols-2 gap-3 divide-x divide-line/10">
          <div className="min-w-0"><span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-accent"><span className="h-0.5 w-3 rounded-full bg-current" />上行</span>{speedValue(upload)}<div className="mt-1.5 text-[10px] text-ink-tertiary">累计 {totalLabel("net_tx_total")}</div></div>
          <div className="min-w-0 pl-3"><span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-state-success"><span className="h-0.5 w-3 rounded-full bg-current" />下行</span>{speedValue(download)}<div className="mt-1.5 text-[10px] text-ink-tertiary">累计 {totalLabel("net_rx_total")}</div></div>
        </div>
        <figure className="space-y-2 border-t border-line/10 pt-3">
          <div className="flex items-center justify-between gap-2 text-[10px] text-ink-tertiary"><span>速率{samples.length ? ` · ${axisUnit}` : ""}</span><span className="tabular-nums">{samples.length > 1 ? `峰值 ${speed(observedPeak)}` : "等待更多采样"}</span></div>
          <div className="relative flex gap-2">
            <div data-network-axis aria-hidden="true" className={`flex w-8 shrink-0 flex-col justify-between py-1 text-right text-[10px] leading-none tabular-nums text-ink-tertiary ${dashboard ? "h-28" : "h-[88px]"}`}>
              {[peak, peak * 3 / 4, peak / 2, peak / 4, 0].map((value) => <span key={value}>{samples.length ? Number((value / axisDivisor).toFixed(2)) : "—"}</span>)}
            </div>
            <div className="relative min-w-0 flex-1">
              {graph(FIELDS, dashboard ? "h-28 w-full" : "h-[88px] w-full", `网络速率历史（最近 3 分钟）：上行 ${upload}，下行 ${download}`)}
              {!samples.length && <div className="absolute inset-0 flex items-center justify-center text-[10px] text-ink-tertiary">等待网络数据</div>}
              {hovered && <div role="tooltip" className="pointer-events-none absolute left-1 top-1 z-10 rounded-md border border-line/10 bg-surface/95 px-2 py-1.5 text-[10px] leading-relaxed shadow-os-sm">
                <div className="font-medium tabular-nums text-ink-secondary">{new Date(hovered.timestamp_ms).toLocaleTimeString("zh-CN", { hour12: false })}</div>
                {FIELDS.map((field) => <div key={field} className={field === "net_tx_bps" ? "text-accent" : "text-state-success"}>
                  {field === "net_tx_bps" ? "上行" : "下行"} {readRate(hovered, field) === null ? "不可用" : speed(readRate(hovered, field)!)}
                </div>)}
              </div>}
            </div>
          </div>
          <figcaption className="ml-10 flex justify-between text-[10px] tabular-nums text-ink-tertiary"><span>{dashboard ? "3 分钟前" : "-3m"}</span><span>{dashboard ? "2 分钟前" : "-2m"}</span><span>{dashboard ? "1 分钟前" : "-1m"}</span><span>现在</span></figcaption>
        </figure>
      </div>}
    </section>
  );
}
