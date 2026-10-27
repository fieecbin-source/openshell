import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Group, Session } from "../types/ipc";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useSyncStore } from "../stores/syncStore";
import { toast } from "../stores/toastStore";
import { formatFriendlyError } from "../lib/errors";
import { moveGroup as moveGroupApi } from "../lib/ipc";
import {
  buildGroupTree,
  countSessions,
  sortOrderForIndex,
  wouldCreateCycle,
} from "../lib/groupTree";
import { SessionTreeNode, type DragPayload, type TreeApi } from "./SessionTreeNode";

interface SessionTreeProps {
  onNewSession: (initialGroupId?: string) => void;
  onEditSession: (session: Session) => void;
}

type FilterKind = "all" | "favorites" | "recent";

const RECENT_LIMIT = 8;
/** 未分组区域在拖拽高亮时使用的伪 group id */
const ROOT_DROP_ID = "__root__";

function getColorBadge(color?: string | null) {
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
}

const MenuItem: React.FC<{
  icon: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}> = ({ icon, label, onClick, danger }) => (
  <button
    onClick={onClick}
    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition ${
      danger ? "text-apple-red hover:bg-red-50" : "text-slate-800 hover:bg-slate-100"
    }`}
  >
    <span>{icon}</span>
    <span>{label}</span>
  </button>
);

export const SessionTree: React.FC<SessionTreeProps> = ({ onNewSession, onEditSession }) => {
  const {
    sessions,
    groups,
    searchQuery,
    setSearchQuery,
    deleteSession,
    duplicateSession,
    updateSession,
    createGroup,
    renameGroup,
    deleteGroup,
    loadAll,
  } = useSessionStore();

  const { openSession, tabs, setActiveTab, setLayoutMode } = useTerminalStore();
  const { config: syncConfig, syncing, syncNow, setModalOpen: setSyncModalOpen } = useSyncStore();

  const [activeFilter, setActiveFilter] = useState<FilterKind>("all");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [showNewGroupInput, setShowNewGroupInput] = useState(false);
  const [newGroupParentId, setNewGroupParentId] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);

  // 拖拽状态：正在拖拽的元素 + 当前高亮的放置目标
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null);
  const [dropTargetSessionId, setDropTargetSessionId] = useState<string | null>(null);

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

  // ---------- 数据派生（必须先于使用它的回调计算） ----------

  const filteredSessions = useMemo(() => {
    if (activeFilter === "favorites") return sessions.filter((s) => s.favorite);
    if (activeFilter === "recent") return sessions.filter((s) => (s.last_used_at ?? 0) > 0);
    return sessions;
  }, [sessions, activeFilter]);

  const tree = useMemo(() => buildGroupTree(groups, filteredSessions), [groups, filteredSessions]);

  const recentSessions = useMemo(
    () =>
      sessions
        .filter((s) => (s.last_used_at ?? 0) > 0)
        .sort((a, b) => (b.last_used_at ?? 0) - (a.last_used_at ?? 0))
        .slice(0, RECENT_LIMIT),
    [sessions]
  );

  // 搜索/筛选状态下隐藏空分组，避免整屏都是空文件夹
  const hideEmptyGroups = searchQuery.trim().length > 0 || activeFilter !== "all";
  const visibleRoots = useMemo(
    () => (hideEmptyGroups ? tree.roots.filter((n) => countSessions(n) > 0) : tree.roots),
    [tree.roots, hideEmptyGroups]
  );

  // ---------- 基础操作 ----------

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newGroupName.trim();
    if (!name) return;
    try {
      await createGroup(name, newGroupParentId);
      setNewGroupName("");
      setShowNewGroupInput(false);
      setNewGroupParentId(null);
    } catch (err) {
      toast.error("创建分组失败", formatFriendlyError(err));
    }
  };

  const handleRenameGroup = async (group: Group) => {
    const newName = prompt("请输入新分组名称：", group.name);
    if (!newName || !newName.trim()) return;
    try {
      await renameGroup(group.id, newName.trim());
    } catch (err) {
      toast.error("重命名分组失败", formatFriendlyError(err));
    }
  };

  const handleDeleteGroup = async (group: Group) => {
    if (!confirm(`确认删除分组 "${group.name}" 吗？分组内会话与子分组将移至根目录。`)) return;
    try {
      await deleteGroup(group.id);
    } catch (err) {
      toast.error("删除分组失败", formatFriendlyError(err));
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
    } catch (err) {
      toast.error("更新收藏失败", formatFriendlyError(err));
    }
  };

  /** 连接会话：若该会话已有标签则直接切换过去，避免重复开标签 / 重复开 shell */
  const connect = async (session: Session) => {
    const existing = tabs.find((t) => t.sessionId === session.id);
    if (existing) {
      setActiveTab(existing.tabId);
      return;
    }
    try {
      await openSession(session);
    } catch (err) {
      toast.error(`连接 ${session.name} 失败`, formatFriendlyError(err));
    }
  };

  /**
   * 打开会话并切到全屏 SFTP。
   *
   * 这里不再使用视图卡的 `switchMode("view")`（那只是改了个状态位，
   * 实际界面仍是终端，等于点了没反应）。统一驱动顶栏那套 layoutMode，
   * 保证全应用只有一套 SFTP 视图。
   */
  const openSftp = async (session: Session) => {
    const existing = tabs.find((t) => t.sessionId === session.id);
    if (existing) {
      setActiveTab(existing.tabId);
      setLayoutMode("sftp");
      return;
    }
    try {
      await openSession(session);
      setLayoutMode("sftp");
    } catch (err) {
      toast.error("打开 SFTP 视图失败", formatFriendlyError(err));
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制${label}`, text);
    } catch (err) {
      toast.error("复制失败", formatFriendlyError(err));
    }
  };

  // ---------- 拖拽落库 ----------

  const moveSessionTo = useCallback(
    async (sessionId: string, targetGroupId: string | null, beforeSessionId?: string) => {
      const siblings = sessions
        .filter((s) => (s.group_id ?? null) === targetGroupId && s.id !== sessionId)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

      let index = siblings.length;
      if (beforeSessionId) {
        const idx = siblings.findIndex((s) => s.id === beforeSessionId);
        if (idx >= 0) index = idx;
      }

      const computed = sortOrderForIndex(
        siblings.map((s) => s.sort_order ?? 0),
        index
      );
      // 间隙耗尽（同组内排序值过于密集）时退化为按位置取值：
      // 视觉顺序仍然正确，后续拖拽会自然把间距重新拉开。
      const order = computed ?? (index + 1) * 1024;

      try {
        await updateSession(sessionId, { group_id: targetGroupId, sort_order: order });
        if (computed === null) {
          toast.info("该分组内排序间隙已用尽", "已按落点重新插入，可再次拖动微调顺序");
        }
      } catch (err) {
        toast.error("移动会话失败", formatFriendlyError(err));
      }
    },
    [sessions, updateSession]
  );

  const moveGroupTo = useCallback(
    async (groupId: string, targetParentId: string | null) => {
      // 后端也有成环校验，这里先即时拦截一次，避免无谓的 IPC 往返
      if (wouldCreateCycle(tree, groupId, targetParentId)) {
        toast.warning("不能把分组移动到它自己或它的子分组里");
        return;
      }
      const siblings = groups.filter(
        (g) => (g.parent_id ?? null) === targetParentId && g.id !== groupId
      );
      const order = siblings.reduce((max, g) => Math.max(max, g.sort_order ?? 0), 0) + 1024;
      try {
        await moveGroupApi(groupId, targetParentId, order);
        await loadAll();
      } catch (err) {
        toast.error("移动分组失败", formatFriendlyError(err));
      }
    },
    [groups, loadAll, tree]
  );

  const beginDrag = useCallback((e: React.DragEvent, payload: DragPayload) => {
    e.dataTransfer.effectAllowed = "move";
    // 某些平台要求设置数据后才会持续触发 drag 事件
    e.dataTransfer.setData("text/plain", `${payload.kind}:${payload.id}`);
    setDragPayload(payload);
  }, []);

  const endDrag = useCallback(() => {
    setDragPayload(null);
    setHoveredGroupId(null);
    setDropTargetSessionId(null);
  }, []);

  const dropOnGroup = useCallback(
    (targetGroupId: string | null) => {
      const payload = dragPayload;
      endDrag();
      if (!payload) return;
      if (payload.kind === "session") {
        void moveSessionTo(payload.id, targetGroupId);
      } else if (payload.id !== targetGroupId) {
        void moveGroupTo(payload.id, targetGroupId);
      }
    },
    [dragPayload, endDrag, moveGroupTo, moveSessionTo]
  );

  const dropOnSession = useCallback(
    (target: Session) => {
      const payload = dragPayload;
      endDrag();
      if (!payload) return;
      if (payload.kind === "session") {
        if (payload.id === target.id) return;
        void moveSessionTo(payload.id, target.group_id ?? null, target.id);
      } else {
        void moveGroupTo(payload.id, target.group_id ?? null);
      }
    },
    [dragPayload, endDrag, moveGroupTo, moveSessionTo]
  );

  const openContextMenu = useCallback(
    (e: React.MouseEvent, payload: { group?: Group; session?: Session }) => {
      setContextMenu({ x: e.clientX, y: e.clientY, ...payload });
    },
    []
  );

  // ---------- 会话行渲染（函数声明以支持向上引用） ----------

  function renderSession(session: Session) {
    const isDirty = (session as any).dirty || (session as any).sync?.dirty;
    const hasSyncVersion = ((session as any).version || (session as any).sync?.version || 0) > 0;
    const isDropTarget = dropTargetSessionId === session.id;

    return (
      <div
        key={session.id}
        draggable
        onDragStart={(e) => beginDrag(e, { kind: "session", id: session.id })}
        onDragEnd={endDrag}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDropTargetSessionId(session.id);
        }}
        onDragLeave={() => setDropTargetSessionId((prev) => (prev === session.id ? null : prev))}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          dropOnSession(session);
        }}
        onClick={() => void connect(session)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openContextMenu(e, { session });
        }}
        className={`group flex cursor-pointer items-center justify-between rounded-xl px-2.5 py-1.5 text-xs text-slate-700 transition select-none ${
          isDropTarget && dragPayload
            ? "bg-apple-blue/10 ring-1 ring-apple-blue/40"
            : "hover:bg-black/[0.04]"
        }`}
        title={`${session.name}（单击连接，可拖拽调整分组）`}
      >
        <div className="flex min-w-0 items-center space-x-2">
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-xs transition ${
              session.protocol === "serial"
                ? "border border-apple-purple/20 bg-apple-purple/10 text-apple-purple"
                : "border border-apple-blue/20 bg-apple-blue/10 text-apple-blue"
            }`}
          >
            {session.protocol === "serial" ? "🔌" : "⚡"}
          </span>

          <div className="min-w-0 truncate">
            <div className="flex items-center gap-1.5 truncate font-semibold text-slate-900">
              <span>{session.name}</span>
              {getColorBadge(session.color)}
              {session.favorite && <span className="text-[10px] text-apple-orange">★</span>}
              {isDirty ? (
                <span
                  className="inline-flex items-center rounded bg-amber-50 px-1 py-0.2 text-[9px] font-sans text-amber-600"
                  title="本地有待同步至云端的变更"
                >
                  ☁️待同步
                </span>
              ) : hasSyncVersion ? (
                <span
                  className="inline-flex items-center rounded bg-emerald-50 px-1 py-0.2 text-[9px] font-sans text-emerald-600"
                  title="已与云端 E2EE 服务同步一致"
                >
                  ☁️已同步
                </span>
              ) : null}
            </div>
            <div className="truncate font-mono text-[10px] text-slate-500">
              {session.protocol === "serial"
                ? session.protocol_options_json?.port_name || "COM1"
                : `${session.username || "root"}@${session.host || "localhost"}:${session.port || 22}`}
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-1 opacity-0 transition group-hover:opacity-100">
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
              void connect(session);
            }}
            title="连接会话"
            className="rounded-md p-1 text-slate-500 transition hover:bg-apple-blue hover:text-white"
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
            className="rounded-md p-1 text-slate-500 transition hover:bg-slate-200"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  const treeApi: TreeApi = {
    collapsed: collapsedGroups,
    toggle: toggleGroup,
    beginDrag,
    endDrag,
    hoverGroup: setHoveredGroupId,
    clearHover: () => setHoveredGroupId(null),
    dropOnGroup,
    openContextMenu,
    onNewSession,
    onRenameGroup: handleRenameGroup,
    onDeleteGroup: handleDeleteGroup,
    onCreateSubGroup: (group) => {
      setNewGroupParentId(group.id);
      setShowNewGroupInput(true);
    },
    renderSession,
    hoveredGroupId,
    draggingKind: dragPayload?.kind ?? null,
  };

  return (
    <div className="flex h-full flex-col border-r border-slate-200/80 bg-[#fbfbfd]">
      {/* 顶部工具栏与同步状态指示 */}
      <div className="space-y-2 border-b border-slate-200/80 p-3">
        <div className="flex items-center justify-between pb-1">
          <button
            onClick={() => setSyncModalOpen(true)}
            className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition ${
              syncConfig?.is_logged_in
                ? "border-apple-green/30 bg-apple-green/10 text-emerald-700 hover:bg-apple-green/20"
                : "border-slate-200 bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
            title="点击管理 E2EE 端到端同步设置"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                syncConfig?.is_logged_in ? "animate-pulse bg-apple-green" : "bg-slate-400"
              }`}
            />
            <span>{syncing ? "同步中..." : syncConfig?.is_logged_in ? "E2EE 同步已连接" : "云端同步未连接"}</span>
          </button>

          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-1 rounded-lg p-1 text-[11px] text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
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
            className="w-full rounded-xl border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs text-slate-900 placeholder-slate-400 shadow-apple-sm transition focus:border-apple-blue focus:outline-none focus:ring-2 focus:ring-apple-blue/20"
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

        {/* 过滤器切换标签 */}
        <div className="flex rounded-lg bg-slate-200/70 p-0.5 text-[11px]">
          {(
            [
              ["all", `全部 (${sessions.length})`],
              ["favorites", `★ 收藏 (${sessions.filter((s) => s.favorite).length})`],
              ["recent", "🕘 最近"],
            ] as Array<[FilterKind, string]>
          ).map(([kind, label]) => (
            <button
              key={kind}
              onClick={() => setActiveFilter(kind)}
              className={`flex-1 rounded-md py-1 text-center font-medium transition ${
                activeFilter === kind
                  ? "bg-white font-semibold text-slate-900 shadow-apple-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 新建会话与新建分组按钮 */}
        <div className="flex items-center space-x-1.5 pt-0.5">
          <button
            onClick={() => onNewSession()}
            className="flex flex-1 items-center justify-center space-x-1.5 rounded-xl bg-apple-blue py-1.5 text-xs font-semibold text-white shadow-apple-sm transition hover:bg-apple-hoverBlue"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>新建会话</span>
          </button>
          <button
            onClick={() => {
              setNewGroupParentId(null);
              setShowNewGroupInput(true);
            }}
            title="新建分组"
            className="rounded-xl border border-slate-200 bg-white p-1.5 text-slate-600 shadow-apple-sm transition hover:bg-slate-100 hover:text-slate-900"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
              />
            </svg>
          </button>
        </div>

        {showNewGroupInput && (
          <form onSubmit={handleCreateGroup} className="mt-2 flex animate-in items-center space-x-1 fade-in">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder={
                newGroupParentId
                  ? `在「${groups.find((g) => g.id === newGroupParentId)?.name ?? "分组"}」下新建子分组...`
                  : "新分组名称..."
              }
              autoFocus
              className="flex-1 rounded-xl border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-900 focus:border-apple-blue focus:outline-none focus:ring-1 focus:ring-apple-blue"
            />
            <button
              type="submit"
              className="rounded-xl bg-apple-blue px-2.5 py-1 text-xs font-medium text-white hover:bg-apple-hoverBlue"
            >
              确定
            </button>
            <button
              type="button"
              onClick={() => {
                setShowNewGroupInput(false);
                setNewGroupParentId(null);
              }}
              className="rounded-xl border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
            >
              取消
            </button>
          </form>
        )}
      </div>

      {/* 会话树列表 */}
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {/* 最近连接：常用机器不必在树里翻找 */}
        {activeFilter === "all" && !searchQuery.trim() && recentSessions.length > 0 && (
          <div className="mb-1 space-y-0.5">
            <div className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              最近连接
            </div>
            {recentSessions.map(renderSession)}
            <div className="my-1 border-b border-slate-200/70" />
          </div>
        )}

        {visibleRoots.map((node) => (
          <SessionTreeNode key={node.group.id} node={node} depth={0} api={treeApi} />
        ))}

        {/* 未分组会话（同时也是把会话拖出分组的落点） */}
        <div
          className={`space-y-0.5 rounded-xl ${
            hoveredGroupId === ROOT_DROP_ID && dragPayload
              ? "bg-apple-blue/5 ring-1 ring-apple-blue/30"
              : ""
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setHoveredGroupId(ROOT_DROP_ID);
          }}
          onDragLeave={() => setHoveredGroupId((prev) => (prev === ROOT_DROP_ID ? null : prev))}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dropOnGroup(null);
          }}
        >
          {(tree.ungrouped.length > 0 || !!dragPayload) && (
            <div className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              未分组会话
            </div>
          )}
          {tree.ungrouped.map(renderSession)}
          {dragPayload && tree.ungrouped.length === 0 && (
            <div className="mx-2 rounded-lg border border-dashed border-slate-300 px-2 py-1.5 text-[10px] text-slate-400">
              拖到这里可移出分组
            </div>
          )}
        </div>

        {filteredSessions.length === 0 && (
          <div className="flex flex-col items-center justify-center p-8 text-center text-slate-400">
            <div className="mb-2 text-3xl opacity-60">💻</div>
            <p className="mb-1 text-xs font-medium text-slate-600">
              {activeFilter === "favorites"
                ? "暂无收藏的会话"
                : activeFilter === "recent"
                  ? "还没有连接记录"
                  : "暂无保存的会话"}
            </p>
            <p className="mb-3 text-[11px] text-slate-400">点击下方按钮快速配置新连接</p>
            <button onClick={() => onNewSession()} className="text-xs font-semibold text-apple-blue hover:underline">
              + 立即新建会话
            </button>
          </div>
        )}
      </div>

      {/* 右键浮动上下文菜单 */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[176px] animate-in rounded-2xl border border-black/10 bg-white/95 py-1.5 text-xs shadow-apple-xl backdrop-blur-xl fade-in duration-100"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.session && (
            <>
              <MenuItem
                icon="⚡"
                label="连接会话"
                onClick={() => {
                  const s = contextMenu.session!;
                  setContextMenu(null);
                  void connect(s);
                }}
              />
              <MenuItem
                icon="📂"
                label="打开 SFTP 视图"
                onClick={() => {
                  const s = contextMenu.session!;
                  setContextMenu(null);
                  void openSftp(s);
                }}
              />
              <MenuItem
                icon="🗂"
                label="在新标签打开"
                onClick={() => {
                  const s = contextMenu.session!;
                  setContextMenu(null);
                  void openSession(s).catch((err) =>
                    toast.error(`连接 ${s.name} 失败`, formatFriendlyError(err))
                  );
                }}
              />
              <div className="my-1 border-t border-slate-100" />
              <MenuItem
                icon="🖥"
                label="复制主机地址"
                onClick={() => {
                  const s = contextMenu.session!;
                  setContextMenu(null);
                  void copyText(s.host || "", "主机地址");
                }}
              />
              <MenuItem
                icon="👤"
                label="复制用户名"
                onClick={() => {
                  const s = contextMenu.session!;
                  setContextMenu(null);
                  void copyText(s.username || "root", "用户名");
                }}
              />
              <div className="my-1 border-t border-slate-100" />
              <MenuItem
                icon="✏️"
                label="编辑配置"
                onClick={() => {
                  const s = contextMenu.session!;
                  setContextMenu(null);
                  onEditSession(s);
                }}
              />
              <MenuItem
                icon="📋"
                label="克隆副本"
                onClick={() => {
                  const s = contextMenu.session!;
                  setContextMenu(null);
                  void duplicateSession(s.id);
                }}
              />
              <MenuItem
                icon="★"
                label={contextMenu.session.favorite ? "取消收藏" : "设为收藏"}
                onClick={() => {
                  const s = contextMenu.session!;
                  setContextMenu(null);
                  void toggleFavorite(s);
                }}
              />
              <div className="my-1 border-t border-slate-100" />
              <MenuItem
                icon="🗑️"
                label="删除会话"
                danger
                onClick={() => {
                  const s = contextMenu.session!;
                  setContextMenu(null);
                  if (!confirm(`确认删除会话 "${s.name}" 吗？`)) return;
                  void deleteSession(s.id).catch((err) =>
                    toast.error("删除会话失败", formatFriendlyError(err))
                  );
                }}
              />
            </>
          )}

          {contextMenu.group && (
            <>
              <MenuItem
                icon="➕"
                label="在此分组新建会话"
                onClick={() => {
                  const g = contextMenu.group!;
                  setContextMenu(null);
                  onNewSession(g.id);
                }}
              />
              <MenuItem
                icon="⧉"
                label="新建子分组"
                onClick={() => {
                  const g = contextMenu.group!;
                  setContextMenu(null);
                  setNewGroupParentId(g.id);
                  setShowNewGroupInput(true);
                }}
              />
              <MenuItem
                icon="✏️"
                label="重命名分组"
                onClick={() => {
                  const g = contextMenu.group!;
                  setContextMenu(null);
                  void handleRenameGroup(g);
                }}
              />
              <div className="my-1 border-t border-slate-100" />
              <MenuItem
                icon="🗑️"
                label="删除分组"
                danger
                onClick={() => {
                  const g = contextMenu.group!;
                  setContextMenu(null);
                  void handleDeleteGroup(g);
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
};
