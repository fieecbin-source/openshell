import React, { useState, useEffect } from "react";
import type { Group, Session } from "../types/ipc";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useSyncStore } from "../stores/syncStore";

interface SessionTreeProps {
  onNewSession: (initialGroupId?: string) => void;
  onEditSession: (session: Session) => void;
}

export const SessionTree: React.FC<SessionTreeProps> = ({
  onNewSession,
  onEditSession,
}) => {
  const {
    sessions,
    groups,
    searchQuery,
    setSearchQuery,
    deleteSession,
    duplicateSession,
    updateSession,
    createGroup,
    deleteGroup,
    loadAll,
  } = useSessionStore();

  const { openSession } = useTerminalStore();
  const { config: syncConfig, syncing, syncNow, setModalOpen: setSyncModalOpen } = useSyncStore();

  const [activeFilter, setActiveFilter] = useState<"all" | "favorites">("all");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [showNewGroupInput, setShowNewGroupInput] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);

  // 右键上下文菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    session?: Session;
    group?: Group;
  } | null>(null);

  useEffect(() => {
    const handleGlobalClick = () => setContextMenu(null);
    window.addEventListener("click", handleGlobalClick);
    return () => window.removeEventListener("click", handleGlobalClick);
  }, []);

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
  };

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newGroupName.trim()) {
      await createGroup(newGroupName.trim());
      setNewGroupName("");
      setShowNewGroupInput(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await loadAll();
      if (syncConfig?.is_logged_in) {
        await syncNow();
      }
    } finally {
      setTimeout(() => setIsRefreshing(false), 500);
    }
  };

  const toggleFavorite = async (session: Session, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      await updateSession(session.id, { favorite: !session.favorite });
    } catch {}
  };

  // 根据当前过滤器筛选
  const filteredSessions = sessions.filter((s) => {
    if (activeFilter === "favorites" && !s.favorite) return false;
    return true;
  });

  const rootSessions = filteredSessions.filter((s) => !s.group_id);
  const sessionsByGroup: Record<string, Session[]> = {};
  for (const g of groups) {
    sessionsByGroup[g.id] = filteredSessions.filter((s) => s.group_id === g.id);
  }

  const getColorBadge = (color?: string | null) => {
    switch (color) {
      case "emerald":
        return <span className="h-1.5 w-1.5 rounded-full bg-apple-green" title="生产环境" />;
      case "sky":
        return <span className="h-1.5 w-1.5 rounded-full bg-apple-blue" title="测试环境" />;
      case "amber":
        return <span className="h-1.5 w-1.5 rounded-full bg-apple-orange" title="预发环境" />;
      case "rose":
        return <span className="h-1.5 w-1.5 rounded-full bg-apple-red" title="核心服务" />;
      case "purple":
        return <span className="h-1.5 w-1.5 rounded-full bg-apple-purple" />;
      default:
        return null;
    }
  };

  const renderSessionItem = (session: Session) => {
    // 识别同步状态
    const isDirty = (session as any).dirty || (session as any).sync?.dirty;
    const hasSyncVersion = ((session as any).version || (session as any).sync?.version || 0) > 0;

    return (
      <div
        key={session.id}
        onDoubleClick={() => openSession(session)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({ x: e.clientX, y: e.clientY, session });
        }}
        className="group flex items-center justify-between rounded-xl px-2.5 py-1.5 text-xs text-slate-700 hover:bg-black/[0.04] cursor-pointer transition select-none"
      >
        <div className="flex items-center space-x-2 truncate">
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-xs transition ${
              session.protocol === "serial"
                ? "bg-apple-purple/10 text-apple-purple border border-apple-purple/20"
                : "bg-apple-blue/10 text-apple-blue border border-apple-blue/20"
            }`}
          >
            {session.protocol === "serial" ? "🔌" : "⚡"}
          </span>

          <div className="truncate">
            <div className="font-semibold text-slate-900 truncate flex items-center gap-1.5">
              <span>{session.name}</span>
              {getColorBadge(session.color)}
              {session.favorite && (
                <span className="text-[10px] text-apple-orange">★</span>
              )}

              {/* 同步状态微型小组件指示器 */}
              {isDirty ? (
                <span
                  className="inline-flex items-center text-[9px] text-amber-600 bg-amber-50 px-1 py-0.2 rounded font-sans"
                  title="本地有待同步至云端的变更"
                >
                  ☁️待同步
                </span>
              ) : hasSyncVersion ? (
                <span
                  className="inline-flex items-center text-[9px] text-emerald-600 bg-emerald-50 px-1 py-0.2 rounded font-sans"
                  title="已与云端 E2EE 服务同步一致"
                >
                  ☁️已同步
                </span>
              ) : null}
            </div>
            <div className="text-[10px] text-slate-500 truncate font-mono">
              {session.protocol === "serial"
                ? session.protocol_options_json?.port_name || "COM1"
                : `${session.username || "root"}@${session.host || "localhost"}:${session.port || 22}`}
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition">
          <button
            onClick={(e) => toggleFavorite(session, e)}
            title={session.favorite ? "取消收藏" : "加入收藏"}
            className={`rounded-md p-1 transition ${
              session.favorite
                ? "text-apple-orange hover:text-amber-500"
                : "text-slate-400 hover:text-apple-orange"
            }`}
          >
            ★
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              openSession(session);
            }}
            title="连接会话"
            className="rounded-md p-1 text-slate-500 hover:bg-apple-blue hover:text-white transition"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEditSession(session);
            }}
            title="编辑会话"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-200 transition"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col bg-[#fbfbfd] border-r border-slate-200/80">
      {/* 顶部工具栏与同步状态指示 */}
      <div className="p-3 border-b border-slate-200/80 space-y-2">
        {/* 云端同步与快速状态条 */}
        <div className="flex items-center justify-between pb-1">
          <button
            onClick={() => setSyncModalOpen(true)}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border transition ${
              syncConfig?.is_logged_in
                ? "bg-apple-green/10 border-apple-green/30 text-emerald-700 hover:bg-apple-green/20"
                : "bg-slate-100 border-slate-200 text-slate-600 hover:bg-slate-200"
            }`}
            title="点击管理 E2EE 端到端同步设置"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${syncConfig?.is_logged_in ? "bg-apple-green animate-pulse" : "bg-slate-400"}`} />
            <span>{syncing ? "同步中..." : syncConfig?.is_logged_in ? "E2EE 同步已连接" : "云端同步未连接"}</span>
          </button>

          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="text-slate-400 hover:text-slate-700 p-1 rounded-lg hover:bg-slate-100 transition text-[11px] flex items-center gap-1"
            title="刷新会话与同步状态"
          >
            <span className={isRefreshing ? "animate-spin" : ""}>🔄</span>
            <span>刷新</span>
          </button>
        </div>

        {/* 搜索栏 */}
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索会话 (名称 / 主机)..."
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

        {/* 过滤器切换标签 (Apple Segment Control) */}
        <div className="flex bg-slate-200/70 p-0.5 rounded-lg text-[11px]">
          <button
            onClick={() => setActiveFilter("all")}
            className={`flex-1 py-1 rounded-md text-center font-medium transition ${
              activeFilter === "all"
                ? "bg-white text-slate-900 font-semibold shadow-apple-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            全部 ({sessions.length})
          </button>
          <button
            onClick={() => setActiveFilter("favorites")}
            className={`flex-1 py-1 rounded-md text-center font-medium transition flex items-center justify-center gap-1 ${
              activeFilter === "favorites"
                ? "bg-white text-apple-orange font-semibold shadow-apple-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <span>★ 收藏</span>
            <span>({sessions.filter((s) => s.favorite).length})</span>
          </button>
        </div>

        {/* 新建会话与新建分组按钮 */}
        <div className="flex items-center space-x-1.5 pt-0.5">
          <button
            onClick={() => onNewSession()}
            className="flex-1 flex items-center justify-center space-x-1.5 rounded-xl bg-apple-blue py-1.5 text-xs font-semibold text-white shadow-apple-sm hover:bg-apple-hoverBlue transition"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>新建会话</span>
          </button>
          <button
            onClick={() => setShowNewGroupInput(true)}
            title="新建分组"
            className="rounded-xl border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900 shadow-apple-sm transition"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            </svg>
          </button>
        </div>

        {showNewGroupInput && (
          <form onSubmit={handleCreateGroup} className="mt-2 flex items-center space-x-1 animate-in fade-in">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="新分组名称..."
              autoFocus
              className="flex-1 rounded-xl border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-900 focus:outline-none focus:border-apple-blue focus:ring-1 focus:ring-apple-blue"
            />
            <button
              type="submit"
              className="rounded-xl bg-apple-blue px-2.5 py-1 text-xs text-white font-medium hover:bg-apple-hoverBlue"
            >
              确定
            </button>
            <button
              type="button"
              onClick={() => setShowNewGroupInput(false)}
              className="rounded-xl border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
            >
              取消
            </button>
          </form>
        )}
      </div>

      {/* 会话树列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {groups.map((group) => {
          const groupSessions = sessionsByGroup[group.id] || [];
          const isCollapsed = collapsedGroups[group.id];

          if (activeFilter === "favorites" && groupSessions.length === 0) {
            return null;
          }

          return (
            <div key={group.id} className="space-y-0.5">
              <div
                onClick={() => toggleGroup(group.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY, group });
                }}
                className="group flex items-center justify-between rounded-xl px-2 py-1.5 text-xs font-semibold text-slate-700 hover:bg-black/[0.04] cursor-pointer select-none transition"
              >
                <div className="flex items-center space-x-1.5 truncate">
                  <span className="text-[10px] text-slate-400 transition-transform duration-150 inline-block">
                    {isCollapsed ? "▶" : "▼"}
                  </span>
                  <svg className="h-3.5 w-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <span className="truncate">{group.name}</span>
                  <span className="text-[10px] text-slate-400 font-normal">
                    ({groupSessions.length})
                  </span>
                </div>

                <div className="opacity-0 group-hover:opacity-100 flex items-center space-x-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewSession(group.id);
                    }}
                    className="text-slate-500 hover:text-apple-blue p-0.5 text-xs transition"
                    title="在此分组下新建会话"
                  >
                    +
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`确认删除分组 "${group.name}" 吗？分组内会话将移至根目录。`)) {
                        deleteGroup(group.id);
                      }
                    }}
                    className="text-slate-500 hover:text-apple-red p-0.5 transition"
                    title="删除分组"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {!isCollapsed && (
                <div className="pl-3 space-y-0.5 border-l border-slate-200 ml-2.5">
                  {groupSessions.map(renderSessionItem)}
                </div>
              )}
            </div>
          );
        })}

        {rootSessions.length > 0 && (
          <div className="pt-1 space-y-0.5">
            {groups.length > 0 && (
              <div className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                未分组会话
              </div>
            )}
            {rootSessions.map(renderSessionItem)}
          </div>
        )}

        {filteredSessions.length === 0 && (
          <div className="flex flex-col items-center justify-center p-8 text-center text-slate-400">
            <div className="text-3xl mb-2 opacity-60">💻</div>
            <p className="text-xs font-medium text-slate-600 mb-1">
              {activeFilter === "favorites" ? "暂无收藏的会话" : "暂无保存的会话"}
            </p>
            <p className="text-[11px] text-slate-400 mb-3">
              点击下方按钮快速配置新连接
            </p>
            <button
              onClick={() => onNewSession()}
              className="text-xs text-apple-blue hover:underline font-semibold"
            >
              + 立即新建会话
            </button>
          </div>
        )}
      </div>

      {/* 右键浮动上下文菜单 (Apple macOS Menu Style) */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[160px] rounded-2xl border border-black/10 bg-white/95 py-1.5 text-xs shadow-apple-xl backdrop-blur-xl animate-in fade-in duration-100"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.session && (
            <>
              <button
                onClick={() => {
                  if (contextMenu.session) openSession(contextMenu.session);
                  setContextMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left text-slate-800 hover:bg-apple-blue hover:text-white flex items-center gap-2 transition"
              >
                <span>⚡</span>
                <span className="font-medium">连接会话</span>
              </button>
              <button
                onClick={() => {
                  if (contextMenu.session) onEditSession(contextMenu.session);
                  setContextMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left text-slate-800 hover:bg-slate-100 flex items-center gap-2 transition"
              >
                <span>✏️</span>
                <span>编辑配置</span>
              </button>
              <button
                onClick={() => {
                  if (contextMenu.session) duplicateSession(contextMenu.session.id);
                  setContextMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left text-slate-800 hover:bg-slate-100 flex items-center gap-2 transition"
              >
                <span>📋</span>
                <span>克隆副本</span>
              </button>
              <button
                onClick={() => {
                  if (contextMenu.session) toggleFavorite(contextMenu.session);
                  setContextMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left text-slate-800 hover:bg-slate-100 flex items-center gap-2 transition"
              >
                <span>★</span>
                <span>{contextMenu.session.favorite ? "取消收藏" : "设为收藏"}</span>
              </button>
              <div className="my-1 border-t border-slate-100" />
              <button
                onClick={() => {
                  if (contextMenu.session && confirm(`确认删除会话 "${contextMenu.session.name}" 吗？`)) {
                    deleteSession(contextMenu.session.id);
                  }
                  setContextMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left text-apple-red hover:bg-red-50 flex items-center gap-2 transition"
              >
                <span>🗑️</span>
                <span>删除会话</span>
              </button>
            </>
          )}

          {contextMenu.group && (
            <>
              <button
                onClick={() => {
                  if (contextMenu.group) onNewSession(contextMenu.group.id);
                  setContextMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left text-slate-800 hover:bg-apple-blue hover:text-white flex items-center gap-2 transition"
              >
                <span>➕</span>
                <span className="font-medium">在此分组新建会话</span>
              </button>
              <button
                onClick={() => {
                  if (contextMenu.group) {
                    const newName = prompt("请输入新分组名称：", contextMenu.group.name);
                    if (newName && newName.trim()) {
                      useSessionStore.getState().renameGroup(contextMenu.group.id, newName.trim());
                    }
                  }
                  setContextMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left text-slate-800 hover:bg-slate-100 flex items-center gap-2 transition"
              >
                <span>✏️</span>
                <span>重命名分组</span>
              </button>
              <div className="my-1 border-t border-slate-100" />
              <button
                onClick={() => {
                  if (contextMenu.group && confirm(`确认删除分组 "${contextMenu.group.name}" 吗？分组内会话将移至根目录。`)) {
                    deleteGroup(contextMenu.group.id);
                  }
                  setContextMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left text-apple-red hover:bg-red-50 flex items-center gap-2 transition"
              >
                <span>🗑️</span>
                <span>删除分组</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
