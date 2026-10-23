import React, { useEffect, useState } from "react";
import type { TerminalTab } from "../stores/terminalStore";
import { useMonitorStore } from "../stores/monitorStore";
import { sshExec } from "../lib/ipc";
import { ContainerDetailDrawer, DockerContainerInfo } from "./ContainerDetailDrawer";

interface ServerSidebarProps {
  tab: TerminalTab;
}

export const ServerSidebar: React.FC<ServerSidebarProps> = ({ tab }) => {
  const { connId, sessionId } = { connId: tab.connectionId, sessionId: tab.sessionId };
  const {
    latest,
    start,
    stop,
    poll,
    kill,
  } = useMonitorStore();

  const [activeTab, setActiveTab] = useState<"overview" | "network" | "processes" | "containers">("overview");
  const [collapsed, setCollapsed] = useState(false);

  // 容器检测与列表
  const [hasDocker, setHasDocker] = useState<boolean | null>(null);
  const [containers, setContainers] = useState<DockerContainerInfo[]>([]);
  const [containersLoading, setContainersLoading] = useState(false);
  const [selectedContainer, setSelectedContainer] = useState<DockerContainerInfo | null>(null);

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

  // 探测 Docker / Podman
  useEffect(() => {
    if (!connId) return;
    probeContainers();
  }, [connId]);

  const probeContainers = async () => {
    if (!connId) return;
    setContainersLoading(true);
    try {
      // 探针：检查是否有 docker 或 podman
      const checkRes = await sshExec(connId, "command -v docker || command -v podman");
      if (checkRes.exit_code === 0 && checkRes.stdout.trim()) {
        setHasDocker(true);
        await loadContainers();
      } else {
        setHasDocker(false);
      }
    } catch (e) {
      setHasDocker(false);
    } finally {
      setContainersLoading(false);
    }
  };

  const loadContainers = async () => {
    if (!connId) return;
    setContainersLoading(true);
    try {
      // 通过 JSON 格式直接提取结构化容器列表
      const cmd = `docker ps -a --format '{{json .}}' 2>/dev/null || podman ps -a --format '{{json .}}' 2>/dev/null`;
      const res = await sshExec(connId, cmd);
      if (res.exit_code === 0 && res.stdout.trim()) {
        const lines = res.stdout.trim().split("\n");
        const list: DockerContainerInfo[] = [];
        for (const line of lines) {
          try {
            const item = JSON.parse(line);
            const rawStatus = (item.Status || "").toLowerCase();
            let state: DockerContainerInfo["state"] = "exited";
            if (rawStatus.includes("up")) state = "running";
            else if (rawStatus.includes("pause")) state = "paused";
            else if (rawStatus.includes("restart")) state = "restarting";

            list.push({
              id: item.ID || item.Id || "",
              name: (item.Names || item.name || "").replace(/^\//, ""),
              image: item.Image || item.image || "",
              status: item.Status || "",
              state,
              ports: item.Ports || "",
              created: item.CreatedAt || item.RunningFor || "",
            });
          } catch {}
        }
        setContainers(list);
      } else {
        setContainers([]);
      }
    } catch (e) {
      console.warn("loadContainers failed", e);
    } finally {
      setContainersLoading(false);
    }
  };

  const loadListeningPorts = async () => {
    if (!connId) return;
    setPortsLoading(true);
    try {
      // 读取 TCP 监听端口
      const res = await sshExec(connId, "ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null");
      if (res.exit_code === 0 && res.stdout) {
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

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const formatSpeed = (bytesPerSec: number) => {
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

  const cpuPct = metrics?.cpu_percent ? Math.round(metrics.cpu_percent) : 0;
  const memTotal = metrics?.memory_total_bytes || 1;
  const memUsed = metrics?.memory_used_bytes || 0;
  const memPct = Math.round((memUsed / memTotal) * 100);

  // 折叠状态显示胶囊小侧边
  if (collapsed) {
    return (
      <aside className="w-11 shrink-0 bg-[#fbfbfd] border-r border-slate-200/80 flex flex-col items-center py-3 select-none transition-all duration-200">
        <button
          onClick={() => setCollapsed(false)}
          className="p-1 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-200/60 transition mb-4"
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
            <span className="text-[10px] text-slate-400 font-bold mb-1">CPU</span>
            <div className="w-2 h-14 bg-slate-200 rounded-full overflow-hidden flex flex-col justify-end">
              <div
                className={`w-full rounded-full transition-all duration-500 ${
                  cpuPct > 80 ? "bg-red-500" : cpuPct > 60 ? "bg-amber-500" : "bg-apple-blue"
                }`}
                style={{ height: `${Math.min(cpuPct, 100)}%` }}
              />
            </div>
            <span className="text-[9px] font-mono text-slate-600 mt-1">{cpuPct}%</span>
          </div>

          <div
            className="flex flex-col items-center cursor-pointer group"
            onClick={() => {
              setCollapsed(false);
              setActiveTab("overview");
            }}
            title={`内存占用: ${memPct}%`}
          >
            <span className="text-[10px] text-slate-400 font-bold mb-1">MEM</span>
            <div className="w-2 h-14 bg-slate-200 rounded-full overflow-hidden flex flex-col justify-end">
              <div
                className={`w-full rounded-full transition-all duration-500 ${
                  memPct > 80 ? "bg-red-500" : memPct > 60 ? "bg-amber-500" : "bg-emerald-500"
                }`}
                style={{ height: `${Math.min(memPct, 100)}%` }}
              />
            </div>
            <span className="text-[9px] font-mono text-slate-600 mt-1">{memPct}%</span>
          </div>

          {hasDocker && (
            <button
              onClick={() => {
                setCollapsed(false);
                setActiveTab("containers");
              }}
              className="p-1 rounded-lg text-slate-500 hover:text-apple-blue hover:bg-slate-200/60 transition mt-2"
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
    <aside className="w-64 shrink-0 bg-[#fbfbfd] border-r border-slate-200/80 flex flex-col select-none overflow-hidden h-full">
      {/* 顶部服务器概览头 */}
      <div className="p-3 border-b border-slate-200/80 bg-white/70 backdrop-blur-sm">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5 overflow-hidden">
            <span className="h-2 w-2 rounded-full bg-apple-green shrink-0 shadow-apple-sm animate-pulse" />
            <h3 className="text-xs font-bold text-slate-900 truncate" title={tab.sessionName}>
              {tab.sessionName}
            </h3>
          </div>
          <button
            onClick={() => setCollapsed(true)}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition"
            title="收起为迷你胶囊"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        </div>

        {/* 基础运行信息 */}
        <div className="grid grid-cols-2 gap-1 text-[10px] text-slate-500 font-mono">
          <div>
            <span className="text-slate-400">运行: </span>
            <span className="text-slate-700 font-semibold">{formatUptime(metrics?.uptime_seconds || 0)}</span>
          </div>
          <div className="text-right">
            <span className="text-slate-400">负载: </span>
            <span className="text-slate-700 font-semibold">
              {metrics ? `${metrics.load_1.toFixed(1)}, ${metrics.load_5.toFixed(1)}` : "-"}
            </span>
          </div>
        </div>
      </div>

      {/* 4 选项卡导航 (Apple Segmented Tabs) */}
      <div className="flex p-1 bg-slate-100/90 border-b border-slate-200/80 text-[11px] font-medium gap-0.5">
        <button
          onClick={() => setActiveTab("overview")}
          className={`flex-1 py-1 rounded-md transition text-center ${
            activeTab === "overview" ? "bg-white text-apple-blue font-bold shadow-apple-sm" : "text-slate-600 hover:text-slate-900"
          }`}
        >
          概览
        </button>
        <button
          onClick={() => {
            setActiveTab("network");
            loadListeningPorts();
          }}
          className={`flex-1 py-1 rounded-md transition text-center ${
            activeTab === "network" ? "bg-white text-apple-blue font-bold shadow-apple-sm" : "text-slate-600 hover:text-slate-900"
          }`}
        >
          网络
        </button>
        <button
          onClick={() => setActiveTab("processes")}
          className={`flex-1 py-1 rounded-md transition text-center ${
            activeTab === "processes" ? "bg-white text-apple-blue font-bold shadow-apple-sm" : "text-slate-600 hover:text-slate-900"
          }`}
        >
          进程
        </button>
        <button
          onClick={() => {
            setActiveTab("containers");
            probeContainers();
          }}
          className={`flex-1 py-1 rounded-md transition text-center flex items-center justify-center gap-0.5 ${
            activeTab === "containers" ? "bg-white text-apple-blue font-bold shadow-apple-sm" : "text-slate-600 hover:text-slate-900"
          }`}
        >
          <span>容器</span>
          {containers.length > 0 && (
            <span className="text-[9px] bg-apple-blue/10 text-apple-blue px-1 rounded-full font-bold">
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
            <div className="p-2.5 rounded-xl border border-slate-200 bg-white shadow-apple-sm space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-slate-700 font-semibold flex items-center gap-1.5">
                  <span className="text-apple-blue">⚡</span>
                  <span>CPU 占用</span>
                </span>
                <span className="font-mono font-bold text-slate-900">{cpuPct}%</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    cpuPct > 80 ? "bg-red-500" : cpuPct > 60 ? "bg-amber-500" : "bg-apple-blue"
                  }`}
                  style={{ width: `${Math.min(cpuPct, 100)}%` }}
                />
              </div>
              {metrics?.cpu_cores && metrics.cpu_cores.length > 1 && (
                <div className="text-[9px] text-slate-400 font-mono text-right">
                  {metrics.cpu_cores.length} 核心
                </div>
              )}
            </div>

            {/* 内存已用/总计卡片 */}
            <div className="p-2.5 rounded-xl border border-slate-200 bg-white shadow-apple-sm space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-slate-700 font-semibold flex items-center gap-1.5">
                  <span className="text-emerald-500">🧠</span>
                  <span>内存占用</span>
                </span>
                <span className="font-mono font-bold text-slate-900">{memPct}%</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    memPct > 85 ? "bg-red-500" : memPct > 70 ? "bg-amber-500" : "bg-emerald-500"
                  }`}
                  style={{ width: `${Math.min(memPct, 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono text-slate-500">
                <span>已用: {formatBytes(memUsed)}</span>
                <span>总量: {formatBytes(memTotal)}</span>
              </div>
            </div>

            {/* 实时网络流量 */}
            <div className="p-2.5 rounded-xl border border-slate-200 bg-white shadow-apple-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-700 font-semibold flex items-center gap-1.5">
                  <span className="text-indigo-500">🌐</span>
                  <span>网络传输速率</span>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="bg-slate-50 p-1.5 rounded-lg border border-slate-100">
                  <span className="text-[10px] text-slate-400 block">↑ 上行 (Tx)</span>
                  <span className="text-xs font-mono font-bold text-indigo-600 block mt-0.5">
                    {formatSpeed(metrics?.net_tx_bps || 0)}
                  </span>
                  <span className="text-[9px] font-mono text-slate-400 block mt-0.5">
                    累计: {formatBytes(metrics?.net_tx_total || 0)}
                  </span>
                </div>
                <div className="bg-slate-50 p-1.5 rounded-lg border border-slate-100">
                  <span className="text-[10px] text-slate-400 block">↓ 下行 (Rx)</span>
                  <span className="text-xs font-mono font-bold text-emerald-600 block mt-0.5">
                    {formatSpeed(metrics?.net_rx_bps || 0)}
                  </span>
                  <span className="text-[9px] font-mono text-slate-400 block mt-0.5">
                    累计: {formatBytes(metrics?.net_rx_total || 0)}
                  </span>
                </div>
              </div>
            </div>

            {/* 磁盘空间 */}
            {metrics?.disk_mounts && metrics.disk_mounts.length > 0 && (
              <div className="p-2.5 rounded-xl border border-slate-200 bg-white shadow-apple-sm space-y-2">
                <span className="text-slate-700 font-semibold flex items-center gap-1.5">
                  <span className="text-amber-500">💾</span>
                  <span>磁盘空间</span>
                </span>
                <div className="space-y-2">
                  {metrics.disk_mounts.slice(0, 3).map((d: any, i: number) => (
                    <div key={i} className="space-y-1">
                      <div className="flex items-center justify-between text-[10px] font-mono">
                        <span className="text-slate-700 font-semibold truncate max-w-[120px]">{d.mount_point}</span>
                        <span className="text-slate-500">
                          {formatBytes(d.used_bytes)} / {formatBytes(d.total_bytes)} ({d.use_percent}%)
                        </span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            d.use_percent > 85 ? "bg-red-500" : "bg-amber-500"
                          }`}
                          style={{ width: `${Math.min(d.use_percent, 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ================= Tab 2: 网络与端口 ================= */}
        {activeTab === "network" && (
          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-slate-700">监听 TCP 端口列表</span>
              <button
                onClick={loadListeningPorts}
                className="text-[10px] text-apple-blue hover:underline"
              >
                {portsLoading ? "刷新中..." : "刷新"}
              </button>
            </div>
            {listeningPorts.length === 0 ? (
              <div className="text-center py-6 text-slate-400 text-xs">
                {portsLoading ? "正在扫描监听端口..." : "暂无监听端口信息或权限不足"}
              </div>
            ) : (
              <div className="space-y-1.5">
                {listeningPorts.map((p, idx) => (
                  <div
                    key={idx}
                    className="p-2 rounded-lg border border-slate-200 bg-white flex items-center justify-between font-mono text-[11px]"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="rounded bg-indigo-50 text-indigo-700 px-1 py-0.2 text-[9px] font-bold">
                        {p.proto}
                      </span>
                      <span className="font-bold text-slate-800">:{p.port}</span>
                    </div>
                    <span className="text-slate-400 text-[10px] truncate max-w-[110px]" title={p.process}>
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
            <div className="flex items-center justify-between text-slate-500 text-[11px]">
              <span>Top 进程 (按 CPU/内存占用)</span>
              <span>PID / 占用</span>
            </div>
            {(!metrics?.top_processes || metrics.top_processes.length === 0) ? (
              <div className="text-center py-6 text-slate-400 text-xs">暂无进程信息</div>
            ) : (
              <div className="space-y-1.5">
                {metrics.top_processes.slice(0, 15).map((proc: any, idx: number) => (
                  <div
                    key={idx}
                    className="p-2 rounded-xl border border-slate-200 bg-white flex items-center justify-between gap-1 shadow-apple-sm font-mono text-[11px]"
                  >
                    <div className="truncate flex-1">
                      <div className="font-semibold text-slate-800 truncate" title={proc.command}>
                        {proc.command}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        PID: {proc.pid} · {proc.user}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-apple-blue font-bold text-[10px]">
                        CPU {proc.cpu_percent.toFixed(1)}%
                      </div>
                      <div className="text-slate-400 text-[9px]">
                        MEM {proc.mem_percent.toFixed(1)}%
                      </div>
                    </div>
                    <button
                      onClick={() => setKillPid(proc.pid)}
                      className="ml-1 p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
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
              <span className="text-[11px] font-semibold text-slate-700 flex items-center gap-1">
                <span>🐳 Docker / Podman 容器</span>
              </span>
              <button
                onClick={loadContainers}
                className="text-[10px] text-apple-blue hover:underline"
              >
                {containersLoading ? "刷新中..." : "刷新"}
              </button>
            </div>

            {hasDocker === false ? (
              <div className="p-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 text-center text-slate-500 text-xs space-y-1">
                <p className="font-semibold text-slate-700">未检测到容器引擎</p>
                <p className="text-[10px] text-slate-400 leading-relaxed">
                  当前服务器未安装或未运行 Docker / Podman，安装启动后即可在此查看容器列表与配置。
                </p>
              </div>
            ) : containersLoading && containers.length === 0 ? (
              <div className="text-center py-6 text-slate-400 text-xs">正在扫描运行中的容器...</div>
            ) : containers.length === 0 ? (
              <div className="p-4 rounded-xl border border-dashed border-slate-200 bg-white text-center text-slate-500 text-xs">
                暂无任何容器 (可通过终端执行 docker run 启动)
              </div>
            ) : (
              <div className="space-y-2">
                {containers.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => setSelectedContainer(c)}
                    className="p-2.5 rounded-xl border border-slate-200 bg-white hover:border-apple-blue/50 hover:shadow-apple-sm transition cursor-pointer space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-xs text-slate-900 truncate max-w-[130px]">
                        {c.name}
                      </span>
                      <span
                        className={`px-1.5 py-0.2 rounded-full text-[9px] font-semibold uppercase ${
                          c.state === "running"
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            : "bg-slate-100 text-slate-600 border border-slate-200"
                        }`}
                      >
                        {c.state}
                      </span>
                    </div>

                    <div className="text-[10px] font-mono text-slate-500 truncate" title={c.image}>
                      {c.image}
                    </div>

                    {c.ports && (
                      <div className="text-[9px] font-mono text-slate-400 truncate bg-slate-50 p-1 rounded">
                        {c.ports}
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-1 border-t border-slate-100 text-[10px] text-apple-blue">
                      <span>查看详情配置</span>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-xs p-4">
          <div className="w-full max-w-xs bg-white rounded-2xl p-4 shadow-xl border border-slate-200 space-y-3">
            <h4 className="text-sm font-bold text-slate-900">确认终止进程？</h4>
            <p className="text-xs text-slate-600">
              即将向进程 PID <code className="font-mono bg-slate-100 px-1 rounded">{killPid}</code> 发送终止信号。
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setKillPid(null)}
                className="px-3 py-1 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition"
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

      {/* 容器配置详情抽屉 */}
      {selectedContainer && connId && (
        <ContainerDetailDrawer
          container={selectedContainer}
          connId={connId}
          onClose={() => setSelectedContainer(null)}
          onRefresh={loadContainers}
        />
      )}
    </aside>
  );
};
