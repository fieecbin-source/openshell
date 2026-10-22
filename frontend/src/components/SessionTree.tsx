import React, { useState, useEffect } from "react";
import type { Group, Session } from "../types/ipc";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalStore } from "../stores/terminalStore";

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
  } = useSessionStore();

  const { openSession } = useTerminalStore();

  const [activeFilter, setActiveFilter] = useState<"all" | "favorites">("all");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [showNewGroupInput, setShowNewGroupInput] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");

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
        return <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" title="生产环境" />;
      case "sky":
        return <span className="h-1.5 w-1.5 rounded-full bg-sky-400" title="测试环境" />;
      case "amber":
        return <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="预发环境" />;
      case "rose":
        return <span className="h-1.5 w-1.5 rounded-full bg-rose-400" title="核心服务" />;
      case "purple":
        return <span className="h-1.5 w-1.5 rounded-full bg-purple-400" />;
      default:
        return null;
    }
  };

  const renderSessionItem = (session: Session) => (
    <div
      key={session.id}
      onDoubleClick={() => openSession(session)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY, session });
      }}
      className="group flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-slate-300 hover:bg-surface-800 hover:text-white cursor-pointer transition select-none"
    >
      <div className="flex items-center space-x-2 truncate">
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs transition ${
            session.protocol === "serial"
              ? "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20"
              : "bg-surface-800 text-slate-400 group-hover:bg-emerald-500/20 group-hover:text-emerald-400"
          }`}
        >
          {session.protocol === "serial" ? "🔌" : "⚡"}
        </span>

        <div className="truncate">
          <div className="font-medium truncate flex items-center gap-1.5">
            <span>{session.name}</span>
            {getColorBadge(session.color)}
            {session.favorite && (
              <span className="text-[10px] text-amber-400">★</span>
            )}
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
          className={`rounded p-1 transition ${
            session.favorite
              ? "text-amber-400 hover:text-amber-300"
              : "text-slate-500 hover:text-amber-400"
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
          className="rounded p-1 text-slate-400 hover:bg-emerald-600 hover:text-white"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEditSession(session);
          }}
          title="编辑会话"
          className="rounded p-1 text-slate-400 hover:bg-surface-700 hover:text-white"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-surface-900 border-r border-surface-800">
      {/* 搜索与工具栏 */}
      <div className="p-3 border-b border-surface-800">
        <div className="relative mb-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索会话 (名称/主机)..."
            className="w-full rounded-lg border border-surface-800 bg-surface-950 pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
          />
          <svg
            className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        {/* 过滤器切换标签与新建按钮 */}
        <div className="flex items-center space-x-1.5 mb-2">
          <div className="flex-1 flex bg-surface-950 p-0.5 rounded-lg border border-surface-800 text-[11px]">
            <button
              onClick={() => setActiveFilter("all")}
              className={`flex-1 py-1 rounded text-center font-medium transition ${
                activeFilter === "all"
                  ? "bg-surface-800 text-white font-bold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              全部 ({sessions.length})
            </button>
            <button
              onClick={() => setActiveFilter("favorites")}
              className={`flex-1 py-1 rounded text-center font-medium transition flex items-center justify-center gap-1 ${
                activeFilter === "favorites"
                  ? "bg-amber-500/20 text-amber-300 font-bold"
                  : "text-slate-400 hover:text-amber-400"
              }`}
            >
              <span>★ 收藏</span>
              <span>({sessions.filter((s) => s.favorite).length})</span>
            </button>
          </div>
        </div>

        <div className="flex items-center space-x-1.5">
          <button
            onClick={() => onNewSession()}
            className="flex-1 flex items-center justify-center space-x-1 rounded-lg bg-emerald-600/90 py-1.5 text-xs font-semibold text-white shadow hover:bg-emerald-500 transition"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>新建会话</span>
          </button>
          <button
            onClick={() => setShowNewGroupInput(true)}
            title="新建分组"
            className="rounded-lg border border-surface-800 bg-surface-850 p-1.5 text-slate-400 hover:text-white hover:bg-surface-800 transition"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            </svg>
          </button>
        </div>

        {showNewGroupInput && (
          <form onSubmit={handleCreateGroup} className="mt-2 flex items-center space-x-1">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="新分组名称..."
              autoFocus
              className="flex-1 rounded border border-surface-700 bg-surface-950 px-2 py-1 text-xs text-white focus:outline-none focus:border-emerald-500"
            />
            <button
              type="submit"
              className="rounded bg-emerald-600 px-2 py-1 text-xs text-white"
            >
              确定
            </button>
            <button
              type="button"
              onClick={() => setShowNewGroupInput(false)}
              className="rounded bg-surface-800 px-2 py-1 text-xs text-slate-400"
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
                className="group flex items-center justify-between rounded-md px-2 py-1 text-xs font-semibold text-slate-400 hover:bg-surface-800 hover:text-slate-200 cursor-pointer select-none transition"
              >
                <div className="flex items-center space-x-1.5 truncate">
                  <span className="text-[10px] text-slate-500 transition-transform duration-150 inline-block">
                    {isCollapsed ? "▶" : "▼"}
                  </span>
                  <svg className="h-3.5 w-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <span className="truncate">{group.name}</span>
                  <span className="text-[10px] text-slate-600 font-normal">
                    ({groupSessions.length})
                  </span>
                </div>

                <div className="opacity-0 group-hover:opacity-100 flex items-center space-x-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewSession(group.id);
                    }}
                    className="text-slate-500 hover:text-emerald-400 p-0.5 text-xs transition"
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
                    className="text-slate-500 hover:text-red-400 p-0.5 transition"
                    title="删除分组"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {!isCollapsed && (
                <div className="pl-3 space-y-0.5 border-l border-surface-800 ml-2.5">
                  {groupSessions.map(renderSessionItem)}
                </div>
              )}
            </div>
          );
        })}

        {rootSessions.length > 0 && (
          <div className="pt-1 space-y-0.5">
            {groups.length > 0 && (
              <div className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                未分组会话
              </div>
            )}
            {rootSessions.map(renderSessionItem)}
          </div>
        )}

        {filteredSessions.length === 0 && (
          <div className="flex flex-col items-center justify-center p-6 text-center text-slate-500">
            <svg className="h-8 w-8 mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <p className="text-xs">
              {activeFilter === "favorites" ? "暂无收藏的会话" : "暂无保存的会话"}
            </p>
            <button
              onClick={() => onNewSession()}
              className="mt-2 text-xs text-emerald-400 hover:underline"
            >
              点击立即添加
            </button>
          </div>
        )}
      </div>

      {/* 右键浮动上下文菜单 */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[150px] rounded-xl border border-surface-700 bg-surface-900/95 py-1.5 text-xs shadow-2xl backdrop-blur-md"
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
                className="w-full px-3 py-1.5 text-left text-slate-200 hover:bg-emerald-600 hover:text-white flex items-center gap-2"
              >
                <span>⚡</span>
                <span>连接会话</span>
              </button>
              <button
                onClick={() => {
                  if (contextMenu.session) onEditSession(contextMenu.session);
                  setContextMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left text-slate-200 hover:bg-surface-800 flex items-center gap-2"
              >
                <span>✏️</span>
                <span>编辑属性</span>
              </button>
              <button
                onClick={() => {
                  if (contextMenu.session) duplicateSession(contextMenu.session.id);
                  setContextMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left text-slate-200 hover:bg-surface-800 flex items-center gap-2"
              >
                <span>📋</span>
                <span>克隆副本</span>
              </button>
              <button
                onClick={() => {
                  if (contextMenu.session) toggleFavorite(contextMenu.session);
                  setContextMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left text-slate-200 hover:bg-surface-800 flex items-center gap-2"
              >
                <span>★</span>
                <span>{contextMenu.session.favorite ? "取消收藏" : "设为收藏"}</span>
              </button>
              <div className="my-1 border-t border-surface-800" />
              <button
                onClick={() => {
                  if (contextMenu.session && confirm(`确认删除会话 "${contextMenu.session.name}" 吗？`)) {
                    deleteSession(contextMenu.session.id);
                  }
                  setContextMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left text-rose-400 hover:bg-rose-600 hover:text-white flex items-center gap-2"
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
                className="w-full px-3 py-1.5 text-left text-slate-200 hover:bg-emerald-600 hover:text-white flex items-center gap-2"
              >
                <span>➕</span>
                <span>在此分组新建会话</span>
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
                className="w-full px-3 py-1.5 text-left text-slate-200 hover:bg-surface-800 flex items-center gap-2"
              >
                <span>✏️</span>
                <span>重命名分组</span>
              </button>
              <div className="my-1 border-t border-surface-800" />
              <button
                onClick={() => {
                  if (contextMenu.group && confirm(`确认删除分组 "${contextMenu.group.name}" 吗？分组内会话将移至根目录。`)) {
                    deleteGroup(contextMenu.group.id);
                  }
                  setContextMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left text-rose-400 hover:bg-rose-600 hover:text-white flex items-center gap-2"
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
