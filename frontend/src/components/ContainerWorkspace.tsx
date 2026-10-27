import React, { useEffect, useMemo, useState } from "react";
import { sshExec } from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";
import { useContainerStore, type DockerContainerInfo } from "../stores/containerStore";

interface ContainerWorkspaceProps {
  connId: string;
  /** 从侧栏点进来时聚焦的那个容器 */
  initialContainerId?: string;
  /** 关闭容器视图，回到终端命令行 */
  onClose: () => void;
}

type DetailTab = "overview" | "env" | "mounts" | "logs";

const STATE_DOT: Record<DockerContainerInfo["state"], string> = {
  running: "bg-emerald-500",
  paused: "bg-amber-500",
  restarting: "bg-blue-500",
  exited: "bg-slate-400",
  dead: "bg-red-500",
};

const STATE_TEXT: Record<DockerContainerInfo["state"], string> = {
  running: "运行中",
  paused: "已暂停",
  restarting: "重启中",
  exited: "已停止",
  dead: "异常",
};

/**
 * 画布级容器路由工作区。
 *
 * 打开后整块工作区被容器界面接管，终端不再显示（xterm 实例保持挂载，PTY 不断开），
 * 左侧点击任意容器即切换到该容器 —— 容器之间的「路由」都在这个画布里完成。
 */
export const ContainerWorkspace: React.FC<ContainerWorkspaceProps> = ({
  connId,
  initialContainerId,
  onClose,
}) => {
  const containers = useContainerStore((s) => s.containers);
  const runtime = useContainerStore((s) => s.runtime);
  const loading = useContainerStore((s) => s.loading);
  const error = useContainerStore((s) => s.error);
  const probed = useContainerStore((s) => s.probed);
  const probe = useContainerStore((s) => s.probe);
  const reload = useContainerStore((s) => s.reload);
  const runAction = useContainerStore((s) => s.action);

  const [selectedId, setSelectedId] = useState<string>(initialContainerId ?? "");
  const [keyword, setKeyword] = useState("");
  const [tab, setTab] = useState<DetailTab>("overview");
  const [inspectData, setInspectData] = useState<any>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [logs, setLogs] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [revealEnv, setRevealEnv] = useState<Record<string, boolean>>({});

  // 首次进入（或连接切换）时探测一次
  useEffect(() => {
    if (!probed || useContainerStore.getState().connId !== connId) {
      probe(connId);
    }
  }, [connId, probed, probe]);

  // 默认选中第一个运行中的容器
  useEffect(() => {
    if (containers.length === 0) {
      setSelectedId("");
      return;
    }
    const stillThere = containers.some((c) => c.id === selectedId);
    if (!stillThere) {
      const running = containers.find((c) => c.state === "running");
      setSelectedId((running ?? containers[0]).id);
    }
  }, [containers, selectedId]);

  const selected = useMemo(
    () => containers.find((c) => c.id === selectedId) ?? null,
    [containers, selectedId]
  );

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return containers;
    return containers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.image.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        (c.composeProject || "").toLowerCase().includes(q)
    );
  }, [containers, keyword]);

  const loadInspect = async (container: DockerContainerInfo) => {
    setInspectLoading(true);
    try {
      const safeId = container.id.replace(/[^a-zA-Z0-9_.-]/g, "");
      const res = await sshExec(connId, `${runtime || "docker"} inspect ${safeId}`);
      const raw = (res.stdout || "").trim();
      if (raw.startsWith("[") || raw.startsWith("{")) {
        const parsed = JSON.parse(raw);
        setInspectData(Array.isArray(parsed) ? parsed[0] : parsed);
      } else {
        setInspectData(null);
      }
    } catch {
      setInspectData(null);
    } finally {
      setInspectLoading(false);
    }
  };

  const loadLogs = async (container: DockerContainerInfo) => {
    setLogsLoading(true);
    try {
      const safeId = container.id.replace(/[^a-zA-Z0-9_.-]/g, "");
      const res = await sshExec(connId, `${runtime || "docker"} logs --tail 200 ${safeId} 2>&1`);
      setLogs((res.stdout || res.stderr || "").trim() || "(该容器暂无日志输出)");
    } catch (e) {
      setLogs(`读取日志失败：${formatFriendlyError(e)}`);
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    if (!selected) return;
    setRevealEnv({});
    if (tab === "overview" || tab === "env" || tab === "mounts") loadInspect(selected);
    if (tab === "logs") loadLogs(selected);
  }, [selected?.id, tab]);

  const handleAction = async (act: "start" | "stop" | "restart") => {
    if (!selected) return;
    setActionLoading(true);
    setActionMsg(null);
    const msg = await runAction(selected.id, act);
    setActionMsg(msg);
    setActionLoading(false);
    if (selected) loadInspect(selected);
    setTimeout(() => setActionMsg(null), 4000);
  };

  const envList: { key: string; value: string }[] = [];
  if (Array.isArray(inspectData?.Config?.Env)) {
    for (const item of inspectData.Config.Env as string[]) {
      const idx = item.indexOf("=");
      envList.push(
        idx > -1 ? { key: item.slice(0, idx), value: item.slice(idx + 1) } : { key: item, value: "" }
      );
    }
  }
  const mounts: any[] = Array.isArray(inspectData?.Mounts) ? inspectData.Mounts : [];

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-white animate-in fade-in duration-150">
      {/* 顶部：返回终端 + 当前容器操作 */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-slate-200 bg-slate-50/80 px-3">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-apple-sm transition hover:bg-slate-100"
          title="关闭容器视图，回到终端命令行"
        >
          <span className="text-sm leading-none">←</span>
          <span>返回终端</span>
        </button>

        <div className="flex min-w-0 items-center gap-2">
          <span className="text-base">🐳</span>
          <span className="truncate text-sm font-bold text-slate-900">
            {selected ? selected.name : "容器"}
          </span>
          {selected && (
            <>
              <span
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                  selected.state === "running"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-slate-200 bg-white text-slate-600"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[selected.state]}`} />
                {STATE_TEXT[selected.state]}
              </span>
              <span className="hidden truncate font-mono text-[11px] text-slate-500 lg:inline">
                {selected.image}
              </span>
            </>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {selected && (
            <>
              {selected.state === "running" ? (
                <button
                  disabled={actionLoading}
                  onClick={() => handleAction("stop")}
                  className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 transition hover:bg-amber-100 disabled:opacity-50"
                >
                  ⏹ 停止
                </button>
              ) : (
                <button
                  disabled={actionLoading}
                  onClick={() => handleAction("start")}
                  className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:opacity-50"
                >
                  ▶ 启动
                </button>
              )}
              <button
                disabled={actionLoading}
                onClick={() => handleAction("restart")}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
              >
                🔄 重启
              </button>
            </>
          )}
          <button
            onClick={() => reload()}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            {loading ? "刷新中..." : "刷新"}
          </button>
        </div>
      </div>

      {actionMsg && (
        <div className="shrink-0 border-b border-blue-100 bg-blue-50 px-3 py-1.5 text-[11px] font-medium text-blue-800">
          {actionMsg}
        </div>
      )}
      {error && (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-3 py-2 text-[11px] font-medium text-red-800">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 左侧：所有容器（路由入口） */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-[#fbfbfd]">
          <div className="shrink-0 border-b border-slate-200/70 p-2">
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索容器名称 / 镜像"
              className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder-slate-500 outline-none focus:border-apple-blue"
            />
            <div className="mt-1.5 flex items-center justify-between px-0.5 text-[10px] text-slate-500">
              <span>共 {containers.length} 个容器</span>
              <span>{containers.filter((c) => c.state === "running").length} 个运行中</span>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5 space-y-1">
            {loading && containers.length === 0 && (
              <div className="px-2 py-6 text-center text-[11px] text-slate-500">正在读取容器列表...</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="px-2 py-6 text-center text-[11px] text-slate-500">
                {containers.length === 0 ? "没有容器，可通过终端执行 docker run 启动" : "没有匹配的容器"}
              </div>
            )}
            {filtered.map((c) => {
              const active = c.id === selectedId;
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={`w-full rounded-lg border px-2 py-1.5 text-left transition ${
                    active
                      ? "border-apple-blue/40 bg-apple-blue/[0.07] shadow-apple-sm"
                      : "border-transparent hover:border-slate-200 hover:bg-white"
                  }`}
                  title={`${c.name}\n${c.image}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATE_DOT[c.state]}`} />
                    <span
                      className={`min-w-0 flex-1 truncate text-xs ${
                        active ? "font-bold text-apple-blue" : "font-medium text-slate-700"
                      }`}
                    >
                      {c.name}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate pl-3 font-mono text-[10px] text-slate-500">
                    {c.composeProject ? `${c.composeProject} · ` : ""}
                    {c.image}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* 右侧：选中容器的详情 */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-slate-500">
              <span className="text-3xl">🐳</span>
              <p className="text-xs">从左侧选择一个容器查看详情</p>
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-3 py-1.5">
                {(
                  [
                    ["overview", "概览"],
                    ["env", `环境变量 (${envList.length})`],
                    ["mounts", `挂载 (${mounts.length})`],
                    ["logs", "日志"],
                  ] as [DetailTab, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                      tab === key
                        ? "bg-apple-blue/[0.09] font-bold text-apple-blue"
                        : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <span className="ml-auto truncate font-mono text-[10px] text-slate-500">
                  {selected.status || selected.id.substring(0, 12)}
                </span>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4 text-xs">
                {tab === "logs" ? (
                  <div className="flex h-full min-h-0 flex-col gap-2">
                    <div className="flex shrink-0 items-center justify-between text-[11px] text-slate-600">
                      <span>最近 200 行标准输出与错误输出</span>
                      <button
                        onClick={() => loadLogs(selected)}
                        className="rounded-md border border-slate-300 bg-white px-2 py-0.5 font-semibold text-slate-700 hover:bg-slate-100"
                      >
                        {logsLoading ? "读取中..." : "刷新日志"}
                      </button>
                    </div>
                    <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-emerald-300 select-text">
                      {logs}
                    </pre>
                  </div>
                ) : inspectLoading && !inspectData ? (
                  <div className="py-8 text-center text-[11px] text-slate-500">正在读取容器信息...</div>
                ) : tab === "overview" ? (
                  <div className="space-y-3">
                    <section className="rounded-xl border border-slate-200 bg-slate-50/50 p-3">
                      <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-700">
                        基础信息
                      </h4>
                      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {[
                          ["容器 ID", inspectData?.Id || selected.id],
                          ["镜像", selected.image],
                          ["创建时间", inspectData?.Created || selected.created],
                          ["网络模式", inspectData?.HostConfig?.NetworkMode || "bridge"],
                          ["重启策略", inspectData?.HostConfig?.RestartPolicy?.Name || "no"],
                          ["Compose 项目", selected.composeProject || "-"],
                        ].map(([k, v]) => (
                          <div key={k as string} className="min-w-0">
                            <dt className="text-[10px] text-slate-500">{k}</dt>
                            <dd className="break-all font-mono text-[11px] text-slate-800 select-text">
                              {v || "-"}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </section>

                    <section className="rounded-xl border border-slate-200 bg-slate-50/50 p-3">
                      <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-700">
                        端口映射
                      </h4>
                      {selected.ports ? (
                        <div className="break-all rounded-lg border border-slate-200 bg-white p-2 font-mono text-[11px] text-slate-800 select-text">
                          {selected.ports}
                        </div>
                      ) : (
                        <p className="text-[11px] italic text-slate-500">未对外暴露端口</p>
                      )}
                    </section>

                    <section className="rounded-xl border border-slate-200 bg-slate-50/50 p-3">
                      <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-700">
                        入口命令
                      </h4>
                      <pre className="overflow-x-auto rounded-lg bg-slate-900 p-2.5 font-mono text-[11px] text-slate-100 select-text">
                        {Array.isArray(inspectData?.Config?.Cmd)
                          ? inspectData.Config.Cmd.join(" ")
                          : "(使用镜像默认入口)"}
                      </pre>
                    </section>
                  </div>
                ) : tab === "env" ? (
                  <div className="space-y-1.5">
                    {envList.length === 0 ? (
                      <div className="py-8 text-center text-[11px] text-slate-500">没有环境变量</div>
                    ) : (
                      envList.map(({ key, value }) => {
                        const sensitive = /pass|secret|key|token|auth|pwd/i.test(key);
                        const shown = revealEnv[key];
                        return (
                          <div
                            key={key}
                            className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-1.5 font-mono text-[11px]"
                          >
                            <div className="min-w-0 truncate">
                              <span className="font-bold text-slate-800">{key}=</span>
                              <span className="text-slate-700 select-all">
                                {sensitive && !shown ? "••••••••••" : value}
                              </span>
                            </div>
                            {sensitive && (
                              <button
                                onClick={() =>
                                  setRevealEnv((prev) => ({ ...prev, [key]: !prev[key] }))
                                }
                                className="shrink-0 text-[10px] font-semibold text-apple-blue hover:underline"
                              >
                                {shown ? "隐藏" : "显示"}
                              </button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {mounts.length === 0 ? (
                      <div className="py-8 text-center text-[11px] text-slate-500">没有挂载卷</div>
                    ) : (
                      mounts.map((m, idx) => (
                        <div
                          key={`${m.Source}-${idx}`}
                          className="space-y-1 rounded-xl border border-slate-200 bg-white p-3 shadow-apple-sm"
                        >
                          <div className="flex items-center justify-between font-semibold text-slate-800">
                            <span>{m.Type === "volume" ? "📦 数据卷" : "📁 目录挂载"}</span>
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                              {m.RW ? "读写" : "只读"}
                            </span>
                          </div>
                          <div className="break-all font-mono text-[11px] text-slate-700">
                            宿主：<span className="text-slate-900 select-all">{m.Source || "-"}</span>
                          </div>
                          <div className="break-all font-mono text-[11px] text-slate-700">
                            容器：<span className="text-apple-blue select-all">{m.Destination || "-"}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
};
