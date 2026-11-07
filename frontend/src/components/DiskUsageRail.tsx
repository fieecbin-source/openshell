import type { HostMetrics } from "../types/ipc";
import { isFieldUnavailable } from "../stores/monitorStore";
import { HardDriveIcon } from "./ui/icons";

/** Two columns per row keep every mounted partition legible inside the 48px rail. */
export function DiskUsageRail({ metrics }: { metrics: HostMetrics }) {
  const disks = isFieldUnavailable(metrics, "disk_mounts") ? [] : metrics.disk_mounts ?? [];
  return (
    <section aria-label="磁盘分区占用" className="flex w-[38px] flex-col items-center gap-1.5">
      <div className="flex items-center gap-1 text-ink-secondary" title="每根柱子代表一个挂载分区，数字为占用百分比">
        <HardDriveIcon className="h-3 w-3" /><span className="text-[8px]">%</span>
      </div>
      {disks.length ? <div className="grid w-full grid-cols-2 gap-x-0.5 gap-y-3">
        {disks.map((disk, index) => {
          const valid = Number.isFinite(disk.use_percent) && disk.use_percent >= 0;
          const value = valid ? Math.min(100, disk.use_percent) : null;
          const label = `D${index + 1}`;
          return <div key={`${disk.filesystem}:${disk.mount_point}:${index}`} role="meter"
            aria-label={`${disk.mount_point || label} 磁盘占用`} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={value ?? undefined} aria-valuetext={value === null ? "不可用" : `${value.toFixed(0)}%`}
            title={`${label} · ${disk.mount_point || "未知挂载点"} · ${disk.filesystem || "未知设备"} · ${value === null ? "占用不可用" : `${value.toFixed(0)}%`}`}
            className="flex w-[18px] flex-col items-center gap-1">
            <span className="font-mono text-[8px] leading-3 text-ink-tertiary">{label}</span>
            <div className="flex h-12 w-1.5 flex-col justify-end overflow-hidden rounded-full bg-line/10">
              <div data-disk-fill className={`w-full rounded-full transition-[height] duration-300 motion-reduce:transition-none ${value !== null && value > 85 ? "bg-state-danger" : "bg-state-warning"}`}
                style={{ height: `${value ?? 0}%` }} />
            </div>
            <span className="font-mono text-[9px] leading-3 tabular-nums text-ink-secondary">{value === null ? "—" : value.toFixed(0)}</span>
          </div>;
        })}
      </div> : <span className="text-[10px] text-ink-tertiary" title="磁盘占用不可用">—</span>}
    </section>
  );
}
