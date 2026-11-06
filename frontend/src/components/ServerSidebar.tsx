import React, { useEffect, useState } from "react";
import type { TerminalTab } from "../stores/terminalStore";
import { isFieldUnavailable, isMetricsStale, readAvailableMetric, useMonitorStore } from "../stores/monitorStore";
import { useSessionStore } from "../stores/sessionStore";
import { sshExec } from "../lib/ipc";
import { useContainerStore } from "../stores/containerStore";
import { NetworkTraffic } from "./NetworkTraffic";
import { ConnectionDetailsPopover } from "./ConnectionDetailsPopover";
import { HostIcon } from "./ui/HostIcon";
import { ActivityIcon, BoxIcon, CpuIcon, MemoryIcon, HardDriveIcon, InfoIcon, WifiOffIcon } from "./ui/icons";

interface ServerSidebarProps {
  tab: TerminalTab;
  /** 会话保存的主机图标；未设置时回落到通用服务器图标 */
  iconKey?: string | null;
  collapsed: boolean;
  monitorOpen?: boolean;
  /** 打开当前连接的资源监控 */
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

export const ServerSidebar: React.FC<ServerSidebarProps> = ({ tab, iconKey, collapsed, monitorOpen, onOpenMonitor, onOpenContainer }) => {
  const { connId, sessionId } = { connId: tab.connectionId, sessionId: tab.sessionId };
  const connected = tab.status === "connected" && !!connId;
  const {
    latest,
    latestError,
    start,
    stop,
    poll,
    kill,
  } = useMonitorStore();

  /** 采样任务可能因断线/异常被停掉，切到进程页时自愈重启 */
  const ensureMonitoring = () => {
    const st = useMonitorStore.getState();
    if (!st.isMonitoring && st.activeConnId !== connId && connected && sessionId && connId) void st.start(sessionId, connId);
  };

  // 第 2 个标签展示的是监听端口而不是网络流量，直接叫「端口」，避免误导
  const [activeTab, setActiveTab] = useState<"overview" | "ports" | "processes" | "containers">("overview");
  const [detailsOpen, setDetailsOpen] = useState(false);

  const sessions = useSessionStore((s) => s.sessions);
  const currentSession = sessions.find((s) => s.id === sessionId) ?? null;

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
    if (!connected || !sessionId || !connId) return;

    start(sessionId, connId);

    return () => {
      void stop(sessionId, connId);
    };
  }, [sessionId, connId, connected, start, stop]);

  /** connId 可能为 null（未连接），统一收口 */
  const probeDocker = () => {
    if (connected && connId) void probeContainers(connId);
  };

  // 探测 Docker / Podman（结果进 store，画布级容器工作区复用同一份）
  useEffect(() => {
    if (connected) probeDocker();
    else useContainerStore.getState().reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, connected, probeContainers]);

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

  const metricsStale = latest ? isMetricsStale(latest) : false;
  // 失败或陈旧快照不能当实时值展示；合法 0 仍会正常显示
  const metrics = connected && latest?.session_id === sessionId && !metricsStale ? latest : null;
  const hasProcesses = (metrics?.top_processes?.length ?? 0) > 0;

  /**
   * 进程页自动补拉。
   *
   * 远端 `ps` 往往比 CPU/内存采样慢，第一帧快照里可能还没有进程；
   * 这里在进程页停留期间自动重试，用户不需要手动点「重新采集」。
   */
  useEffect(() => {
    if (activeTab !== "processes" || !connected || !connId) return;
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
  }, [activeTab, connId, sessionId, connected, hasProcesses]);

  const formatBytes = (raw: number) => {
    const bytes = num(raw);
    if (bytes <= 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
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

  const cpuValue = readAvailableMetric(metrics, "cpu_percent");
  const cpuPct = cpuValue === null ? null : Math.round(cpuValue);
  const cpuLabel = cpuPct === null ? "不可用" : `${cpuPct}%`;
  const cpuBarPct = cpuPct === null ? 0 : Math.min(cpuPct, 100);
  const coresUnavailable = isFieldUnavailable(metrics, "cpu_cores");
  const loadUnavailable = isFieldUnavailable(metrics, "load_1");
  const memTotal = num(metrics?.memory_total_bytes) || 1;
  const memUsed = num(metrics?.memory_used_bytes);
  const memPct = Math.min(100, Math.round((memUsed / memTotal) * 100));

  const isStatusConnected = tab.status === "connected";
  const isStatusConnecting = tab.status === "connecting" || tab.status === "reconnecting";
  const statusDotClass = isStatusConnected
    ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.75)] animate-pulse"
    : isStatusConnecting
      ? "bg-amber-500 animate-pulse"
      : "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.75)]";
  const statusBadgeClass = isStatusConnected
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
    : isStatusConnecting
      ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
      : "border-red-500/30 bg-red-500/10 text-red-500";
  const statusBadgeLabel = isStatusConnected
    ? "已连接"
    : isStatusConnecting
      ? "连接中/重连中"
      : "已断开";

  // 折叠状态仅展示资源可视化监控，其余功能收起，避免点击破坏小侧栏布局
  if (collapsed) {
    return (
      <aside className="w-full min-w-0 bg-surface-muted flex flex-col items-center py-4 select-none h-full">
        {connected && metrics ? (
          <div className="flex flex-col gap-5 text-center pt-1">
            <div
              className="flex flex-col items-center"
              title={`CPU 使用率: ${cpuLabel}`}
            >
              <span className="text-[10px] text-ink-secondary font-bold mb-1">CPU</span>
              <div className="w-2.5 h-16 bg-line/10 rounded-full overflow-hidden flex flex-col justify-end">
                <div
                  className={`w-full rounded-full transition-all duration-500 ${
                    (cpuPct ?? 0) > 80 ? "bg-state-danger/100" : (cpuPct ?? 0) > 60 ? "bg-state-warning/100" : "bg-action"
                  }`}
                  style={{ height: `${cpuBarPct}%` }}
                />
              </div>
              <span className="text-[9px] font-mono text-ink-secondary mt-1">{cpuLabel}</span>
            </div>

            <div
              className="flex flex-col items-center"
              title={`内存占用: ${memPct}%`}
            >
              <span className="text-[10px] text-ink-secondary font-bold mb-1">MEM</span>
              <div className="w-2.5 h-16 bg-line/10 rounded-full overflow-hidden flex flex-col justify-end">
                <div
                  className={`w-full rounded-full transition-all duration-500 ${
                    memPct > 80 ? "bg-state-danger/100" : memPct > 60 ? "bg-state-warning/100" : "bg-state-success/100"
                  }`}
                  style={{ height: `${Math.min(memPct, 100)}%` }}
                />
              </div>
              <span className="text-[9px] font-mono text-ink-secondary mt-1">{memPct}%</span>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-ink-tertiary gap-1">
            {connected ? (
              latestError ? (
                <span className="text-[9px] font-mono text-state-danger text-center leading-tight" title={latestError}>
                  采集失败
                </span>
              ) : metricsStale ? (
                <span className="text-[9px] font-mono text-state-warning text-center leading-tight" title="数据已过期">
                  数据过期
                </span>
              ) : (
                <span className="text-[10px] font-mono text-ink-tertiary" title="等待首次采样">--</span>
              )
            ) : (
              <span className="h-2 w-2 rounded-full bg-rose-500/80" title="未连接" />
            )}
          </div>
        )}

        {/* 折叠态保留两个最常用入口，避免用户必须展开侧栏才能监控/进容器 */}
        <div className="mt-auto flex flex-col items-center gap-2 pb-1">
          {connected && onOpenMonitor && (
            <button
              type="button"
              aria-label="资源监控"
              aria-pressed={!!monitorOpen}
              title={`${tab.sessionName} · 资源监控`}
              onClick={onOpenMonitor}
              className="rounded-lg border border-accent/25 bg-accent/10 p-1.5 text-accent hover:bg-accent/20 transition"
            >
              <ActivityIcon className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            aria-label="容器管理"
            title="容器管理"
            disabled={!onOpenContainer}
            onClick={() => {
              // 折叠态入口同时把展开后的标签页定位到容器，避免用户再找一次
              setActiveTab("containers");
              probeDocker();
              onOpenContainer?.();
            }}
            className="rounded-lg border border-line/15 bg-surface/80 p-1.5 text-ink-secondary hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 transition"
          >
            <BoxIcon className="h-4 w-4" />
          </button>
        </div>
      </aside>
    );
  }

  const renderTopHostHeader = () => (
    <div className="p-3 border-b border-line/10 bg-surface/80 backdrop-blur-md">
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <HostIcon iconKey={iconKey ?? currentSession?.icon_key} protocol={tab.protocol} className="h-4 w-4 shrink-0" />
          <span className={`h-2 w-2 rounded-full shrink-0 ${statusDotClass}`} />
          <h3 className="text-xs font-bold text-ink truncate" title={tab.sessionName}>
            {tab.sessionName}
          </h3>
        </div>
        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${statusBadgeClass}`}>
          {statusBadgeLabel}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setDetailsOpen(true)}
            className="flex items-center gap-1 rounded-lg border border-line/15 bg-surface/80 px-2 py-1 text-[11px] font-medium text-ink-secondary hover:border-accent/40 hover:text-accent hover:bg-surface transition shadow-apple-sm"
            title={`${tab.sessionName} · 连接详情`}
          >
            <InfoIcon className="h-3 w-3" />
            <span>连接详情</span>
          </button>
          {onOpenMonitor && connected && (
            <button
              onClick={onOpenMonitor}
              aria-pressed={!!monitorOpen}
              className="flex items-center gap-1 rounded-lg border border-accent/25 bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/20 transition shadow-apple-sm"
              title={`${tab.sessionName} · 资源监控`}
            >
              <ActivityIcon className="h-3 w-3" />
              <span>资源监控</span>
            </button>
          )}
          {connected && <span className="rounded-md border border-state-success/30 bg-state-success/10 px-1.5 py-0.5 text-[10px] font-medium text-state-success">⚡ 无限速</span>}
      </div>
    </div>
  );

  if (!connected) {
    return (
      <>
        <aside className="w-full min-w-0 bg-surface-muted flex flex-col select-none overflow-hidden h-full text-ink">
          {renderTopHostHeader()}
          <div className="flex flex-1 min-w-0 flex-col items-center justify-center gap-3 p-3 text-center text-ink-tertiary">
            {connected ? <ActivityIcon className="h-5 w-5 shrink-0" /> : <WifiOffIcon className="h-5 w-5 shrink-0" />}
            <p className="text-os-xs font-medium text-ink-secondary">
              {connected
                ? "正在采集资源"
                : isStatusConnecting
                  ? "正在连接主机"
                  : "主机未连接"}
            </p>
            <p className="text-os-2xs leading-relaxed">
              {connected ? "等待首个采样结果" : "在终端按回车重新连接"}
            </p>
          </div>
        </aside>
        <ConnectionDetailsPopover
          open={detailsOpen}
          onClose={() => setDetailsOpen(false)}
          tab={tab}
          session={currentSession}
        />
      </>
    );
  }

  return (
    <>
    <aside className="w-full min-w-0 bg-surface/70 backdrop-blur-xl flex flex-col select-none overflow-hidden h-full text-ink">
      {/* 顶部服务器概览头 */}
      {renderTopHostHeader()}

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
        {activeTab === "overview" && !metrics && (
          <div className="py-6 text-center text-xs text-ink-secondary">
            {latestError
              ? `采集失败：${latestError}`
              : metricsStale
                ? "数据已过期，等待下一次采集"
                : "正在采集资源 · 等待首次采样"}
          </div>
        )}
        {activeTab === "overview" && metrics && (
          <div className="space-y-3 text-xs">
            {/* 系统运行与负载信息 */}
            {metrics && (
              <div className="p-2.5 rounded-xl border border-line/10 bg-surface/70 backdrop-blur-md shadow-apple-sm flex items-center justify-between font-mono text-[11px]">
                <div className="flex items-center gap-1.5">
                  <span className="text-ink-secondary">运行时长:</span>
                  <span className="text-ink font-semibold">{formatUptime(metrics?.uptime_seconds || 0)}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-ink-secondary">负载:</span>
                  <span className="text-ink font-semibold">
                    {loadUnavailable
                      ? "不可用"
                      : `${num(metrics.load_1).toFixed(1)}, ${num(metrics.load_5).toFixed(1)}`}
                  </span>
                </div>
              </div>
            )}

            {/* CPU 进度卡片 */}
            <div className="p-2.5 rounded-xl border border-line/10 bg-surface/70 backdrop-blur-md shadow-apple-sm space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-ink font-semibold flex items-center gap-1.5">
                  <CpuIcon className="h-4 w-4 text-accent" />
                  <span>CPU 占用</span>
                </span>
                <span className="font-mono font-bold text-ink">{cpuLabel}</span>
              </div>
              <div className="w-full bg-line/10 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    (cpuPct ?? 0) > 80 ? "bg-state-danger/100" : (cpuPct ?? 0) > 60 ? "bg-state-warning/100" : "bg-action"
                  }`}
                  style={{ width: `${cpuBarPct}%` }}
                />
              </div>
              {coresUnavailable ? (
                <div className="text-[9px] text-ink-secondary font-mono text-right">
                  核心负载不可用
                </div>
              ) : metrics?.cpu_cores && metrics.cpu_cores.length > 1 && (
                <div className="text-[9px] text-ink-secondary font-mono text-right">
                  {metrics.cpu_cores.length} 核心
                </div>
              )}
            </div>

            {/* 内存已用/总计卡片 */}
            <div className="p-2.5 rounded-xl border border-line/10 bg-surface/70 backdrop-blur-md shadow-apple-sm space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-ink font-semibold flex items-center gap-1.5">
                  <MemoryIcon className="h-4 w-4 text-ink-secondary" />
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
            <NetworkTraffic metrics={metrics} />

            {/* 磁盘空间 */}
            {metrics?.disk_mounts && metrics.disk_mounts.length > 0 && (
              <div className="p-2.5 rounded-xl border border-line/10 bg-surface/70 backdrop-blur-md shadow-apple-sm space-y-2">
                <span className="text-ink font-semibold flex items-center gap-1.5">
                  <HardDriveIcon className="h-4 w-4 text-ink-secondary" />
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 text-[11px] font-semibold text-ink-secondary flex items-center gap-1">
                <span className="inline-flex items-center gap-1.5"><BoxIcon className="h-4 w-4" />Docker / Podman 容器</span>
                {containerRuntime && (
                  <span className="min-w-0 truncate font-mono text-[9px] font-normal text-ink-secondary" title={containerRuntime}>
                    {containerRuntime.split("/").pop()}
                  </span>
                )}
              </span>
              <div className="flex shrink-0 items-center gap-2">
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
                暂无容器
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
    <ConnectionDetailsPopover
      open={detailsOpen}
      onClose={() => setDetailsOpen(false)}
      tab={tab}
      session={currentSession}
    />
    </>
  );
};
