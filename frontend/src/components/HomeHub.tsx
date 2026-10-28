import React, { useMemo, useState } from "react";
import type { Group, Session } from "../types/ipc";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalStore } from "../stores/terminalStore";

interface HomeHubProps {
  onNewSession: (groupId?: string) => void;
  onEditSession: (session: Session) => void;
  onConnectSession: (session: Session) => void;
  onPortCheckerOpen?: (host?: string, port?: number) => void;
}

type FilterKey = "all" | "favorites" | "online" | string;

/** 分组色点：分组没配颜色时按顺序取，保证视觉上能区分 */
const GROUP_DOTS = ["#0ea5e9", "#10b981", "#8b5cf6", "#f59e0b", "#ec4899", "#14b8a6", "#ef4444"];

/** 主机头像渐变：按会话 id 哈希取，保证同一台机器每次颜色一致 */
const AVATAR_GRADIENTS = [
  "from-sky-500 to-blue-600",
  "from-emerald-500 to-teal-600",
  "from-violet-500 to-purple-600",
  "from-amber-500 to-orange-600",
  "from-rose-500 to-pink-600",
  "from-cyan-500 to-sky-600",
];

const hashIndex = (key: string, len: number): number => {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % len;
};

/** 后端时间戳可能是秒或毫秒，统一折算成毫秒 */
const toMs = (ts: number | null | undefined): number => {
  if (!ts) return 0;
  return ts > 1e11 ? ts : ts * 1000;
};

const formatRelative = (ts: number | null | undefined): string => {
  const ms = toMs(ts);
  if (!ms) return "尚未使用";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ms).toLocaleDateString("zh-CN");
};

interface Section {
  key: string;
  name: string;
  dot: string;
  groupId: string | null;
  sessions: Session[];
  online: number;
}

export const HomeHub: React.FC<HomeHubProps> = ({
  onNewSession,
  onEditSession,
  onConnectSession,
  onPortCheckerOpen,
}) => {
  const { sessions, groups, deleteSession, updateSession } = useSessionStore();
  const { tabs, setActiveTab } = useTerminalStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFilter, setSelectedFilter] = useState<FilterKey>("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [deletingSession, setDeletingSession] = useState<Session | null>(null);

  /** 已连接的会话 id：用于状态点、在线计数与「在线优先」排序 */
  const onlineIds = useMemo(
    () => new Set(tabs.filter((t) => t.status === "connected").map((t) => t.sessionId)),
    [tabs]
  );

  const tabBySession = useMemo(() => {
    const map = new Map<string, (typeof tabs)[number]>();
    tabs.forEach((t) => map.set(t.sessionId, t));
    return map;
  }, [tabs]);

  const groupById = useMemo(() => {
    const map = new Map<string, Group>();
    groups.forEach((g) => map.set(g.id, g));
    return map;
  }, [groups]);

  // 搜索 + 分类过滤；在线会话永远排在前面，其次按最近使用时间
  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sessions
      .filter((s) => {
        if (selectedFilter === "favorites" && !s.favorite) return false;
        if (selectedFilter === "online" && !onlineIds.has(s.id)) return false;
        if (selectedFilter !== "all" && selectedFilter !== "favorites" && selectedFilter !== "online") {
          if (s.group_id !== selectedFilter) return false;
        }
        if (!q) return true;
        return (
          s.name.toLowerCase().includes(q) ||
          (s.host || "").toLowerCase().includes(q) ||
          (s.username || "").toLowerCase().includes(q) ||
          (s.notes || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const onlineDiff = Number(onlineIds.has(b.id)) - Number(onlineIds.has(a.id));
        if (onlineDiff !== 0) return onlineDiff;
        const usedDiff = toMs(b.last_used_at) - toMs(a.last_used_at);
        if (usedDiff !== 0) return usedDiff;
        return (a.sort_order ?? 0) - (b.sort_order ?? 0);
      });
  }, [sessions, selectedFilter, searchQuery, onlineIds]);

  /** 分类区块：仅「全部」视图按分组分段展示，其余筛选保持单段平铺 */
  const sections = useMemo<Section[]>(() => {
    const countOnline = (list: Session[]) => list.filter((s) => onlineIds.has(s.id)).length;

    if (selectedFilter !== "all") {
      const isGroup = selectedFilter !== "favorites" && selectedFilter !== "online";
      const group = isGroup ? groupById.get(selectedFilter) : undefined;
      return [
        {
          key: selectedFilter,
          name: selectedFilter === "favorites" ? "收藏的主机" : selectedFilter === "online" ? "当前在线" : group?.name || "分组",
          dot: group?.color || GROUP_DOTS[0],
          groupId: group?.id ?? null,
          sessions: filteredSessions,
          online: countOnline(filteredSessions),
        },
      ];
    }

    const orderedGroups = [...groups].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name)
    );

    const result: Section[] = orderedGroups
      .map((g, index) => {
        const list = filteredSessions.filter((s) => s.group_id === g.id);
        return {
          key: g.id,
          name: g.name,
          dot: g.color || GROUP_DOTS[index % GROUP_DOTS.length],
          groupId: g.id,
          sessions: list,
          online: countOnline(list),
        };
      })
      .filter((section) => section.sessions.length > 0);

    const ungrouped = filteredSessions.filter((s) => !s.group_id || !groupById.has(s.group_id));
    if (ungrouped.length > 0) {
      result.push({
        key: "__ungrouped__",
        name: "未分组",
        dot: "#94a3b8",
        groupId: null,
        sessions: ungrouped,
        online: countOnline(ungrouped),
      });
    }
    return result;
  }, [filteredSessions, groupById, groups, onlineIds, selectedFilter]);

  const onlineCount = sessions.filter((s) => onlineIds.has(s.id)).length;
  const favoriteCount = sessions.filter((s) => s.favorite).length;
  const newGroupId =
    selectedFilter !== "all" && selectedFilter !== "favorites" && selectedFilter !== "online"
      ? selectedFilter
      : undefined;

  const toggleFavorite = (session: Session) => {
    void updateSession(session.id, { favorite: !session.favorite });
  };

  const renderCard = (s: Session) => {
    const activeTab = tabBySession.get(s.id);
    const isOnline = activeTab?.status === "connected";
    const isBusy = activeTab?.status === "connecting" || activeTab?.status === "reconnecting";
    const isPublicKey = s.auth_method === "publickey" || s.auth_method === "public_key";
    const group = s.group_id ? groupById.get(s.group_id) : undefined;
    const gradient = AVATAR_GRADIENTS[hashIndex(s.id, AVATAR_GRADIENTS.length)];

    return (
      <div
        key={s.id}
        onClick={() => {
          if (activeTab) setActiveTab(activeTab.tabId);
          else onConnectSession(s);
        }}
        className={`group relative flex flex-col justify-between rounded-2xl border p-4 transition-all duration-200 cursor-pointer bg-white/90 backdrop-blur-sm hover:shadow-apple-md hover:-translate-y-0.5 ${
          isOnline
            ? "border-emerald-300 ring-2 ring-emerald-500/10"
            : "border-slate-200/90 hover:border-apple-blue/50"
        }`}
      >
        {/* 头部：主机头像 + 别名 + 状态 */}
        <div className="flex items-start gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${gradient} text-sm font-bold text-white shadow-apple-sm`}
          >
            {(s.name || "?").trim().charAt(0).toUpperCase() || "?"}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-bold text-sm text-slate-900 group-hover:text-apple-blue transition">
                {s.name}
              </span>
              {(isOnline || isBusy) && (
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                    isOnline
                      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                      : "bg-amber-50 text-amber-700 border border-amber-200"
                  }`}
                >
                  {isOnline ? "在线" : activeTab?.status === "reconnecting" ? "重连中" : "连接中"}
                </span>
              )}
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-slate-500 truncate">
              {s.protocol === "serial"
                ? `${s.protocol_options_json?.port_name || "COM1"} @ ${s.protocol_options_json?.baud_rate || 115200}`
                : `${s.username || "root"}@${s.host || "127.0.0.1"}:${s.port || 22}`}
            </div>
          </div>

          {/* 快捷操作：收藏 / 编辑 / 删除 */}
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleFavorite(s);
              }}
              className={`p-1 rounded-lg transition ${
                s.favorite
                  ? "text-amber-500 hover:bg-amber-50"
                  : "text-slate-300 hover:text-amber-500 hover:bg-amber-50"
              }`}
              title={s.favorite ? "取消收藏" : "收藏该主机"}
            >
              <svg className="w-3.5 h-3.5" fill={s.favorite ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118L2.98 10.1c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                />
              </svg>
            </button>
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

        {/* 标签区：协议 / 认证 / 分组 / 备注 */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] font-medium">
          <span
            className={`rounded px-1.5 py-0.5 font-bold border ${
              s.protocol === "serial"
                ? "bg-purple-50 text-purple-700 border-purple-200"
                : "bg-blue-50 text-apple-blue border-blue-200"
            }`}
          >
            {s.protocol === "serial" ? "SERIAL" : s.protocol.toUpperCase()}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 border ${
              isPublicKey
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-slate-100 text-slate-600 border-slate-200"
            }`}
          >
            {isPublicKey ? "🛡️ 密钥" : "🔑 密码"}
          </span>
          {group && (
            <span
              className="flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-slate-600"
              title={`分组：${group.name}`}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: group.color || "#94a3b8" }} />
              {group.name}
            </span>
          )}
          {s.notes && (
            <span className="max-w-[160px] truncate rounded bg-slate-100 px-1.5 py-0.5 text-slate-500" title={s.notes}>
              {s.notes}
            </span>
          )}
        </div>

        {/* 底部：最近使用 + 动作 */}
        <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2.5 text-[11px]">
          <span className="text-slate-400">
            {isOnline ? (
              <span className="flex items-center gap-1 font-semibold text-emerald-600">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                会话进行中 · 点击切入
              </span>
            ) : (
              <span>最近使用：{formatRelative(s.last_used_at)}</span>
            )}
          </span>
          <span className="flex items-center gap-1 font-bold text-apple-blue opacity-0 transition group-hover:opacity-100 group-hover:translate-x-0.5">
            {isOnline ? "进入终端" : "极速连接"} →
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden select-none bg-transparent">
      {/* 顶部主横幅与快速控制栏 */}
      <div className="shrink-0 border-b border-slate-200/80 bg-white/75 p-6 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-2xl">🖥️</span>
              <h1 className="text-xl font-bold tracking-tight text-slate-900">管理中心</h1>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
              <span className="rounded-full border border-slate-200 bg-white/80 px-2 py-0.5 font-mono text-slate-600">
                {sessions.length} 台主机
              </span>
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-700">
                {onlineCount} 在线
              </span>
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700">
                {favoriteCount} 收藏
              </span>
              <span className="rounded-full border border-slate-200 bg-white/80 px-2 py-0.5 text-slate-500">
                {groups.length} 个分组
              </span>
            </div>
          </div>

          {/* 核心入口：醒目的大号“新建连接”按钮与快捷工具 */}
          <div className="flex items-center gap-3">
            {onPortCheckerOpen && (
              <button
                onClick={() => onPortCheckerOpen()}
                className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-apple-sm transition hover:bg-slate-50"
                title="快速探测端口连通性"
              >
                <span>🔍 端口探测</span>
              </button>
            )}
            <button
              onClick={() => onNewSession(newGroupId)}
              className="flex items-center gap-2 rounded-xl bg-apple-blue px-4 py-2.5 text-xs font-semibold text-white shadow-apple-md transition duration-150 hover:bg-apple-hoverBlue active:scale-98"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
              </svg>
              <span>+ 新建连接</span>
            </button>
          </div>
        </div>

        {/* 筛选与搜索工具条 */}
        <div className="mx-auto mt-5 flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
          {/* 分类筛选标签胶囊 */}
          <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
            <button
              onClick={() => setSelectedFilter("all")}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                selectedFilter === "all"
                  ? "bg-slate-900 text-white font-semibold shadow-apple-sm"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/70"
              }`}
            >
              全部分类 ({sessions.length})
            </button>
            <button
              onClick={() => setSelectedFilter("online")}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition flex items-center gap-1 ${
                selectedFilter === "online"
                  ? "bg-emerald-600 text-white font-semibold shadow-apple-sm"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/70"
              }`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              在线 ({onlineCount})
            </button>
            <button
              onClick={() => setSelectedFilter("favorites")}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition flex items-center gap-1 ${
                selectedFilter === "favorites"
                  ? "bg-amber-500 text-white font-semibold shadow-apple-sm"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/70"
              }`}
            >
              <span>⭐ 收藏</span>
            </button>
            <span className="mx-1 h-4 w-px shrink-0 bg-slate-200" />
            {[...groups]
              .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name))
              .map((g, index) => {
                const count = sessions.filter((s) => s.group_id === g.id).length;
                return (
                  <button
                    key={g.id}
                    onClick={() => setSelectedFilter(g.id)}
                    className={`flex shrink-0 items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition ${
                      selectedFilter === g.id
                        ? "bg-apple-blue text-white font-semibold shadow-apple-sm"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200/70"
                    }`}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: g.color || GROUP_DOTS[index % GROUP_DOTS.length] }}
                    />
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
                placeholder="搜索别名、IP、用户或备注..."
                className="w-full rounded-xl border border-slate-200 bg-white pl-8 pr-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 transition shadow-apple-sm focus:border-apple-blue focus:outline-none focus:ring-2 focus:ring-apple-blue/20"
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

            <div className="flex items-center rounded-lg border border-slate-200 bg-slate-100 p-0.5">
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
        <div className="mx-auto max-w-6xl">
          {filteredSessions.length === 0 ? (
            <div className="mt-4 space-y-3 rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center shadow-apple-sm">
              <div className="mb-1 text-4xl">🖥️ ⚡</div>
              <h3 className="text-base font-bold text-slate-800">
                {sessions.length === 0 ? "还没有配置任何服务器连接" : "未找到匹配的机器"}
              </h3>
              <p className="mx-auto max-w-md text-xs text-slate-500">
                {sessions.length === 0
                  ? "OpenShell 支持一键保存 SSH 主机、串口设备。新建完成后，即可随时点击卡片发起极速免密或密码连接。"
                  : "尝试清空搜索关键字，或切换上方的分类 / 在线 / 收藏筛选。"}
              </p>
              {sessions.length === 0 && (
                <button
                  onClick={() => onNewSession()}
                  className="mt-2 rounded-xl bg-apple-blue px-5 py-2 text-xs font-semibold text-white shadow-apple-md transition hover:bg-apple-hoverBlue"
                >
                  + 新建第一台机器连接
                </button>
              )}
            </div>
          ) : viewMode === "grid" ? (
            <div className="space-y-6">
              {sections.map((section) => (
                <div key={section.key}>
                  {/* 分类标题：分组名 + 数量 + 在线数 + 快捷新建 */}
                  <div className="mb-2.5 flex items-center justify-between gap-3 border-b border-slate-200/70 pb-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: section.dot }} />
                      <h2 className="truncate text-[13px] font-bold text-slate-900">{section.name}</h2>
                      <span className="shrink-0 text-[11px] font-medium text-slate-500">
                        {section.sessions.length} 台
                      </span>
                      {section.online > 0 && (
                        <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">
                          {section.online} 在线
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => onNewSession(section.groupId ?? undefined)}
                      className="shrink-0 text-[11px] font-semibold text-apple-blue transition hover:underline"
                    >
                      + 在此分组新建
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {section.sessions.map(renderCard)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* 紧凑列表表格视图 */
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white/90 shadow-apple-sm backdrop-blur-sm">
              <table className="w-full text-left text-xs text-slate-700">
                <thead className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-500">
                  <tr>
                    <th className="py-2.5 px-4">状态</th>
                    <th className="py-2.5 px-4">机器别名</th>
                    <th className="py-2.5 px-4">主机 / 端口</th>
                    <th className="py-2.5 px-4">分类</th>
                    <th className="py-2.5 px-4">认证</th>
                    <th className="py-2.5 px-4">最近使用</th>
                    <th className="py-2.5 px-4 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredSessions.map((s) => {
                    const activeTab = tabBySession.get(s.id);
                    const isOnline = activeTab?.status === "connected";
                    const isBusy = activeTab?.status === "connecting" || activeTab?.status === "reconnecting";
                    const group = s.group_id ? groupById.get(s.group_id) : undefined;
                    const isPublicKey = s.auth_method === "publickey" || s.auth_method === "public_key";
                    return (
                      <tr
                        key={s.id}
                        onClick={() => {
                          if (activeTab) setActiveTab(activeTab.tabId);
                          else onConnectSession(s);
                        }}
                        className="cursor-pointer transition hover:bg-slate-50"
                      >
                        <td className="py-2.5 px-4">
                          <span
                            className={`inline-block h-2.5 w-2.5 rounded-full ${
                              isOnline ? "bg-emerald-500 animate-pulse" : isBusy ? "bg-amber-400" : "bg-slate-300"
                            }`}
                          />
                        </td>
                        <td className="py-2.5 px-4 font-bold text-slate-900">
                          <span className="flex items-center gap-1">
                            {s.name}
                            {s.favorite && <span className="text-amber-500">★</span>}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-600">
                          {s.protocol === "serial"
                            ? `${s.protocol_options_json?.port_name || "COM1"} @ ${s.protocol_options_json?.baud_rate || 115200}`
                            : `${s.username || "root"}@${s.host || "127.0.0.1"}:${s.port || 22}`}
                        </td>
                        <td className="py-2.5 px-4">
                          {group ? (
                            <span className="flex items-center gap-1 text-slate-600">
                              <span
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: group.color || "#94a3b8" }}
                              />
                              {group.name}
                            </span>
                          ) : (
                            <span className="text-slate-400">未分组</span>
                          )}
                        </td>
                        <td className="py-2.5 px-4">
                          {isPublicKey ? (
                            <span className="rounded bg-emerald-50 px-2 py-0.5 font-mono text-[10px] text-emerald-700">
                              🛡️ 密钥
                            </span>
                          ) : (
                            <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-600">
                              🔑 密码
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-slate-500">{formatRelative(s.last_used_at)}</td>
                        <td className="space-x-1 py-2.5 px-4 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onEditSession(s);
                            }}
                            className="rounded px-2 py-1 text-slate-600 transition hover:bg-slate-200"
                          >
                            编辑
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeletingSession(s);
                            }}
                            className="rounded px-2 py-1 text-red-600 transition hover:bg-red-50"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h4 className="text-sm font-bold text-slate-900">确认删除该机器？</h4>
            <p className="text-xs text-slate-600">
              即将删除机器配置 <strong className="text-slate-900">{deletingSession.name}</strong>。此操作不可恢复。
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setDeletingSession(null)}
                className="rounded-xl border border-slate-200 px-3.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  await deleteSession(deletingSession.id);
                  setDeletingSession(null);
                }}
                className="rounded-xl bg-red-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700"
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
