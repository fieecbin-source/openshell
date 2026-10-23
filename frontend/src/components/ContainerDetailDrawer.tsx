import React, { useEffect, useState } from "react";
import { sshExec } from "../lib/ipc";

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: "running" | "exited" | "paused" | "restarting" | "dead";
  ports: string;
  created: string;
  composeProject?: string;
  cpuPercent?: string;
  memUsage?: string;
}

interface ContainerDetailDrawerProps {
  container: DockerContainerInfo | null;
  connId: string;
  onClose: () => void;
  onRefresh?: () => void;
}

export const ContainerDetailDrawer: React.FC<ContainerDetailDrawerProps> = ({
  container,
  connId,
  onClose,
  onRefresh,
}) => {
  const [activeTab, setActiveTab] = useState<"config" | "env" | "mounts" | "logs">("config");
  const [loading, setLoading] = useState(false);
  const [inspectData, setInspectData] = useState<any>(null);
  const [logs, setLogs] = useState<string>("");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [revealEnv, setRevealEnv] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!container || !connId) return;
    loadInspect();
    if (activeTab === "logs") {
      loadLogs();
    }
  }, [container?.id, connId, activeTab]);

  const loadInspect = async () => {
    if (!container) return;
    setLoading(true);
    try {
      // 保证容器名称/ID为合法字符
      const safeId = container.id.replace(/[^a-zA-Z0-9_.-]/g, "");
      const res = await sshExec(connId, `docker inspect ${safeId} || podman inspect ${safeId}`);
      if (res.exit_code === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout);
        setInspectData(Array.isArray(parsed) ? parsed[0] : parsed);
      }
    } catch (e: any) {
      console.warn("docker inspect error", e);
    } finally {
      setLoading(false);
    }
  };

  const loadLogs = async () => {
    if (!container) return;
    setLoading(true);
    try {
      const safeId = container.id.replace(/[^a-zA-Z0-9_.-]/g, "");
      const res = await sshExec(connId, `docker logs --tail 150 ${safeId} 2>&1 || podman logs --tail 150 ${safeId} 2>&1`);
      setLogs(res.stdout || res.stderr || "(无容器日志输出)");
    } catch (e: any) {
      setLogs(`获取日志失败: ${e.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleContainerAction = async (action: "start" | "stop" | "restart") => {
    if (!container) return;
    setActionLoading(true);
    setActionMsg(null);
    try {
      const safeId = container.id.replace(/[^a-zA-Z0-9_.-]/g, "");
      const res = await sshExec(connId, `docker ${action} ${safeId} || podman ${action} ${safeId}`);
      if (res.exit_code === 0) {
        setActionMsg(`✓ 操作成功: 已${action === "start" ? "启动" : action === "stop" ? "停止" : "重启"}容器`);
        setTimeout(() => setActionMsg(null), 3000);
        await loadInspect();
        if (onRefresh) onRefresh();
      } else {
        setActionMsg(`操作失败: ${res.stderr || "未知错误"}`);
      }
    } catch (e: any) {
      setActionMsg(`执行异常: ${e.message || String(e)}`);
    } finally {
      setActionLoading(false);
    }
  };

  if (!container) return null;

  const envList: { key: string; value: string }[] = [];
  if (inspectData?.Config?.Env && Array.isArray(inspectData.Config.Env)) {
    for (const item of inspectData.Config.Env) {
      const idx = item.indexOf("=");
      if (idx > -1) {
        envList.push({ key: item.slice(0, idx), value: item.slice(idx + 1) });
      } else {
        envList.push({ key: item, value: "" });
      }
    }
  }

  const mounts = inspectData?.Mounts || [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="w-full max-w-xl h-full bg-white shadow-2xl flex flex-col border-l border-slate-200 animate-in slide-in-from-right duration-200">
        {/* 头部标题与操作 */}
        <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl">🐳</span>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-sm text-slate-900">{container.name}</h3>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                    container.state === "running"
                      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                      : "bg-slate-100 text-slate-600 border border-slate-200"
                  }`}
                >
                  {container.state}
                </span>
              </div>
              <p className="text-[11px] font-mono text-slate-500 truncate max-w-sm">
                {container.image} · ID: {container.id.substring(0, 12)}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-800 transition"
          >
            ✕
          </button>
        </div>

        {/* 快捷操作控制栏 */}
        <div className="px-4 py-2 bg-slate-50 border-b border-slate-200/80 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {container.state !== "running" ? (
              <button
                disabled={actionLoading}
                onClick={() => handleContainerAction("start")}
                className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 transition disabled:opacity-50 flex items-center gap-1 shadow-apple-sm"
              >
                <span>▶ 启动容器</span>
              </button>
            ) : (
              <button
                disabled={actionLoading}
                onClick={() => handleContainerAction("stop")}
                className="px-2.5 py-1 rounded-lg bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700 transition disabled:opacity-50 flex items-center gap-1 shadow-apple-sm"
              >
                <span>⏹ 停止容器</span>
              </button>
            )}
            <button
              disabled={actionLoading}
              onClick={() => handleContainerAction("restart")}
              className="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-100 transition disabled:opacity-50 shadow-apple-sm flex items-center gap-1"
            >
              <span>🔄 重启</span>
            </button>
          </div>

          <div className="flex items-center gap-1 text-xs">
            <button
              onClick={() => setActiveTab("config")}
              className={`px-2.5 py-1 rounded-lg transition font-medium ${
                activeTab === "config" ? "bg-white text-apple-blue font-bold shadow-apple-sm" : "text-slate-600 hover:bg-slate-200/60"
              }`}
            >
              配置
            </button>
            <button
              onClick={() => setActiveTab("env")}
              className={`px-2.5 py-1 rounded-lg transition font-medium ${
                activeTab === "env" ? "bg-white text-apple-blue font-bold shadow-apple-sm" : "text-slate-600 hover:bg-slate-200/60"
              }`}
            >
              环境变量 ({envList.length})
            </button>
            <button
              onClick={() => setActiveTab("mounts")}
              className={`px-2.5 py-1 rounded-lg transition font-medium ${
                activeTab === "mounts" ? "bg-white text-apple-blue font-bold shadow-apple-sm" : "text-slate-600 hover:bg-slate-200/60"
              }`}
            >
              挂载卷 ({mounts.length})
            </button>
            <button
              onClick={() => setActiveTab("logs")}
              className={`px-2.5 py-1 rounded-lg transition font-medium ${
                activeTab === "logs" ? "bg-white text-apple-blue font-bold shadow-apple-sm" : "text-slate-600 hover:bg-slate-200/60"
              }`}
            >
              实时日志
            </button>
          </div>
        </div>

        {actionMsg && (
          <div className="px-4 py-1.5 bg-blue-50 text-blue-700 text-xs border-b border-blue-100 font-medium animate-in fade-in">
            {actionMsg}
          </div>
        )}

        {/* 内容主体 */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loading && (
            <div className="text-center py-8 text-xs text-slate-400">
              <span className="inline-block animate-spin mr-1.5">🔄</span> 正在读取容器配置...
            </div>
          )}

          {!loading && activeTab === "config" && (
            <div className="space-y-3 text-xs">
              <div className="rounded-xl border border-slate-200/80 bg-slate-50/40 p-3 space-y-2">
                <h4 className="font-bold text-slate-800 text-[11px] uppercase tracking-wider">基础元数据</h4>
                <div className="grid grid-cols-2 gap-2 text-slate-600">
                  <div>
                    <span className="text-slate-400">完整容器 ID:</span>
                    <p className="font-mono text-[11px] text-slate-800 break-all select-all">{inspectData?.Id || container.id}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">创建时间:</span>
                    <p className="font-mono text-[11px] text-slate-800">{inspectData?.Created || container.created}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">网络模式:</span>
                    <p className="font-mono text-[11px] text-slate-800">{inspectData?.HostConfig?.NetworkMode || "bridge"}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">重启策略:</span>
                    <p className="font-mono text-[11px] text-slate-800">{inspectData?.HostConfig?.RestartPolicy?.Name || "no"}</p>
                  </div>
                </div>
              </div>

              {/* 端口映射 */}
              <div className="rounded-xl border border-slate-200/80 bg-slate-50/40 p-3 space-y-2">
                <h4 className="font-bold text-slate-800 text-[11px] uppercase tracking-wider">网络与端口映射</h4>
                {container.ports ? (
                  <div className="bg-white p-2.5 rounded-lg border border-slate-200 font-mono text-xs text-slate-800">
                    {container.ports}
                  </div>
                ) : (
                  <p className="text-slate-400 italic">未对外暴露网络端口</p>
                )}
              </div>

              {/* 启动命令与工作目录 */}
              <div className="rounded-xl border border-slate-200/80 bg-slate-50/40 p-3 space-y-2">
                <h4 className="font-bold text-slate-800 text-[11px] uppercase tracking-wider">入口命令 (Command)</h4>
                <pre className="bg-slate-900 text-slate-100 p-2.5 rounded-lg font-mono text-[11px] overflow-x-auto select-all">
                  {inspectData?.Config?.Cmd ? inspectData.Config.Cmd.join(" ") : "(默认镜像入口)"}
                </pre>
              </div>
            </div>
          )}

          {!loading && activeTab === "env" && (
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between text-slate-500 text-[11px] mb-1">
                <span>环境变量 (敏感字段默认掩码保护)</span>
                <span>共 {envList.length} 条</span>
              </div>
              {envList.length === 0 ? (
                <div className="text-center py-8 text-slate-400">无配置的环境变量</div>
              ) : (
                envList.map(({ key, value }, idx) => {
                  const isSensitive = /pass|secret|key|token|auth|pwd/i.test(key);
                  const isRevealed = revealEnv[key];
                  return (
                    <div
                      key={idx}
                      className="p-2.5 rounded-xl border border-slate-200 bg-slate-50/60 font-mono text-xs flex items-center justify-between gap-2"
                    >
                      <div className="flex-1 truncate">
                        <span className="font-bold text-slate-800">{key}=</span>
                        <span className="text-slate-600 select-all">
                          {isSensitive && !isRevealed ? "••••••••••••" : value}
                        </span>
                      </div>
                      {isSensitive && (
                        <button
                          type="button"
                          onClick={() => setRevealEnv((prev) => ({ ...prev, [key]: !prev[key] }))}
                          className="text-[10px] text-apple-blue hover:underline shrink-0"
                        >
                          {isRevealed ? "隐藏" : "显示"}
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}

          {!loading && activeTab === "mounts" && (
            <div className="space-y-2.5 text-xs">
              <div className="text-slate-500 text-[11px] mb-1">挂载卷与宿主机目录映射</div>
              {mounts.length === 0 ? (
                <div className="text-center py-8 text-slate-400">无卷或目录挂载</div>
              ) : (
                mounts.map((m: any, idx: number) => (
                  <div key={idx} className="p-3 rounded-xl border border-slate-200 bg-white space-y-1.5 shadow-apple-sm">
                    <div className="flex items-center justify-between font-semibold text-slate-800">
                      <span>{m.Type === "volume" ? "📦 Docker 数据卷" : "📁 宿主机 Bind 挂载"}</span>
                      <span className="rounded bg-slate-100 text-slate-600 px-1.5 py-0.5 text-[10px]">
                        {m.RW ? "读写 (RW)" : "只读 (RO)"}
                      </span>
                    </div>
                    <div className="text-slate-600 font-mono text-[11px] space-y-1">
                      <div>
                        <span className="text-slate-400">宿主机路径: </span>
                        <span className="text-slate-900 select-all font-semibold">{m.Source}</span>
                      </div>
                      <div>
                        <span className="text-slate-400">容器内挂载: </span>
                        <span className="text-apple-blue select-all font-semibold">{m.Destination}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {!loading && activeTab === "logs" && (
            <div className="flex flex-col h-full space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>最近 150 行标准与错误输出</span>
                <button
                  onClick={loadLogs}
                  className="px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 transition text-[11px]"
                >
                  刷新日志
                </button>
              </div>
              <pre className="flex-1 bg-slate-950 text-emerald-400 p-3 rounded-xl font-mono text-[11px] leading-relaxed overflow-x-auto whitespace-pre-wrap select-all max-h-[600px] border border-slate-800">
                {logs}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
