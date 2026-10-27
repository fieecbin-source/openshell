import React, { useState } from "react";
import type { Session } from "../types/ipc";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalStore } from "../stores/terminalStore";

interface HomeHubProps {
  onNewSession: (groupId?: string) => void;
  onEditSession: (session: Session) => void;
  onConnectSession: (session: Session) => void;
  onPortCheckerOpen?: (host?: string, port?: number) => void;
}

export const HomeHub: React.FC<HomeHubProps> = ({
  onNewSession,
  onEditSession,
  onConnectSession,
  onPortCheckerOpen,
}) => {
  const { sessions, groups, deleteSession } = useSessionStore();
  const { tabs, setActiveTab } = useTerminalStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<string | "all" | "favorites">("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [deletingSession, setDeletingSession] = useState<Session | null>(null);

  // 过滤会话
  const filteredSessions = sessions.filter((s) => {
    // 分组过滤
    if (selectedGroupId === "favorites") {
      if (!s.favorite) return false;
    } else if (selectedGroupId !== "all") {
      if (s.group_id !== selectedGroupId) return false;
    }

    // 搜索过滤
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const nameMatch = s.name.toLowerCase().includes(q);
    const hostMatch = (s.host || "").toLowerCase().includes(q);
    const userMatch = (s.username || "").toLowerCase().includes(q);
    return nameMatch || hostMatch || userMatch;
  });

  return (
    <div className="flex-1 h-full flex flex-col bg-[#fbfbfd] overflow-hidden select-none">
      {/* 顶部主横幅与快速控制栏 */}
      <div className="p-6 border-b border-slate-200/80 bg-white/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-2xl">🖥️</span>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">管理中心</h1>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 font-mono">
                {sessions.length} 台主机
              </span>
            </div>
          </div>

          {/* 核心入口：醒目的大号“新建连接”按钮与快捷工具 */}
          <div className="flex items-center gap-3">
            {onPortCheckerOpen && (
              <button
                onClick={() => onPortCheckerOpen()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-700 text-xs font-semibold hover:bg-slate-50 transition shadow-apple-sm"
                title="快速探测端口连通性"
              >
                <span>🔍 端口探测</span>
              </button>
            )}
            <button
              onClick={() => onNewSession(selectedGroupId !== "all" && selectedGroupId !== "favorites" ? selectedGroupId : undefined)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-apple-blue text-white text-xs font-semibold shadow-apple-md hover:bg-apple-hoverBlue active:scale-98 transition transform duration-150"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
              </svg>
              <span>+ 新建连接</span>
            </button>
          </div>
        </div>

        {/* 筛选与搜索工具条 */}
        <div className="max-w-6xl mx-auto mt-5 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          {/* 分组筛选标签胶囊 */}
          <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
            <button
              onClick={() => setSelectedGroupId("all")}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                selectedGroupId === "all"
                  ? "bg-slate-900 text-white font-semibold shadow-apple-sm"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/70"
              }`}
            >
              全部 ({sessions.length})
            </button>
            <button
              onClick={() => setSelectedGroupId("favorites")}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition flex items-center gap-1 ${
                selectedGroupId === "favorites"
                  ? "bg-amber-500 text-white font-semibold shadow-apple-sm"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/70"
              }`}
            >
              <span>⭐ 收藏</span>
            </button>
            {groups.map((g) => {
              const count = sessions.filter((s) => s.group_id === g.id).length;
              return (
                <button
                  key={g.id}
                  onClick={() => setSelectedGroupId(g.id)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                    selectedGroupId === g.id
                      ? "bg-apple-blue text-white font-semibold shadow-apple-sm"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200/70"
                  }`}
                >
                  {g.name} ({count})
                </button>
              );
            })}
          </div>

          {/* 搜索框与网格/列表切换 */}
          <div className="flex items-center gap-2">
            <div className="relative min-w-[220px]">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="快速搜索机器、IP 或用户..."
                className="w-full rounded-xl border border-slate-200 bg-white pl-8 pr-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 focus:border-apple-blue focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition shadow-apple-sm"
              />
              <svg
                className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>

            <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
              <button
                onClick={() => setViewMode("grid")}
                className={`p-1 rounded transition ${viewMode === "grid" ? "bg-white text-slate-900 shadow-apple-sm" : "text-slate-500 hover:text-slate-800"}`}
                title="网格卡片视图"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                </svg>
              </button>
              <button
                onClick={() => setViewMode("list")}
                className={`p-1 rounded transition ${viewMode === "list" ? "bg-white text-slate-900 shadow-apple-sm" : "text-slate-500 hover:text-slate-800"}`}
                title="列表表格视图"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 主体卡片网格 / 列表区 */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-6xl mx-auto">
          {filteredSessions.length === 0 ? (
            <div className="p-12 text-center rounded-2xl border border-dashed border-slate-300 bg-white shadow-apple-sm space-y-3 mt-4">
              <div className="text-4xl mb-1">🖥️ ⚡</div>
              <h3 className="text-base font-bold text-slate-800">
                {sessions.length === 0 ? "还没有配置任何服务器连接" : "未找到匹配的机器"}
              </h3>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                {sessions.length === 0
                  ? "OpenShell 支持一键保存 SSH 主机、串口设备。新建完成后，即可随时点击卡片发起极速免密或密码连接。"
                  : "尝试清空搜索关键字或切换分组标签。"}
              </p>
              {sessions.length === 0 && (
                <button
                  onClick={() => onNewSession()}
                  className="mt-2 px-5 py-2 rounded-xl bg-apple-blue text-white text-xs font-semibold shadow-apple-md hover:bg-apple-hoverBlue transition"
                >
                  + 新建第一台机器连接
                </button>
              )}
            </div>
          ) : viewMode === "grid" ? (
            /* 网格卡片视图 (Apple Design Machine Cards) */
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredSessions.map((s) => {
                const activeTab = tabs.find((t) => t.sessionId === s.id);
                const isConnected = activeTab && activeTab.status === "connected";
                const isPublicKey = s.auth_method === "publickey" || s.auth_method === "public_key";

                return (
                  <div
                    key={s.id}
                    onClick={() => {
                      if (activeTab) {
                        setActiveTab(activeTab.tabId);
                      } else {
                        onConnectSession(s);
                      }
                    }}
                    className={`group relative p-4 rounded-2xl border transition-all duration-200 cursor-pointer bg-white hover:shadow-apple-md hover:-translate-y-0.5 ${
                      isConnected
                        ? "border-emerald-300 ring-2 ring-emerald-500/10 shadow-apple-sm"
                        : "border-slate-200/90 hover:border-apple-blue/50"
                    }`}
                  >
                    {/* 卡片头部：状态与快捷操作 */}
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                            isConnected ? "bg-emerald-500 shadow-apple-sm animate-pulse" : "bg-slate-300"
                          }`}
                        />
                        <span className="font-bold text-sm text-slate-900 group-hover:text-apple-blue transition truncate max-w-[160px]">
                          {s.name}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100 transition">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onEditSession(s);
                          }}
                          className="p-1 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition"
                          title="编辑机器配置"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeletingSession(s);
                          }}
                          className="p-1 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                          title="删除机器"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {/* 主机信息与端口 */}
                    <div className="space-y-1.5 mb-3 font-mono text-xs">
                      {s.protocol === "serial" ? (
                        <div className="text-slate-700 flex items-center gap-1.5">
                          <span className="text-[10px] bg-purple-50 text-purple-700 border border-purple-200 px-1 rounded font-bold">
                            SERIAL
                          </span>
                          <span className="font-semibold">{s.protocol_options_json?.port_name || "COM1"}</span>
                          <span className="text-slate-400">@{s.protocol_options_json?.baud_rate || 115200}</span>
                        </div>
                      ) : (
                        <div className="text-slate-700 flex items-center gap-1.5">
                          <span className="text-[10px] bg-blue-50 text-apple-blue border border-blue-200 px-1 rounded font-bold">
                            SSH
                          </span>
                          <span className="text-slate-500">{s.username || "root"}@</span>
                          <span className="font-semibold text-slate-800">{s.host || "127.0.0.1"}</span>
                          <span className="text-slate-400">:{s.port || 22}</span>
                        </div>
                      )}
                    </div>

                    {/* 属性标签区 */}
                    <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-medium text-slate-500 mb-3">
                      {isPublicKey ? (
                        <span className="rounded bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 flex items-center gap-0.5">
                          <span>🛡️ 密钥认证</span>
                        </span>
                      ) : (
                        <span className="rounded bg-slate-100 text-slate-600 px-1.5 py-0.5 flex items-center gap-0.5">
                          <span>🔑 密码认证</span>
                        </span>
                      )}

                      {s.notes && (
                        <span className="rounded bg-slate-100 text-slate-500 px-1.5 py-0.5 truncate max-w-[120px]">
                          {s.notes}
                        </span>
                      )}
                    </div>

                    {/* 底部卡片直接连接动作按钮 */}
                    <div className="pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs">
                      {isConnected ? (
                        <span className="text-[11px] font-bold text-emerald-600 flex items-center gap-1">
                          <span>● 会话进行中</span>
                          <span className="text-slate-400 font-normal">(点击切入终端)</span>
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-400 group-hover:text-apple-blue transition flex items-center gap-1">
                          <span>⚡ 点击极速连接</span>
                        </span>
                      )}
                      <span className="text-apple-blue font-bold group-hover:translate-x-0.5 transition transform">
                        →
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* 紧凑列表表格视图 */
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-apple-sm">
              <table className="w-full text-left text-xs text-slate-700">
                <thead className="bg-slate-50/80 border-b border-slate-200 text-slate-500 font-semibold text-[11px]">
                  <tr>
                    <th className="py-2.5 px-4">状态</th>
                    <th className="py-2.5 px-4">机器别名</th>
                    <th className="py-2.5 px-4">主机 / 端口</th>
                    <th className="py-2.5 px-4">认证方式</th>
                    <th className="py-2.5 px-4 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredSessions.map((s) => {
                    const activeTab = tabs.find((t) => t.sessionId === s.id);
                    const isConnected = activeTab && activeTab.status === "connected";
                    return (
                      <tr
                        key={s.id}
                        onClick={() => {
                          if (activeTab) setActiveTab(activeTab.tabId);
                          else onConnectSession(s);
                        }}
                        className="hover:bg-slate-50 transition cursor-pointer"
                      >
                        <td className="py-2.5 px-4">
                          <span
                            className={`h-2.5 w-2.5 rounded-full inline-block ${
                              isConnected ? "bg-emerald-500 animate-pulse" : "bg-slate-300"
                            }`}
                          />
                        </td>
                        <td className="py-2.5 px-4 font-bold text-slate-900">{s.name}</td>
                        <td className="py-2.5 px-4 font-mono text-slate-600">
                          {s.protocol === "serial" ? (
                            `${s.protocol_options_json?.port_name || "COM1"} @ ${s.protocol_options_json?.baud_rate || 115200}`
                          ) : (
                            `${s.username || "root"}@${s.host || "127.0.0.1"}:${s.port || 22}`
                          )}
                        </td>
                        <td className="py-2.5 px-4">
                          {s.auth_method === "publickey" || s.auth_method === "public_key" ? (
                            <span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded font-mono text-[10px]">
                              🛡️ 密钥
                            </span>
                          ) : (
                            <span className="text-slate-600 bg-slate-100 px-2 py-0.5 rounded font-mono text-[10px]">
                              🔑 密码
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-right space-x-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onEditSession(s);
                            }}
                            className="px-2 py-1 rounded hover:bg-slate-200 text-slate-600 transition"
                          >
                            编辑
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeletingSession(s);
                            }}
                            className="px-2 py-1 rounded hover:bg-red-50 text-red-600 transition"
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 删除机器确认弹窗 */}
      {deletingSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-xs p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl p-5 shadow-2xl border border-slate-200 space-y-3">
            <h4 className="text-sm font-bold text-slate-900">确认删除该机器？</h4>
            <p className="text-xs text-slate-600">
              即将删除机器配置 <strong className="text-slate-900">{deletingSession.name}</strong>。此操作不可恢复。
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setDeletingSession(null)}
                className="px-3.5 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  await deleteSession(deletingSession.id);
                  setDeletingSession(null);
                }}
                className="px-3.5 py-1.5 rounded-xl bg-red-600 text-white text-xs font-semibold hover:bg-red-700 transition"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
