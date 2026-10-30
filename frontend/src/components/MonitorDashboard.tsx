import React, { useEffect, useState } from "react";
import { useMonitorStore } from "../stores/monitorStore";
import type { ProcessMetrics } from "../types/ipc";
import { formatFriendlyError } from "../lib/errors";

/** 与工作区共享浅色玻璃材质和语义状态色。 */
const C = {
  page: "workspace-background",
  panel: "liquid-glass-card border border-line/15",
  sub: "bg-surface-muted/70 border border-line/15",
  header: "liquid-glass-chrome border-b border-line/15",
  ink: "text-ink",
  inkDim: "text-ink-secondary",
  inkFaint: "text-ink-tertiary",
} as const;

interface MonitorDashboardProps {
  connId: string;
  sessionId: string;
  onClose: () => void;
}

export const MonitorDashboard: React.FC<MonitorDashboardProps> = ({
  connId,
  sessionId,
  onClose,
}) => {
  const {
    start,
    stop,
    latest,
    history,
    kill,
    filterProcess,
    setFilterProcess,
    error,
  } = useMonitorStore();

  const [killModal, setKillModal] = useState<ProcessMetrics | null>(null);
  const [killSignal, setKillSignal] = useState<number>(15);
  const [killing, setKilling] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);

  useEffect(() => {
    start(sessionId, connId);
    return () => {
      stop();
    };
  }, [sessionId, connId]);

  // Esc 返回终端：全屏面板没有任何「外面的东西」可点，必须给键盘出口。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 结束进程弹窗打开时，Esc 先关弹窗，避免误退大屏
      if (killModal) {
        event.stopPropagation();
        setKillModal(null);
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [killModal, onClose]);

  const formatBytes = (raw: number) => {
    const bytes = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    if (bytes <= 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const formatBps = (bps: number) => {
    return formatBytes(bps) + "/s";
  };

  const formatUptime = (sec: number) => {
    if (!sec) return "-";
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    if (days > 0) return `${days}天 ${hours}小时 ${mins}分`;
    if (hours > 0) return `${hours}小时 ${mins}分`;
    return `${mins}分钟`;
  };

  const filteredProcesses = (latest?.top_processes || []).filter((p) => {
    if (!filterProcess) return true;
    const q = filterProcess.toLowerCase();
    return (
      (p.command || "").toLowerCase().includes(q) ||
      (p.name || "").toLowerCase().includes(q) ||
      (p.user || "").toLowerCase().includes(q) ||
      String(p.pid ?? "").includes(q)
    );
  });

  // 简易 SVG 历史趋势折线图
  const renderHistoryChart = (
    data: number[],
    color: string,
    maxVal = 100,
    height = 40
  ) => {
    if (data.length < 2) {
      return (
        <div className={`h-10 flex items-center justify-center text-[10px] ${C.inkFaint}`}>
          采集中...
        </div>
      );
    }
    const width = 200;
    const points = data.map((val, idx) => {
      const x = (idx / (data.length - 1)) * width;
      const y = height - (Math.min(val, maxVal) / maxVal) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return (
      <svg className="w-full h-10 overflow-visible" viewBox={`0 0 ${width} ${height}`}>
        <polyline
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          points={points.join(" ")}
        />
      </svg>
    );
  };

  const cpuHistory = history.map((h) => h.cpu_percent);
  const memHistory = history.map((h) =>
    h.memory_total_bytes > 0
      ? (h.memory_used_bytes / h.memory_total_bytes) * 100
      : 0
  );

  return (
    <div className={`absolute inset-0 z-40 flex flex-col overflow-hidden ${C.page} ${C.ink}`}>
      {/* 顶部标题栏 */}
      <div className={`h-14 shrink-0 px-6 flex items-center justify-between ${C.header}`}>
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <h3 className="text-sm font-bold text-ink whitespace-nowrap">服务器实时监控</h3>
          {latest && (
            <span className={`text-xs ${C.inkDim} font-mono bg-line/5 border border-line/10 px-2 py-0.5 rounded-md whitespace-nowrap`}>
              运行时长 {formatUptime(latest.uptime_seconds)}
            </span>
          )}
        </div>

        {/* 退出出口：整块面板盖住了工作区，必须给一个显眼、带文字的返回按钮 */}
        <div className="flex items-center gap-3 shrink-0">
          <span className={`hidden sm:inline text-[11px] ${C.inkFaint}`}>
            按 <kbd className="px-1 py-0.5 rounded border border-line/20 bg-line/5 font-mono text-[10px] text-ink-secondary">Esc</kbd> 返回
          </span>
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-secondary bg-line/10 border border-line/15 hover:bg-line/20 hover:border-line/25 transition"
            title="返回终端 (Esc)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            返回终端
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {error && (
          <div className="p-3 bg-red-500/15 border border-red-400/40 rounded-xl text-xs text-state-danger flex items-center gap-2">
            <span>⚠️</span>
            <span>{error}</span>
          </div>
        )}

        {/* 指标卡片网格 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* CPU 卡片 */}
          <div className={`${C.panel} rounded-xl p-4 shadow-lg shadow-black/30`}>
            <div className="flex items-center justify-between mb-2">
              <span className={`text-xs font-medium ${C.inkDim}`}>CPU 使用率</span>
              <span className="text-lg font-bold text-state-success font-mono">
                {latest ? `${Number(latest.cpu_percent || 0).toFixed(1)}%` : "-"}
              </span>
            </div>
            {renderHistoryChart(cpuHistory, "#34d399")}
            {latest?.cpu_cores && latest.cpu_cores.length > 0 && (
              <div className="mt-3 pt-3 border-t border-line/10">
                <div className={`text-[10px] ${C.inkFaint} mb-1.5`}>
                  {latest.cpu_cores.length} 核心负载
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {latest.cpu_cores.slice(0, 8).map((core, idx) => (
                    <div key={idx} className={`${C.sub} rounded p-1 text-center`}>
                      <div className={`text-[9px] ${C.inkFaint} font-mono`}>C{idx}</div>
                      <div className={`text-[10px] font-mono ${C.ink}`}>
                        {Number(core || 0).toFixed(0)}%
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 内存卡片 */}
          <div className={`${C.panel} rounded-xl p-4 shadow-lg shadow-black/30`}>
            <div className="flex items-center justify-between mb-2">
              <span className={`text-xs font-medium ${C.inkDim}`}>物理内存</span>
              <span className="text-lg font-bold text-accent font-mono">
                {latest && latest.memory_total_bytes > 0
                  ? `${((latest.memory_used_bytes / latest.memory_total_bytes) * 100).toFixed(1)}%`
                  : "-"}
              </span>
            </div>
            {renderHistoryChart(memHistory, "#60a5fa")}
            {latest && (
              <div className="mt-3 pt-3 border-t border-line/10 text-xs space-y-1">
                <div className={`flex justify-between ${C.inkDim} text-[11px]`}>
                  <span>已用</span>
                  <span className={`font-mono ${C.ink}`}>{formatBytes(latest.memory_used_bytes)}</span>
                </div>
                <div className={`flex justify-between ${C.inkDim} text-[11px]`}>
                  <span>缓存</span>
                  <span className={`font-mono ${C.ink}`}>{formatBytes(latest.memory_cached_bytes)}</span>
                </div>
                <div className={`flex justify-between ${C.inkDim} text-[11px]`}>
                  <span>总计</span>
                  <span className={`font-mono ${C.ink}`}>{formatBytes(latest.memory_total_bytes)}</span>
                </div>
              </div>
            )}
          </div>

          {/* 网络卡片 */}
          <div className={`${C.panel} rounded-xl p-4 shadow-lg shadow-black/30`}>
            <div className="flex items-center justify-between mb-2">
              <span className={`text-xs font-medium ${C.inkDim}`}>网络吞吐</span>
              <span className={`text-[10px] ${C.inkFaint} font-mono`}>实时</span>
            </div>
            <div className="space-y-3 py-2">
              <div>
                <div className="flex justify-between text-[11px] mb-1">
                  <span className={C.inkDim}>接收 RX</span>
                  <span className="font-mono text-state-success font-semibold">
                    {latest ? formatBps(latest.net_rx_bps) : "-"}
                  </span>
                </div>
                <div className={`text-[10px] ${C.inkFaint} font-mono text-right`}>
                  累计 {latest ? formatBytes(latest.net_rx_total) : "-"}
                </div>
              </div>

              <div>
                <div className="flex justify-between text-[11px] mb-1">
                  <span className={C.inkDim}>发送 TX</span>
                  <span className="font-mono text-accent font-semibold">
                    {latest ? formatBps(latest.net_tx_bps) : "-"}
                  </span>
                </div>
                <div className={`text-[10px] ${C.inkFaint} font-mono text-right`}>
                  累计 {latest ? formatBytes(latest.net_tx_total) : "-"}
                </div>
              </div>
            </div>
          </div>

          {/* 系统负载卡片 */}
          <div className={`${C.panel} rounded-xl p-4 shadow-lg shadow-black/30`}>
            <div className="flex items-center justify-between mb-2">
              <span className={`text-xs font-medium ${C.inkDim}`}>平均负载</span>
              <span className={`text-[10px] ${C.inkFaint} font-mono`}>1 / 5 / 15m</span>
            </div>
            {latest && (
              <div className="grid grid-cols-3 gap-2 py-4">
                {[
                  { label: "1 分钟", value: latest.load_1 },
                  { label: "5 分钟", value: latest.load_5 },
                  { label: "15 分钟", value: latest.load_15 },
                ].map((item) => (
                  <div key={item.label} className={`${C.sub} rounded-lg p-2 text-center`}>
                    <div className={`text-[10px] ${C.inkFaint}`}>{item.label}</div>
                    <div className="text-base font-bold text-ink font-mono mt-0.5">
                      {Number(item.value || 0).toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 磁盘挂载点使用情况 */}
        {latest?.disk_mounts && latest.disk_mounts.length > 0 && (
          <div className={`${C.panel} rounded-xl p-4 shadow-lg shadow-black/30`}>
            <h4 className={`text-xs font-bold ${C.ink} mb-3 flex items-center gap-1.5`}>
              <svg className="w-4 h-4 text-state-warning" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
              </svg>
              <span>磁盘存储分区</span>
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {latest.disk_mounts.map((mount, idx) => {
                const usePct = Math.min(100, Number(mount.use_percent || 0));
                return (
                  <div key={`${mount.mount_point || idx}`} className={`${C.sub} rounded-lg p-3`}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className={`font-mono text-xs font-semibold ${C.ink} truncate`}>
                        {mount.mount_point || "-"}
                      </span>
                      <span className={`text-[10px] font-mono ${C.inkDim}`}>
                        {usePct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="w-full bg-line/10 rounded-full h-1.5 overflow-hidden mb-2">
                      <div
                        className={`h-full rounded-full ${
                          usePct > 85
                            ? "bg-red-400"
                            : usePct > 70
                            ? "bg-amber-400"
                            : "bg-emerald-400"
                        }`}
                        style={{ width: `${usePct}%` }}
                      />
                    </div>
                    <div className={`flex justify-between text-[10px] ${C.inkFaint} font-mono`}>
                      <span>已用 {formatBytes(mount.used_bytes)}</span>
                      <span>可用 {formatBytes(mount.available_bytes)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Top 进程列表与 Kill */}
        <div className={`${C.panel} rounded-xl p-4 shadow-lg shadow-black/30 flex flex-col`}>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <h4 className={`text-xs font-bold ${C.ink}`}>Top 活跃进程</h4>
              <span className={`text-[10px] ${C.inkFaint} font-mono`}>
                共 {filteredProcesses.length} 个
              </span>
            </div>

            <div className="w-full sm:w-64">
              <input
                type="text"
                placeholder="搜索进程名 / 用户 / PID..."
                value={filterProcess}
                onChange={(e) => setFilterProcess(e.target.value)}
                className={`w-full px-3 py-1.5 ${C.sub} rounded-lg text-xs text-ink placeholder-[#6f829e] outline-none focus:border-emerald-400/70`}
              />
            </div>
          </div>

          <div className="overflow-x-auto border border-line/15 rounded-lg">
            <table className="w-full text-left text-xs font-mono">
              <thead className={`${C.sub} ${C.inkDim} text-[11px]`}>
                <tr>
                  <th className="py-2 px-3 font-semibold">PID</th>
                  <th className="py-2 px-3 font-semibold">USER</th>
                  <th className="py-2 px-3 font-semibold">CPU %</th>
                  <th className="py-2 px-3 font-semibold">MEM %</th>
                  <th className="py-2 px-3 font-semibold">COMMAND</th>
                  <th className="py-2 px-3 font-semibold text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/[0.06] text-ink-secondary">
                {filteredProcesses.length === 0 ? (
                  <tr>
                    <td colSpan={6} className={`py-8 text-center ${C.inkDim} font-sans`}>
                      未找到匹配进程
                    </td>
                  </tr>
                ) : (
                  filteredProcesses.map((p, idx) => (
                    <tr key={`${p.pid}-${idx}`} className="hover:bg-line/[0.04] transition">
                      <td className="py-2 px-3 text-state-success font-semibold">{p.pid}</td>
                      <td className={`py-2 px-3 ${C.inkDim}`}>{p.user || "-"}</td>
                      <td className={`py-2 px-3 font-semibold ${C.ink}`}>
                        {Number(p.cpu_percent || 0).toFixed(1)}%
                      </td>
                      <td className="py-2 px-3 text-ink-secondary">
                        {Number(p.memory_percent || 0).toFixed(1)}%
                      </td>
                      <td
                        className="py-2 px-3 font-semibold text-ink truncate max-w-xs"
                        title={p.command || p.name}
                      >
                        {p.command || p.name || "-"}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <button
                          onClick={() => {
                            setKillError(null);
                            setKillModal(p);
                            setKillSignal(15);
                          }}
                          className="px-2 py-0.5 rounded bg-red-500/15 hover:bg-red-500/25 text-state-danger border border-red-400/30 text-[10px] font-sans font-medium transition"
                        >
                          终止
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 结束进程确认弹窗 */}
      {killModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/65 p-4">
          <div className="w-96 bg-surface border border-line/15 rounded-xl p-5 shadow-2xl">
            <h4 className="text-sm font-bold text-ink mb-2">结束远端进程</h4>
            <p className={`text-xs ${C.inkDim} mb-4`}>
              确定要终止进程{" "}
              <span className="font-mono text-state-success font-bold">{killModal.command}</span>{" "}
              (PID: {killModal.pid}) 吗？
            </p>

            <div className="space-y-2 mb-5">
              <label className={`flex items-center gap-2 text-xs ${C.ink} cursor-pointer`}>
                <input
                  type="radio"
                  name="signal"
                  checked={killSignal === 15}
                  onChange={() => setKillSignal(15)}
                />
                <span>SIGTERM (15 - 正常终止，推荐)</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-state-danger cursor-pointer">
                <input
                  type="radio"
                  name="signal"
                  checked={killSignal === 9}
                  onChange={() => setKillSignal(9)}
                />
                <span>SIGKILL (9 - 强制杀死)</span>
              </label>
              {killError && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-[11px] font-medium leading-relaxed text-state-danger"
                >
                  {killError}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setKillModal(null)}
                disabled={killing}
                className="px-3 py-1.5 bg-line/10 text-ink-secondary rounded-lg text-xs hover:bg-line/20 transition"
              >
                取消
              </button>
              <button
                disabled={killing}
                onClick={async () => {
                  setKilling(true);
                  setKillError(null);
                  try {
                    await kill(killModal.pid, killSignal);
                    setKillModal(null);
                  } catch (e) {
                    // 不再用 alert 弹原始技术错误，改为面板内可读提示
                    setKillError(formatFriendlyError(e));
                  } finally {
                    setKilling(false);
                  }
                }}
                className="px-3 py-1.5 bg-danger-action hover:bg-danger-action/90 text-white font-medium rounded-lg text-xs shadow-sm transition"
              >
                {killing ? "终止中..." : "确认终止"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
