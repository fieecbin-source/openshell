import React, { useEffect, useState } from "react";
import type { TerminalTab } from "../stores/terminalStore";
import { useMonitorStore } from "../stores/monitorStore";
import { sshExec } from "../lib/ipc";
import { useContainerStore } from "../stores/containerStore";

interface ServerSidebarProps {
  tab: TerminalTab;
  /** 打开大屏监控面板（概览页入口，替代原顶栏的「服务器监控」按钮） */
  onOpenMonitor?: () => void;
  /** 进入画布级容器工作区（点击容器后终端让位给容器界面），可带上要聚焦的容器 id */
  onOpenContainer?: (containerId?: string) => void;
}

/**
 * 后端指标字段可能因为采集失败 / 老服务端缺字段而为 undefined，
 * 直接 `undefined.toFixed()` 会抛异常并让整个 React 树卸载（终端连接随之中断）。
 * 所有数值渲染统一走这里兜底。
 */
const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const fixed = (value: unknown, digits = 1): string => num(value).toFixed(digits);

export const ServerSidebar: React.FC<ServerSidebarProps> = ({ tab, onOpenMonitor, onOpenContainer }) => {
  const { connId, sessionId } = { connId: tab.connectionId, sessionId: tab.sessionId };
  const {
    latest,
    start,
    stop,
    poll,
    kill,
  } = useMonitorStore();

  /** 采样任务可能因断线/异常被停掉，切到进程页时自愈重启 */
  const ensureMonitoring = () => {
    const st = useMonitorStore.getState();
    if (!st.isMonitoring && sessionId && connId) void st.start(sessionId, connId);
  };

  // 第 2 个标签展示的是监听端口而不是网络流量，直接叫「端口」，避免误导
  const [activeTab, setActiveTab] = useState<"overview" | "ports" | "processes" | "containers">("overview");
  const [collapsed, setCollapsed] = useState(false);

  // 容器数据与画布级容器工作区共用同一个 store，避免两处各自探测
  const containers = useContainerStore((s) => s.containers);
  const containerRuntime = useContainerStore((s) => s.runtime);
  const containerError = useContainerStore((s) => s.error);
  const containersLoading = useContainerStore((s) => s.loading);
  const containerProbed = useContainerStore((s) => s.probed);
  const probeContainers = useContainerStore((s) => s.probe);
  const loadContainers = useContainerStore((s) => s.reload);
  const hasDocker = containerProbed ? containerRuntime !== "" : null;

  // 监听端口列表
  const [listeningPorts, setListeningPorts] = useState<{ proto: string; port: string; process: string }[]>([]);
  const [portsLoading, setPortsLoading] = useState(false);

  // 进程终止确认状态
  const [killPid, setKillPid] = useState<number | null>(null);

  // 周期轮询监控与后台采集
  useEffect(() => {
    if (!sessionId || !connId) return;

    start(sessionId, connId);

    return () => {
      stop();
    };
  }, [sessionId, connId]);

  /** connId 可能为 null（未连接），统一收口 */
  const probeDocker = () => {
    if (connId) void probeContainers(connId);
  };

  // 探测 Docker / Podman（结果进 store，画布级容器工作区复用同一份）
  useEffect(() => {
    probeDocker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, probeContainers]);

  const loadListeningPorts = async () => {
    if (!connId) return;
    setPortsLoading(true);
    try {
      // 读取 TCP 监听端口
      const res = await sshExec(connId, "ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null");
      // 同容器列表：以是否有输出为准，避免 exit_code 丢失（null）导致永远扫不到端口
      if (res.stdout) {
        const lines = res.stdout.split("\n");
        const ports: { proto: string; port: string; process: string }[] = [];
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 4 && (parts[0].startsWith("tcp") || parts[0].startsWith("udp"))) {
            const addr = parts[4] || "";
            const lastColon = addr.lastIndexOf(":");
            if (lastColon > -1) {
              const portNum = addr.substring(lastColon + 1);
              const proc = parts.slice(6).join(" ") || "-";
              ports.push({ proto: parts[0].toUpperCase(), port: portNum, process: proc });
            }
          }
        }
        setListeningPorts(ports.slice(0, 30));
      }
    } catch (e) {
      console.warn("loadListeningPorts failed", e);
    } finally {
      setPortsLoading(false);
    }
  };

  const metrics = latest;
  const hasProcesses = (metrics?.top_processes?.length ?? 0) > 0;

  /**
   * 进程页自动补拉。
   *
   * 远端 `ps` 往往比 CPU/内存采样慢，第一帧快照里可能还没有进程；
   * 这里在进程页停留期间自动重试，用户不需要手动点「重新采集」。
   */
  useEffect(() => {
    if (activeTab !== "processes" || !connId) return;
    ensureMonitoring();
    void poll();
    if (hasProcesses) return;

    const timer = window.setInterval(() => {
      ensureMonitoring();
      void poll();
    }, 1200);
    const stopAt = window.setTimeout(() => window.clearInterval(timer), 12000);

    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stopAt);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, connId, sessionId, hasProcesses]);

  const formatBytes = (raw: number) => {
    const bytes = num(raw);
    if (bytes <= 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const formatSpeed = (raw: number) => {
    const bytesPerSec = num(raw);
    if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  };

  const formatUptime = (sec: number) => {
    if (sec <= 0) return "-";
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    if (days > 0) return `${days}天 ${hours}小时`;
    if (hours > 0) return `${hours}小时 ${mins}分`;
    return `${mins}分钟`;
  };

  const cpuPct = Math.round(num(metrics?.cpu_percent));
  const memTotal = num(metrics?.memory_total_bytes) || 1;
  const memUsed = num(metrics?.memory_used_bytes);
  const memPct = Math.min(100, Math.round((memUsed / memTotal) * 100));

  // 折叠状态显示胶囊小侧边
  if (collapsed) {
    return (
      <aside className="w-11 shrink-0 bg-surface-muted border-r border-line/15 flex flex-col items-center py-3 select-none transition-all duration-200">
        <button
          onClick={() => setCollapsed(false)}
          className="p-1 rounded-lg text-ink-secondary hover:text-ink hover:bg-line/10 transition mb-4"
          title="展开服务器状态侧边栏"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
          </svg>
        </button>

        {/* 极简指示器胶囊 */}
        <div className="flex flex-col gap-4 text-center">
          <div
            className="flex flex-col items-center cursor-pointer group"
            onClick={() => {
              setCollapsed(false);
              setActiveTab("overview");
            }}
            title={`CPU 使用率: ${cpuPct}%`}
          >
            <span className="text-[10px] text-ink-secondary font-bold mb-1">CPU</span>
            <div className="w-2 h-14 bg-line/10 rounded-full overflow-hidden flex flex-col justify-end">
              <div
                className={`w-full rounded-full transition-all duration-500 ${
                  cpuPct > 80 ? "bg-state-danger/100" : cpuPct > 60 ? "bg-state-warning/100" : "bg-action"
                }`}
                style={{ height: `${Math.min(cpuPct, 100)}%` }}
              />
            </div>
            <span className="text-[9px] font-mono text-ink-secondary mt-1">{cpuPct}%</span>
          </div>

          <div
            className="flex flex-col items-center cursor-pointer group"
            onClick={() => {
              setCollapsed(false);
              setActiveTab("overview");
            }}
            title={`内存占用: ${memPct}%`}
          >
            <span className="text-[10px] text-ink-secondary font-bold mb-1">MEM</span>
            <div className="w-2 h-14 bg-line/10 rounded-full overflow-hidden flex flex-col justify-end">
              <div
                className={`w-full rounded-full transition-all duration-500 ${
                  memPct > 80 ? "bg-state-danger/100" : memPct > 60 ? "bg-state-warning/100" : "bg-state-success/100"
                }`}
                style={{ height: `${Math.min(memPct, 100)}%` }}
              />
            </div>
            <span className="text-[9px] font-mono text-ink-secondary mt-1">{memPct}%</span>
          </div>

          {hasDocker && (
            <button
              onClick={() => {
                setCollapsed(false);
                setActiveTab("containers");
              }}
              className="p-1 rounded-lg text-ink-secondary hover:text-accent hover:bg-line/10 transition mt-2"
              title="容器管理"
            >
              🐳
            </button>
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-64 shrink-0 bg-surface/70 backdrop-blur-xl border-r border-line/10 flex flex-col select-none overflow-hidden h-full text-ink">
      {/* 顶部服务器概览头 */}
      <div className="p-3 border-b border-line/10 bg-surface/80 backdrop-blur-md">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5 overflow-hidden">
            <span className="h-2 w-2 rounded-full bg-state-success shrink-0 shadow-apple-sm animate-pulse" />
            <h3 className="text-xs font-bold text-ink truncate" title={tab.sessionName}>
              {tab.sessionName}
            </h3>
          </div>
          <div className="flex items-center gap-0.5">
            {onOpenMonitor && (
              <button
                onClick={onOpenMonitor}
                className="flex items-center gap-0.5 rounded-lg border border-accent/30 bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent hover:bg-accent/25 transition"
                title="打开全屏服务器监控大屏"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16M4 10h16M4 14h10M4 18h6"
                  />
                </svg>
              </button>
            )}
            <button
              onClick={() => setCollapsed(true)}
              className="p-1 rounded-lg text-ink-secondary hover:text-ink hover:bg-line/10 transition"
              title="收起为迷你胶囊"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              </svg>
            </button>
          </div>
        </div>

        {/* 基础运行信息 */}
        <div className="grid grid-cols-2 gap-1 text-[10px] text-ink-secondary font-mono">
          <div>
            <span className="text-ink-secondary">运行: </span>
            <span className="text-ink font-semibold">{formatUptime(metrics?.uptime_seconds || 0)}</span>
          </div>
          <div className="text-right">
            <span className="text-ink-secondary">负载: </span>
            <span className="text-ink font-semibold">
              {metrics ? `${num(metrics.load_1).toFixed(1)}, ${num(metrics.load_5).toFixed(1)}` : "-"}
            </span>
          </div>
        </div>
      </div>

      {/* 4 选项卡导航 (Apple Segmented Tabs) */}
      <div className="flex p-1 bg-surface/50 border-b border-line/10 text-[11px] font-medium gap-0.5">
        <button
          onClick={() => setActiveTab("overview")}
          className={`flex-1 py-1 rounded-md transition text-center ${
            activeTab === "overview" ? "bg-line/15 text-accent font-bold shadow-apple-sm" : "text-ink-secondary hover:text-ink"
          }`}
        >
          概览
        </button>
        <button
          onClick={() => {
            setActiveTab("ports");
            loadListeningPorts();
          }}
          className={`flex-1 py-1 rounded-md transition text-center ${
            activeTab === "ports" ? "bg-line/15 text-accent font-bold shadow-apple-sm" : "text-ink-secondary hover:text-ink"
          }`}
          title="查看服务器正在监听的 TCP/UDP 端口"
        >
          端口
        </button>
        <button
          onClick={() => {
            setActiveTab("processes");
            // 进入进程页立刻拉一次，并确保采样任务在跑
            ensureMonitoring();
            void poll();
          }}
          className={`flex-1 py-1 rounded-md transition text-center ${
            activeTab === "processes" ? "bg-line/15 text-accent font-bold shadow-apple-sm" : "text-ink-secondary hover:text-ink"
          }`}
        >
          进程
        </button>
        <button
          onClick={() => {
            setActiveTab("containers");
            probeDocker();
          }}
          className={`flex-1 py-1 rounded-md transition text-center flex items-center justify-center gap-0.5 ${
            activeTab === "containers" ? "bg-line/15 text-accent font-bold shadow-apple-sm" : "text-ink-secondary hover:text-ink"
          }`}
        >
          <span>容器</span>
          {containers.length > 0 && (
            <span className="text-[9px] bg-action/10 text-accent px-1 rounded-full font-bold">
              {containers.length}
            </span>
          )}
        </button>
      </div>

      {/* 面板内容主体 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3.5">
        {/* ================= Tab 1: 概览资源监控 ================= */}
        {activeTab === "overview" && (
          <div className="space-y-3 text-xs">
            {/* CPU 进度卡片 */}
            <div className="p-2.5 rounded-xl border border-line/10 bg-surface/70 backdrop-blur-md shadow-apple-sm space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-ink font-semibold flex items-center gap-1.5">
                  <span className="text-accent">⚡</span>
                  <span>CPU 占用</span>
                </span>
                <span className="font-mono font-bold text-ink">{cpuPct}%</span>
              </div>
              <div className="w-full bg-line/10 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    cpuPct > 80 ? "bg-state-danger/100" : cpuPct > 60 ? "bg-state-warning/100" : "bg-action"
                  }`}
                  style={{ width: `${Math.min(cpuPct, 100)}%` }}
                />
              </div>
              {metrics?.cpu_cores && metrics.cpu_cores.length > 1 && (
                <div className="text-[9px] text-ink-secondary font-mono text-right">
                  {metrics.cpu_cores.length} 核心
                </div>
              )}
            </div>

            {/* 内存已用/总计卡片 */}
            <div className="p-2.5 rounded-xl border border-line/10 bg-surface/70 backdrop-blur-md shadow-apple-sm space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-ink font-semibold flex items-center gap-1.5">
                  <span className="text-state-success">🧠</span>
                  <span>内存占用</span>
                </span>
                <span className="font-mono font-bold text-ink">{memPct}%</span>
              </div>
              <div className="w-full bg-line/10 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    memPct > 85 ? "bg-state-danger/100" : memPct > 70 ? "bg-state-warning/100" : "bg-state-success/100"
                  }`}
                  style={{ width: `${Math.min(memPct, 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono text-ink-secondary">
                <span>已用: {formatBytes(memUsed)}</span>
                <span>总量: {formatBytes(memTotal)}</span>
              </div>
            </div>

            {/* 实时网络流量 */}
            <div className="p-2.5 rounded-xl border border-line/10 bg-surface/70 backdrop-blur-md shadow-apple-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-ink font-semibold flex items-center gap-1.5">
                  <span className="text-accent">🌐</span>
                  <span>网络传输速率</span>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="bg-surface/50 p-1.5 rounded-lg border border-line/10">
                  <span className="text-[10px] text-ink-secondary block">↑ 上行 (Tx)</span>
                  <span className="text-xs font-mono font-bold text-accent block mt-0.5">
                    {formatSpeed(metrics?.net_tx_bps || 0)}
                  </span>
                  <span className="text-[9px] font-mono text-ink-secondary block mt-0.5">
                    累计: {formatBytes(metrics?.net_tx_total || 0)}
                  </span>
                </div>
                <div className="bg-surface/50 p-1.5 rounded-lg border border-line/10">
                  <span className="text-[10px] text-ink-secondary block">↓ 下行 (Rx)</span>
                  <span className="text-xs font-mono font-bold text-state-success block mt-0.5">
                    {formatSpeed(metrics?.net_rx_bps || 0)}
                  </span>
                  <span className="text-[9px] font-mono text-ink-secondary block mt-0.5">
                    累计: {formatBytes(metrics?.net_rx_total || 0)}
                  </span>
                </div>
              </div>
            </div>

            {/* 磁盘空间 */}
            {metrics?.disk_mounts && metrics.disk_mounts.length > 0 && (
              <div className="p-2.5 rounded-xl border border-line/10 bg-surface/70 backdrop-blur-md shadow-apple-sm space-y-2">
                <span className="text-ink font-semibold flex items-center gap-1.5">
                  <span className="text-state-warning">💾</span>
                  <span>磁盘空间</span>
                </span>
                <div className="space-y-2">
                  {metrics.disk_mounts.slice(0, 3).map((d, i) => {
                    const usePct = Math.min(100, num(d.use_percent));
                    return (
                      <div key={`${d.mount_point || i}`} className="space-y-1">
                        <div className="flex items-center justify-between text-[10px] font-mono">
                          <span className="text-ink-secondary font-semibold truncate max-w-[120px]">
                            {d.mount_point || "-"}
                          </span>
                          <span className="text-ink-secondary">
                            {formatBytes(d.used_bytes)} / {formatBytes(d.total_bytes)} ({fixed(usePct, 0)}%)
                          </span>
                        </div>
                        <div className="w-full bg-line/5 rounded-full h-1.5 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${usePct > 85 ? "bg-state-danger/100" : "bg-state-warning/100"}`}
                            style={{ width: `${usePct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ================= Tab 2: 端口监听 ================= */}
        {activeTab === "ports" && (
          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-ink-secondary">监听端口列表 (TCP / UDP)</span>
              <button
                onClick={loadListeningPorts}
                className="text-[10px] text-accent hover:underline"
              >
                {portsLoading ? "刷新中..." : "刷新"}
              </button>
            </div>
            {listeningPorts.length === 0 ? (
              <div className="text-center py-6 text-ink-secondary text-xs">
                {portsLoading ? "正在扫描监听端口..." : "暂无监听端口信息或权限不足"}
              </div>
            ) : (
              <div className="space-y-1.5">
                {listeningPorts.map((p, idx) => (
                  <div
                    key={idx}
                    className="p-2 rounded-lg border border-line/15 bg-surface flex items-center justify-between font-mono text-[11px]"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="rounded bg-accent/10 text-accent px-1 py-0.2 text-[9px] font-bold">
                        {p.proto}
                      </span>
                      <span className="font-bold text-ink">:{p.port}</span>
                    </div>
                    <span className="text-ink-secondary text-[10px] truncate max-w-[110px]" title={p.process}>
                      {p.process}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ================= Tab 3: 进程管理 ================= */}
        {activeTab === "processes" && (
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between text-ink-secondary text-[11px]">
              <span>Top 进程 (按 CPU/内存占用)</span>
              <span>PID / 占用</span>
            </div>
            {(!metrics?.top_processes || metrics.top_processes.length === 0) ? (
              <div className="py-6 text-center text-xs text-ink-secondary space-y-2">
                <p className="flex items-center justify-center gap-1.5">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-line/25 border-t-accent" />
                  正在采集进程信息...
                </p>
                <p className="px-2 text-[10px] leading-relaxed text-ink-secondary">
                  远端 ps 较慢时会多等几秒；若长时间为空，可能是远端 ps 命令受限（BusyBox / 精简镜像）。
                </p>
                <button
                  onClick={() => {
                    ensureMonitoring();
                    void poll();
                  }}
                  className="rounded-md border border-line/25 bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-secondary hover:bg-line/5"
                >
                  立即重新采集
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                {metrics.top_processes.slice(0, 15).map((proc, idx) => (
                  <div
                    key={`${proc.pid}-${idx}`}
                    className="p-2 rounded-xl border border-line/15 bg-surface flex items-center justify-between gap-1 shadow-apple-sm font-mono text-[11px]"
                  >
                    <div className="truncate flex-1">
                      <div
                        className="font-semibold text-ink truncate"
                        title={proc.command || proc.name}
                      >
                        {proc.command || proc.name || "(unknown)"}
                      </div>
                      <div className="text-[10px] text-ink-secondary">
                        PID: {proc.pid} · {proc.user || "-"}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-accent font-bold text-[10px]">
                        CPU {fixed(proc.cpu_percent)}%
                      </div>
                      <div className="text-ink-secondary text-[9px]">
                        MEM {fixed(proc.memory_percent)}%
                      </div>
                    </div>
                    <button
                      onClick={() => setKillPid(proc.pid)}
                      className="ml-1 p-1 rounded text-ink-secondary hover:text-state-danger hover:bg-state-danger/10 transition"
                      title="终止该进程"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ================= Tab 4: 容器管理 (Docker / Podman) ================= */}
        {activeTab === "containers" && (
          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-ink-secondary flex items-center gap-1">
                <span>🐳 Docker / Podman 容器</span>
                {containerRuntime && (
                  <span className="font-mono text-[9px] font-normal text-ink-secondary">
                    {containerRuntime.split("/").pop()}
                  </span>
                )}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => (containerRuntime ? loadContainers() : probeDocker())}
                  className="text-[10px] text-accent hover:underline"
                >
                  {containersLoading ? "刷新中..." : "刷新"}
                </button>
                <button
                  onClick={() => onOpenContainer?.()}
                  className="text-[10px] font-semibold text-accent hover:underline"
                  title="在画布中打开容器工作区（终端让位）"
                >
                  打开工作区 ↗
                </button>
              </div>
            </div>

            {containerError && (
              <div className="p-3 rounded-xl border border-state-danger/30 bg-state-danger/10 text-[10px] text-state-danger space-y-1">
                <p className="text-xs font-semibold">容器列表读取失败</p>
                <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all font-mono leading-relaxed">
                  {containerError}
                </p>
                <p className="text-[10px] text-state-danger leading-relaxed">
                  提示：若报 permission denied，需要把当前用户加入 docker 组（usermod -aG docker
                  $USER 后重新登录），或让 docker 守护进程对当前用户开放 socket 权限。
                </p>
                <button
                  onClick={() => probeDocker()}
                  className="rounded-md border border-state-danger/30 bg-surface px-2 py-0.5 text-[10px] font-semibold text-state-danger hover:bg-state-danger/10"
                >
                  重新探测
                </button>
              </div>
            )}

            {hasDocker === false ? (
              <div className="p-4 rounded-xl border border-dashed border-line/15 bg-surface-muted text-center text-ink-secondary text-xs space-y-1.5">
                <p className="font-semibold text-ink-secondary">未检测到容器引擎</p>
                <p className="text-[10px] text-ink-secondary leading-relaxed">
                  当前服务器未安装或未运行 Docker / Podman，安装启动后即可在此查看容器列表与配置。
                </p>
                <button
                  onClick={() => probeDocker()}
                  className="rounded-md border border-line/25 bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-secondary hover:bg-line/5"
                >
                  重新探测
                </button>
              </div>
            ) : containersLoading && containers.length === 0 ? (
              <div className="text-center py-6 text-ink-secondary text-xs">正在扫描运行中的容器...</div>
            ) : containers.length === 0 ? (
              <div className="p-4 rounded-xl border border-dashed border-line/15 bg-surface text-center text-ink-secondary text-xs">
                暂无任何容器 (可通过终端执行 docker run 启动)
              </div>
            ) : (
              <div className="space-y-2">
                {containers.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => onOpenContainer?.(c.id)}
                    className="p-2.5 rounded-xl border border-line/15 bg-surface hover:border-accent/50 hover:shadow-apple-sm transition cursor-pointer space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-xs text-ink truncate max-w-[130px]">
                        {c.name}
                      </span>
                      <span
                        className={`px-1.5 py-0.2 rounded-full text-[9px] font-semibold uppercase ${
                          c.state === "running"
                            ? "bg-state-success/10 text-state-success border border-state-success/30"
                            : "bg-line/5 text-ink-secondary border border-line/15"
                        }`}
                      >
                        {c.state}
                      </span>
                    </div>

                    <div className="text-[10px] font-mono text-ink-secondary truncate" title={c.image}>
                      {c.image}
                    </div>

                    {c.ports && (
                      <div className="text-[9px] font-mono text-ink-secondary truncate bg-surface-muted p-1 rounded">
                        {c.ports}
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-1 border-t border-line/15 text-[10px] text-accent">
                      <span>进入容器工作区</span>
                      <span>→</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 杀进程确认对话框 */}
      {killPid !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/65 backdrop-blur-xs p-4">
          <div className="w-full max-w-xs bg-surface rounded-2xl p-4 shadow-xl border border-line/15 space-y-3">
            <h4 className="text-sm font-bold text-ink">确认终止进程？</h4>
            <p className="text-xs text-ink-secondary">
              即将向进程 PID <code className="font-mono bg-line/5 px-1 rounded">{killPid}</code> 发送终止信号。
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setKillPid(null)}
                className="px-3 py-1 rounded-lg border border-line/15 text-xs font-semibold text-ink-secondary hover:bg-surface-muted transition"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  if (killPid) {
                    await kill(killPid, 15);
                    setKillPid(null);
                    await poll();
                  }
                }}
                className="px-3 py-1 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 transition"
              >
                终止 (SIGTERM)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 容器详情已改为画布级 ContainerWorkspace，不再使用右侧抽屉 */}
    </aside>
  );
};
