import { GlassMaterial } from "./ui/GlassMaterial";
import React, { useMemo, useState } from "react";
import { FolderIcon, KeyIcon, PlusIcon, ServerIcon, SearchIcon, ShieldIcon, StarIcon, PencilIcon, TrashIcon, GridIcon, ListIcon } from "./ui/icons";
import { HostIcon } from "./ui/HostIcon";
import { DEVICE_ICONS } from "../lib/hostIcons";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Field";
import { Modal } from "./ui/Overlay";
import { formatFriendlyError } from "../lib/errors";
import type { Group, Session } from "../types/ipc";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalStore } from "../stores/terminalStore";

interface HomeHubProps {
  onNewSession: (groupId?: string, iconKey?: string) => void;
  onEditSession: (session: Session) => void;
  onConnectSession: (session: Session) => void;
  onPortCheckerOpen?: (host?: string, port?: number) => void;
}

type FilterKey = "all" | "favorites" | "online" | string;

/** 分组色点：分组没配颜色时按顺序取，保证视觉上能区分 */
const GROUP_DOTS = ["#0ea5e9", "#10b981", "#8b5cf6", "#f59e0b", "#ec4899", "#14b8a6", "#ef4444"];

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
  const { sessions, groups, createGroup, deleteSession, updateSession } = useSessionStore();
  const { tabs, setActiveTab } = useTerminalStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFilter, setSelectedFilter] = useState<FilterKey>("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [deletingSession, setDeletingSession] = useState<Session | null>(null);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);

  const handleCreateGroup = async (event: React.FormEvent) => {
    event.preventDefault();
    if (creatingGroup) return;
    const name = groupName.trim();
    if (!name) { setGroupError("请输入分组名称"); return; }
    if (groups.some((group) => !group.parent_id && group.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setGroupError("已存在同名分组，请使用其他名称");
      return;
    }
    setCreatingGroup(true);
    setGroupError(null);
    try {
      const group = await createGroup(name);
      setSelectedFilter(group.id);
      setSearchQuery("");
      setViewMode("grid");
      setGroupModalOpen(false);
      setGroupName("");
    } catch (error) {
      setGroupError(formatFriendlyError(error));
    } finally {
      setCreatingGroup(false);
    }
  };

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
      .filter((section) => section.sessions.length > 0 || !searchQuery.trim());

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
  }, [filteredSessions, groupById, groups, onlineIds, selectedFilter, searchQuery]);

  const onlineCount = sessions.filter((s) => onlineIds.has(s.id)).length;
  const favoriteCount = sessions.filter((s) => s.favorite).length;
  const firstRun = sessions.length === 0 && selectedFilter === "all" && !searchQuery.trim();
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

    return (
      <div
        key={s.id}
        onClick={() => {
          if (activeTab) setActiveTab(activeTab.tabId);
          else onConnectSession(s);
        }}
        className={`group relative flex flex-col justify-between rounded-2xl border bg-surface p-4 transition-colors duration-150 cursor-pointer shadow-apple-sm hover:shadow-apple-md ${
          isOnline
            ? "border-state-success/30 ring-2 ring-emerald-500/10"
            : "border-line/15 hover:border-accent/50"
        }`}
      >
        {/* 头部：主机头像 + 别名 + 状态 */}
        <div className="flex items-start gap-3">
          <HostIcon iconKey={s.icon_key} protocol={s.protocol} className="h-10 w-10" />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-bold text-sm text-ink group-hover:text-accent transition">
                {s.name}
              </span>
              {(isOnline || isBusy) && (
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                    isOnline
                      ? "bg-state-success/10 text-state-success border border-state-success/30"
                      : "bg-state-warning/10 text-state-warning border border-state-warning/30"
                  }`}
                >
                  {isOnline ? "在线" : activeTab?.status === "reconnecting" ? "重连中" : "连接中"}
                </span>
              )}
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-ink-secondary truncate">
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
                  ? "text-state-warning hover:bg-state-warning/10"
                  : "text-ink-secondary hover:text-state-warning hover:bg-state-warning/10"
              }`}
              title={s.favorite ? "取消收藏" : "收藏该主机"}
            >
              <StarIcon className="h-3.5 w-3.5" fill={s.favorite ? "currentColor" : "none"} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEditSession(s);
              }}
              className="p-1 rounded-lg text-ink-tertiary hover:text-ink hover:bg-line/5 transition"
              title="编辑机器配置"
            >
              <PencilIcon className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setDeletingSession(s);
              }}
              className="p-1 rounded-lg text-ink-tertiary hover:text-state-danger hover:bg-state-danger/10 transition"
              title="删除机器"
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* 标签区：协议 / 认证 / 分组 / 备注 */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] font-medium">
          <span
            className={`rounded px-1.5 py-0.5 font-bold border ${
              s.protocol === "serial"
                ? "bg-accent/10 text-accent border-accent/30"
                : "bg-accent/10 text-accent border-accent/30"
            }`}
          >
            {s.protocol === "serial" ? "SERIAL" : s.protocol.toUpperCase()}
          </span>
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 border ${
              isPublicKey
                ? "bg-state-success/10 text-state-success border-state-success/30"
                : "bg-line/5 text-ink-secondary border-line/15"
            }`}
          >
            {isPublicKey ? <ShieldIcon className="h-3 w-3" /> : <KeyIcon className="h-3 w-3" />}
            {isPublicKey ? "密钥" : "密码"}
          </span>
          {group && (
            <span
              className="flex items-center gap-1 rounded border border-line/15 bg-surface px-1.5 py-0.5 text-ink-secondary"
              title={`分组：${group.name}`}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: group.color || "#94a3b8" }} />
              {group.name}
            </span>
          )}
          {s.notes && (
            <span className="max-w-[160px] truncate rounded bg-line/5 px-1.5 py-0.5 text-ink-secondary" title={s.notes}>
              {s.notes}
            </span>
          )}
        </div>

        {/* 底部：最近使用 + 动作 */}
        <div className="mt-3 flex items-center justify-between border-t border-line/15 pt-2.5 text-[11px]">
          <span className="text-ink-tertiary">
            {isOnline ? (
              <span className="flex items-center gap-1 font-semibold text-state-success">
                <span className="h-1.5 w-1.5 rounded-full bg-state-success" />
                会话进行中 · 点击切入
              </span>
            ) : (
              <span>最近使用：{formatRelative(s.last_used_at)}</span>
            )}
          </span>
          <span className="flex items-center gap-1 font-bold text-accent opacity-0 transition group-hover:opacity-100 group-hover:translate-x-0.5">
            {isOnline ? "进入终端" : "连接主机"} →
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden select-none workspace-background">
      {/* 顶部主横幅与快速控制栏 */}
      <div className="glass-host relative shrink-0 border-b border-line/15 liquid-glass-chrome p-6">
        <GlassMaterial radius={0} />
        <div className="mx-auto flex max-w-6xl flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <ServerIcon className="h-6 w-6 text-accent" />
              <h1 className="text-xl font-semibold tracking-tight text-ink">连接管理</h1>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
              <span className="rounded-full border border-line/15 bg-surface/80 px-2 py-0.5 font-mono text-ink-secondary">
                {sessions.length} 台主机
              </span>
              <span className="rounded-full border border-state-success/30 bg-state-success/10 px-2 py-0.5 text-state-success">
                {onlineCount} 在线
              </span>
              <span className="rounded-full border border-state-warning/30 bg-state-warning/10 px-2 py-0.5 text-state-warning">
                {favoriteCount} 收藏
              </span>
              <span className="rounded-full border border-line/15 bg-surface/80 px-2 py-0.5 text-ink-secondary">
                {groups.length} 个分组
              </span>
            </div>
          </div>

          {/* 核心入口：醒目的大号“新建连接”按钮与快捷工具 */}
          <div className="flex items-center gap-3">
            {onPortCheckerOpen && (
              <button
                onClick={() => onPortCheckerOpen()}
                className="flex items-center gap-1.5 rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs font-semibold text-ink-secondary shadow-apple-sm transition hover:bg-surface-muted"
                title="快速探测端口连通性"
              >
                <SearchIcon className="h-3.5 w-3.5" /><span>端口探测</span>
              </button>
            )}
            <Button
              onClick={() => { setGroupName(""); setGroupError(null); setGroupModalOpen(true); }}
              leading={<FolderIcon className="h-4 w-4" />}
            >
              新建分组
            </Button>
            <button
              onClick={() => onNewSession(newGroupId)}
              className="flex items-center gap-2 rounded-xl bg-action px-4 py-2.5 text-xs font-semibold text-white shadow-apple-md transition duration-150 hover:bg-action active:scale-98"
            >
              <PlusIcon className="h-4 w-4" />
              <span>新建服务器</span>
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
                  ? "bg-accent/15 text-accent font-semibold shadow-apple-sm"
                  : "bg-line/5 text-ink-secondary hover:bg-line/10"
              }`}
            >
              全部分类 ({sessions.length})
            </button>
            <button
              onClick={() => setSelectedFilter("online")}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition flex items-center gap-1 ${
                selectedFilter === "online"
                  ? "bg-accent/15 text-accent font-semibold shadow-apple-sm"
                  : "bg-line/5 text-ink-secondary hover:bg-line/10"
              }`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              在线 ({onlineCount})
            </button>
            <button
              onClick={() => setSelectedFilter("favorites")}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition flex items-center gap-1 ${
                selectedFilter === "favorites"
                  ? "bg-state-warning/100 text-white font-semibold shadow-apple-sm"
                  : "bg-line/5 text-ink-secondary hover:bg-line/10"
              }`}
            >
              <StarIcon className="h-3 w-3" /><span>收藏</span>
            </button>
            <span className="mx-1 h-4 w-px shrink-0 bg-line/10" />
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
                        ? "bg-action text-white font-semibold shadow-apple-sm"
                        : "bg-line/5 text-ink-secondary hover:bg-line/10"
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
                className="w-full rounded-xl border border-line/15 bg-surface pl-8 pr-3 py-1.5 text-xs text-ink placeholder-ink-tertiary transition shadow-apple-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
              <SearchIcon className="absolute left-2.5 top-2 h-3.5 w-3.5 text-ink-tertiary" />
            </div>

            <div className="flex items-center rounded-lg border border-line/15 bg-line/5 p-0.5">
              <button
                onClick={() => setViewMode("grid")}
                className={`p-1 rounded transition ${viewMode === "grid" ? "bg-surface text-ink shadow-apple-sm" : "text-ink-secondary hover:text-ink"}`}
                title="网格卡片视图"
              >
                <GridIcon className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setViewMode("list")}
                className={`p-1 rounded transition ${viewMode === "list" ? "bg-surface text-ink shadow-apple-sm" : "text-ink-secondary hover:text-ink"}`}
                title="列表表格视图"
              >
                <ListIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 主体卡片网格 / 列表区 */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl">
          {firstRun && <section aria-label="添加第一台主机" className="mx-auto my-8 max-w-xl rounded-3xl bg-surface px-6 py-8 text-center shadow-apple-md sm:px-10">
            <h2 className="text-lg font-semibold tracking-tight text-ink">添加第一台主机</h2>
            <div className="my-6 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {DEVICE_ICONS.slice(0, 10).map((system) => <button key={system.key}
                type="button" onClick={() => onNewSession(newGroupId, system.key)} aria-label={`添加 ${system.label} 主机`}
                className="flex min-w-0 flex-col items-center gap-2 rounded-2xl px-1 py-3 transition-colors hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent">
                <HostIcon iconKey={system.key} className="h-12 w-12" />
                <span className="max-w-full truncate text-[11px] font-medium text-ink-secondary">{system.label}</span>
              </button>)}
            </div>
            <Button variant="primary" leading={<PlusIcon className="h-4 w-4" />} onClick={() => onNewSession(newGroupId)}>新建服务器</Button>
          </section>}
          {filteredSessions.length === 0 && (!sections.length || !!searchQuery.trim() || selectedFilter === "online" || selectedFilter === "favorites") ? (
            !firstRun && <div className="mt-4 space-y-3 rounded-2xl bg-surface p-12 text-center shadow-apple-sm">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10"><ServerIcon className="h-7 w-7 text-accent" /></div>
              <h3 className="text-base font-bold text-ink">
                未找到匹配的机器
              </h3>
              <Button onClick={() => { setSearchQuery(""); setSelectedFilter("all"); }}>清除筛选</Button>
            </div>
          ) : viewMode === "grid" || filteredSessions.length === 0 ? (
            <div className="space-y-6">
              {sections.map((section) => (
                <section key={section.key} aria-label={`${section.name}服务器分组`}>
                  {/* 分类标题：分组名 + 数量 + 在线数 + 快捷新建 */}
                  <div className="mb-2.5 flex items-center justify-between gap-3 border-b border-line/15 pb-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: section.dot }} />
                      <h2 className="truncate text-[13px] font-bold text-ink">{section.name}</h2>
                      <span className="shrink-0 text-[11px] font-medium text-ink-secondary">
                        {section.sessions.length} 台
                      </span>
                      {section.online > 0 && (
                        <span className="shrink-0 rounded-full bg-state-success/10 px-1.5 py-0.5 text-[10px] font-bold text-state-success">
                          {section.online} 在线
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => onNewSession(section.groupId ?? undefined)}
                      aria-label={`在${section.name}新建服务器`}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-os-md border border-accent/20 bg-surface px-3 py-1.5 text-os-xs font-medium text-accent transition hover:bg-accent/5"
                    >
                      <PlusIcon className="h-3.5 w-3.5" /> 新建服务器
                    </button>
                  </div>

                  {section.sessions.length > 0 ? (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {section.sessions.map(renderCard)}
                    </div>
                  ) : (
                    <div className="flex items-center gap-4 rounded-os-lg border border-dashed border-accent/20 bg-surface/90 px-5 py-6">
                      <FolderIcon className="h-7 w-7 shrink-0 text-accent/70" />
                      <div>
                        <p className="text-os-sm font-medium text-ink">暂无服务器</p>
                      </div>
                    </div>
                  )}
                </section>
              ))}
            </div>
          ) : (
            /* 紧凑列表表格视图 */
            <div className="overflow-hidden rounded-2xl border border-line/15 bg-surface/90 shadow-apple-sm backdrop-blur-sm">
              <table className="w-full text-left text-xs text-ink-secondary">
                <thead className="border-b border-line/15 bg-surface-muted/80 text-[11px] font-semibold text-ink-secondary">
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
                <tbody className="divide-y divide-line/15">
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
                        className="cursor-pointer transition hover:bg-surface-muted"
                      >
                        <td className="py-2.5 px-4">
                          <span
                            className={`inline-block h-2.5 w-2.5 rounded-full ${
                              isOnline ? "bg-state-success" : isBusy ? "bg-amber-400" : "bg-line/15"
                            }`}
                          />
                        </td>
                        <td className="py-2.5 px-4 font-bold text-ink">
                          <span className="flex items-center gap-2.5">
                            <HostIcon iconKey={s.icon_key} protocol={s.protocol} className="h-6 w-6" />
                            <span className="truncate">{s.name}</span>
                            {s.favorite && <StarIcon className="h-3 w-3 shrink-0 text-state-warning" fill="currentColor" />}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 font-mono text-ink-secondary">
                          {s.protocol === "serial"
                            ? `${s.protocol_options_json?.port_name || "COM1"} @ ${s.protocol_options_json?.baud_rate || 115200}`
                            : `${s.username || "root"}@${s.host || "127.0.0.1"}:${s.port || 22}`}
                        </td>
                        <td className="py-2.5 px-4">
                          {group ? (
                            <span className="flex items-center gap-1 text-ink-secondary">
                              <span
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: group.color || "#94a3b8" }}
                              />
                              {group.name}
                            </span>
                          ) : (
                            <span className="text-ink-tertiary">未分组</span>
                          )}
                        </td>
                        <td className="py-2.5 px-4">
                          {isPublicKey ? (
                            <span className="inline-flex items-center gap-1 rounded bg-state-success/10 px-2 py-0.5 font-mono text-[10px] text-state-success">
                              <ShieldIcon className="h-3 w-3" /> 密钥
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded bg-line/5 px-2 py-0.5 font-mono text-[10px] text-ink-secondary">
                              <KeyIcon className="h-3 w-3" /> 密码
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-ink-secondary">{formatRelative(s.last_used_at)}</td>
                        <td className="space-x-1 py-2.5 px-4 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onEditSession(s);
                            }}
                            className="rounded px-2 py-1 text-ink-secondary transition hover:bg-line/10"
                          >
                            编辑
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeletingSession(s);
                            }}
                            className="rounded px-2 py-1 text-state-danger transition hover:bg-state-danger/10"
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

      <Modal open={groupModalOpen} onClose={() => { if (!creatingGroup) setGroupModalOpen(false); }}
        title="新建分组"
        widthClassName="w-full max-w-[440px]">
        <form onSubmit={handleCreateGroup} className="space-y-5">
          <Field label="分组名称" htmlFor="home-group-name" required error={groupError}>
            <Input id="home-group-name" autoFocus maxLength={80} value={groupName} disabled={creatingGroup}
              invalid={!!groupError} placeholder="例如：生产环境、预发布环境"
              onChange={(event) => { setGroupName(event.target.value); setGroupError(null); }} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setGroupModalOpen(false)} disabled={creatingGroup}>取消</Button>
            <Button type="submit" variant="primary" loading={creatingGroup} disabled={!groupName.trim()}>创建分组</Button>
          </div>
        </form>
      </Modal>

      {/* 删除机器确认弹窗 */}
      {deletingSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/65 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm space-y-3 rounded-2xl border border-line/15 bg-surface p-5 shadow-2xl">
            <h4 className="text-sm font-bold text-ink">确认删除该机器？</h4>
            <p className="text-xs text-ink-secondary">
              即将删除机器配置 <strong className="text-ink">{deletingSession.name}</strong>。此操作不可恢复。
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setDeletingSession(null)}
                className="rounded-xl border border-line/15 px-3.5 py-1.5 text-xs font-semibold text-ink-secondary transition hover:bg-surface-muted"
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
