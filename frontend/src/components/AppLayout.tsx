import React, { useEffect, useMemo, useState } from "react";
import type { Session, SessionInput } from "../types/ipc";
import { useVaultStore } from "../stores/vaultStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";
import { getWallpaperStyle } from "../lib/wallpapers";
import { useSessionStore } from "../stores/sessionStore";
import { HomeHub } from "./HomeHub";
import { ServerSidebar } from "./ServerSidebar";
import { TerminalTabs } from "./TerminalTabs";
import { TerminalHost } from "./TerminalHost";
import { SessionModal } from "./SessionModal";
import { VaultUnlockModal } from "./VaultUnlockModal";
import { TransferQueueDrawer } from "./TransferQueueDrawer";
import { RemoteEditorModal } from "./RemoteEditorModal";
import { MonitorDashboard } from "./MonitorDashboard";
import { PortForwardModal } from "./PortForwardModal";
import { SnippetBar } from "./SnippetBar";
import { MultiExecBar } from "./MultiExecBar";
import { ImportExportModal } from "./ImportExportModal";
import { SettingsModal } from "./SettingsModal";
import { SyncSettingsModal } from "./SyncSettingsModal";
import { PortCheckerModal } from "./PortCheckerModal";
import { SyncStatusWidget } from "./SyncStatusWidget";
import { CommandPaletteModal } from "./CommandPaletteModal";
import { useSyncStore } from "../stores/syncStore";
import { SftpView } from "./SftpView";
import { ContainerWorkspace } from "./ContainerWorkspace";
import { useSftpStore } from "../stores/sftpStore";
import { SessionTree } from "./SessionTree";
import { OverlayBoundary } from "./OverlayBoundary";
import { UpdateBadge } from "../updater/UpdateBadge";
import { UpdateModal } from "../updater/UpdateModal";
import { RecoveryBanner } from "../updater/RecoveryBanner";
import { useUpdaterStore } from "../updater/store";

export const AppLayout: React.FC = () => {
  const { status, lock } = useVaultStore();
  const { tabs, activeTabId } = useTerminalStore();
  const { sessions } = useSessionStore();
  const { loadSettings, setSettingsModalOpen, settingsModalOpen } = useSettingsStore();
  const { loadConfig: loadSyncConfig, modalOpen: syncModalOpen } = useSyncStore();
  const { transfers, transferQueueOpen, setTransferQueueOpen } = useSftpStore();

  const [isSessionModalOpen, setIsSessionModalOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [initialSessionValues, setInitialSessionValues] = useState<Partial<SessionInput> | undefined>();

  // 命令面板快捷键与状态
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // M3/M5 侧边栏与功能抽屉状态
  const [monitorOpen, setMonitorOpen] = useState(false);
  // 画布级容器工作区：打开后整块工作区切到容器界面，终端让位
  const [containerWorkspaceOpen, setContainerWorkspaceOpen] = useState(false);
  const [containerFocusId, setContainerFocusId] = useState<string | undefined>(undefined);
  const [forwardModalOpen, setForwardModalOpen] = useState(false);
  const [multiExecOpen, setMultiExecOpen] = useState(false);
  const [importExportOpen, setImportExportOpen] = useState(false);
  const [portCheckerOpen, setPortCheckerOpen] = useState(false);

  // FinalShell 经典布局：全终端 / 上下分屏 / 全 SFTP。
  // 布局状态收敛到 store，顶栏、标签栏、会话树共用同一份状态，避免出现「多个 SFTP 视图」互相打架。
  const sessionViewMode = useTerminalStore((s) => s.layoutMode);
  const setSessionViewMode = useTerminalStore((s) => s.setLayoutMode);
  const [splitRatio, setSplitRatio] = useState<number>(55);
  const [sidebarView, setSidebarView] = useState<"server" | "tree">("server");

  // 系统外观：壁纸 / 纯色背景同时作用于主界面与终端画布
  const backgroundId = useSettingsStore((s) => s.backgroundId);
  const backgroundCustom = useSettingsStore((s) => s.backgroundCustom);
  const backgroundOpacity = useSettingsStore((s) => s.backgroundOpacity);
  const backgroundBlur = useSettingsStore((s) => s.backgroundBlur);
  const shellBackground = useMemo(
    () => getWallpaperStyle(backgroundId, backgroundCustom),
    [backgroundId, backgroundCustom]
  );
  const shellBackgroundStyle: React.CSSProperties | null = shellBackground
    ? {
        backgroundImage: shellBackground.backgroundImage,
        backgroundSize: shellBackground.backgroundSize,
        backgroundColor: shellBackground.backgroundColor,
        backgroundPosition: "center",
        filter: backgroundBlur > 0 ? `blur(${backgroundBlur}px)` : undefined,
        transform: backgroundBlur > 0 ? "scale(1.06)" : undefined,
        opacity: Math.max(0, Math.min(100, backgroundOpacity)) / 100,
      }
    : null;

  // 拖动上下分屏分割条
  const handleSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startRatio = splitRatio;
    const container = (e.currentTarget as HTMLElement).parentElement;
    if (!container) return;
    const containerHeight = container.getBoundingClientRect().height;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const deltaPercent = (deltaY / containerHeight) * 100;
      const newRatio = Math.min(85, Math.max(15, startRatio + deltaPercent));
      setSplitRatio(newRatio);
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  useEffect(() => {
    loadSettings();
    loadSyncConfig();
    // 更新模块：读取配置并按需排定「启动 30 秒后 / 每 N 小时」的自动检查
    void useUpdaterStore.getState().bootstrap();
  }, []);

  // 监听全局 Ctrl+K / Cmd+K 唤起命令面板
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // 焦点在终端内时不拦截：Ctrl+K 在 bash / readline 里是「删除至行尾」，
      // 被全局命令面板劫持会直接破坏用户的命令行编辑习惯。
      const focusInTerminal = !!target && !!target.closest(".xterm");

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !focusInTerminal) {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      } else if (e.ctrlKey && e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        const current = useTerminalStore.getState().layoutMode;
        useTerminalStore
          .getState()
          .setLayoutMode(current === "terminal" ? "split" : current === "split" ? "sftp" : "terminal");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const isHomeActive = activeTabId === null || activeTabId === "home" || tabs.length === 0;
  // 切换标签 / 回到首页时自动退出容器工作区，避免残留在别的会话上
  useEffect(() => {
    setContainerWorkspaceOpen(false);
  }, [activeTabId]);

  const activeTab = isHomeActive ? null : tabs.find((t) => t.tabId === activeTabId);
  const isConnected = activeTab && activeTab.status === "connected" && (activeTab.connectionId || activeTab.protocol === "serial");

  // 终端宿主相关派生状态：
  // - terminalIsSsh：当前会话是 SSH（只有 SSH 才有 SFTP 视图 / 分屏概念）
  // - sessionTerminalVisible：终端区是否直接可见（SFTP 全屏时为 false，此时不 fit、不轮询串口）
  // - terminalHostHeight：分屏模式下终端只占上半区，尺寸变化由 ResizeObserver 驱动重新 fit
  const terminalIsSsh = !!activeTab && activeTab.protocol !== "serial";
  // 容器工作区打开时让出整块画布：终端只是不可见（xterm 仍挂载，PTY 不会断）
  const sessionTerminalVisible =
    !isHomeActive &&
    !!activeTab &&
    !containerWorkspaceOpen &&
    (terminalIsSsh ? sessionViewMode !== "sftp" : true);
  const terminalHostHeight =
    terminalIsSsh && sessionViewMode === "split" ? `${splitRatio}%` : "100%";

  const handleConnectSession = async (session: Session) => {
    const existing = tabs.find((t) => t.sessionId === session.id);
    if (existing) {
      useTerminalStore.getState().setActiveTab(existing.tabId);
    } else {
      await useTerminalStore.getState().openSession(session);
    }
  };

  const handleNewSession = (initialGroupId?: string) => {
    setEditingSession(null);
    setInitialSessionValues(initialGroupId ? { group_id: initialGroupId } : undefined);
    setIsSessionModalOpen(true);
  };

  const handleNewSessionWithValues = (values?: Partial<SessionInput>) => {
    setEditingSession(null);
    setInitialSessionValues(values);
    setIsSessionModalOpen(true);
  };

  const handleEditSession = (session: Session) => {
    setEditingSession(session);
    setInitialSessionValues(undefined);
    setIsSessionModalOpen(true);
  };

  // 快捷保存当前活动标签为新会话或编辑对应会话 (智能解析 Host/Port/Username)
  const handleSaveActiveTabAsSession = () => {
    if (!activeTab) return;
    const existing = sessions.find((s) => s.id === activeTab.sessionId);
    if (existing) {
      handleEditSession(existing);
    } else {
      let host = "";
      let port = 22;
      let username = "root";
      const name = activeTab.sessionName || "";
      if (name.includes("@")) {
        const parts = name.split("@");
        username = parts[0];
        const hostPort = parts[1];
        if (hostPort.includes(":")) {
          const hp = hostPort.split(":");
          host = hp[0];
          port = parseInt(hp[1], 10) || 22;
        } else {
          host = hostPort;
        }
      } else if (name.includes(":")) {
        const hp = name.split(":");
        host = hp[0];
        port = parseInt(hp[1], 10) || 22;
      } else {
        host = name;
      }

      handleNewSessionWithValues({
        name: activeTab.sessionName,
        protocol: activeTab.protocol,
        host,
        port,
        username,
      });
    }
  };

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-[#f5f5f7] font-sans antialiased select-none text-slate-800">
      {/* 系统外观背景层：壁纸 / 纯色，位于所有面板之下，不拦截任何交互 */}
      {shellBackgroundStyle && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 transition-opacity duration-300"
          style={shellBackgroundStyle}
        />
      )}

      {/* 顶部主导航栏 (Apple Translucent Frosted Glass Header) */}
      <header className="relative z-20 flex h-11 shrink-0 items-center gap-2 border-b border-black/[0.08] bg-white/80 backdrop-blur-xl px-3">
        {/* 顶部左侧品牌区已移除：logo / OpenShell 字样 / 版本号会与左上角区域冲突 */}

        {/* 顶部中央快捷搜索与直连触发器 (⌘K) */}
        <div className="flex min-w-0 flex-1 justify-center px-2">
          <button
            onClick={() => setCommandPaletteOpen(true)}
            className="flex w-full max-w-[18rem] items-center justify-between gap-2 px-3 py-1.5 rounded-xl border border-slate-200/80 bg-slate-100/70 text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition text-xs shadow-apple-sm"
            title="搜索会话、快速连接或切换主题 (Ctrl+K / ⌘K)"
          >
            <div className="flex min-w-0 items-center space-x-1.5">
              <svg className="w-3.5 h-3.5 shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <span className="truncate text-slate-500">快速搜索会话或直连...</span>
            </div>
            <kbd className="hidden shrink-0 px-1.5 py-0.2 text-[10px] font-mono bg-white border border-slate-200/80 rounded-md text-slate-400 shadow-apple-sm md:inline">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* 顶部右侧快捷工具栏（窄窗口下自动只保留图标，避免按钮被挤压/溢出） */}
        <div className="flex shrink-0 items-center gap-1.5 text-xs">
          {isConnected && (
            <>
              {activeTab?.protocol !== "serial" && (
                <div className="flex items-center rounded-xl border border-slate-200/80 bg-slate-100/90 p-0.5 text-xs font-medium shadow-apple-sm">
                  <button
                    onClick={() => setSessionViewMode("terminal")}
                    className={`px-2 py-0.5 rounded-lg transition text-[11px] font-medium ${
                      sessionViewMode === "terminal"
                        ? "bg-white text-apple-blue font-bold shadow-apple-sm"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                    title="全屏终端模式"
                  >
                    📟 终端
                  </button>
                  <button
                    onClick={() => setSessionViewMode("split")}
                    className={`px-2 py-0.5 rounded-lg transition text-[11px] font-medium ${
                      sessionViewMode === "split"
                        ? "bg-white text-apple-blue font-bold shadow-apple-sm"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                    title="经典分屏模式 (上终端 + 下SFTP，FinalShell 体验)"
                  >
                    ◫ 分屏
                  </button>
                  <button
                    onClick={() => setSessionViewMode("sftp")}
                    className={`px-2 py-0.5 rounded-lg transition text-[11px] font-medium ${
                      sessionViewMode === "sftp"
                        ? "bg-white text-apple-blue font-bold shadow-apple-sm"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                    title="全屏 SFTP 文件管理器"
                  >
                    📁 SFTP
                  </button>
                </div>
              )}

            </>
          )}

          <button
            onClick={() => setForwardModalOpen(true)}
            className="hidden md:flex items-center space-x-1 px-2.5 py-1 rounded-xl border bg-white border-slate-200/80 text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition shadow-apple-sm font-medium"
            title="端口转发与隧道"
          >
            <svg className="w-3.5 h-3.5 shrink-0 text-apple-orange" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            <span className="hidden xl:inline">端口转发</span>
          </button>

          <button
            onClick={() => setMultiExecOpen(!multiExecOpen)}
            className={`hidden md:flex items-center space-x-1 px-2.5 py-1 rounded-xl border transition shadow-apple-sm font-medium ${
              multiExecOpen
                ? "bg-amber-50 border-amber-300 text-amber-800"
                : "bg-white border-slate-200/80 text-slate-700 hover:bg-slate-50"
            }`}
            title="多会话同步输入"
          >
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z" />
            </svg>
            <span className="hidden xl:inline">多机同步</span>
          </button>

          <button
            onClick={() => setPortCheckerOpen(true)}
            className="hidden md:flex items-center space-x-1 px-2.5 py-1 rounded-xl border bg-white border-slate-200/80 text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition shadow-apple-sm font-medium"
            title="网络连通探测 (Ping / TCP)"
          >
            <svg className="w-3.5 h-3.5 shrink-0 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span className="hidden xl:inline">连通探测</span>
          </button>

          <button
            onClick={() => setImportExportOpen(true)}
            className="hidden md:flex items-center space-x-1 px-2.5 py-1 rounded-xl border bg-white border-slate-200/80 text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition shadow-apple-sm font-medium"
            title="导入 / 导出备份"
          >
            <svg className="w-3.5 h-3.5 shrink-0 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span className="hidden xl:inline">导入/导出</span>
          </button>

          {/* 顶部常驻同步小组件 (Apple Header Capsule) */}
          <SyncStatusWidget variant="header" />

          {/* 更新入口：有新版本时右上角出现红点 */}
          <UpdateBadge />

          {/* 设置按钮 */}
          <button
            onClick={() => setSettingsModalOpen(true)}
            className="p-1.5 rounded-xl border border-slate-200/80 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition shadow-apple-sm"
            title="系统偏好设置与外观"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>

          {status && status.state === "unlocked" && (
            <button
              onClick={() => lock()}
              className="flex items-center space-x-1.5 rounded-xl border border-slate-200/80 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition shadow-apple-sm"
              title="锁定主保险库"
            >
              <svg className="h-3.5 w-3.5 shrink-0 text-apple-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
              </svg>
              <span className="hidden xl:inline">锁定</span>
            </button>
          )}
        </div>
      </header>

      {/* 数据恢复提示：仅在迁移失败并已回滚时出现 */}
      <RecoveryBanner />

      {/* 主工作区 */}
      <div
        className={`relative z-10 flex flex-1 flex-col overflow-hidden ${
          shellBackgroundStyle ? "bg-white/55" : "bg-white"
        }`}
      >
        {/* 顶部标签栏（含常驻 🏠 主页 标签，随时点击无缝返回大盘） */}
        <TerminalTabs
          onNewTabClick={() => handleNewSession()}
          onHomeClick={() => useTerminalStore.getState().setActiveTab("home")}
        />

        <div className="relative flex-1 overflow-hidden">
          {/* 主页以覆盖层展示，工作区始终保持挂载：
              这样「终端 → 主页 → 切回终端」不会销毁 xterm 实例、不会丢 scrollback，
              也不会在远端重复打开 shell。 */}
          {isHomeActive && (
            <div
              className={`absolute inset-0 z-30 overflow-hidden ${
                shellBackgroundStyle ? "bg-white/60" : "bg-white"
              }`}
            >
              <HomeHub
                onNewSession={(groupId) => handleNewSession(groupId)}
                onEditSession={handleEditSession}
                onConnectSession={handleConnectSession}
                onPortCheckerOpen={() => setPortCheckerOpen(true)}
              />
            </div>
          )}

          {/* 活动会话工作区：左侧可切换【服务器监控/网络/容器】与【主机连接列表】，右侧为终端/SFTP 交互区 */}
          <div
            className="flex h-full overflow-hidden"
            style={{ visibility: isHomeActive ? "hidden" : "visible" }}
            aria-hidden={isHomeActive}
          >
            {activeTab && activeTab.protocol === "ssh" && (
              <div className="shrink-0 flex flex-col h-full border-r border-slate-200/80 bg-[#fbfbfd]">
                <div className="flex items-center p-1 bg-slate-100/90 border-b border-slate-200/80 text-[11px] font-semibold gap-0.5">
                  <button
                    onClick={() => setSidebarView("server")}
                    className={`flex-1 py-1 rounded-md transition text-center ${
                      sidebarView === "server"
                        ? "bg-white text-apple-blue shadow-apple-sm font-bold"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                    title="查看服务器资源监控、端口与容器"
                  >
                    📊 资源与容器
                  </button>
                  <button
                    onClick={() => setSidebarView("tree")}
                    className={`flex-1 py-1 rounded-md transition text-center ${
                      sidebarView === "tree"
                        ? "bg-white text-apple-blue shadow-apple-sm font-bold"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                    title="查看主机连接列表与快捷管理"
                  >
                    💻 主机列表
                  </button>
                </div>
                <div className="flex-1 overflow-hidden">
                  {/* 侧栏同样做渲染隔离：监控/进程面板异常不应影响终端会话 */}
                  <OverlayBoundary resetKey={`${sidebarView}|${activeTab.tabId}`}>
                    {sidebarView === "server" ? (
                      <ServerSidebar
                        tab={activeTab}
                        onOpenMonitor={() => setMonitorOpen(true)}
                        onOpenContainer={(containerId) => {
                          setContainerFocusId(containerId);
                          setContainerWorkspaceOpen(true);
                        }}
                      />
                    ) : (
                      <div className="w-64 h-full overflow-y-auto bg-[#fbfbfd]">
                        <SessionTree
                          onNewSession={(gId) => handleNewSession(gId)}
                          onEditSession={handleEditSession}
                        />
                      </div>
                    )}
                  </OverlayBoundary>
                </div>
              </div>
            )}

            <div
              className={`flex-1 flex flex-col overflow-hidden ${
                shellBackgroundStyle ? "bg-white/70" : "bg-white"
              }`}
            >
              {/* 快捷命令片段栏 (SSH 模式)；容器工作区打开时一并让位 */}
              {activeTab && activeTab.protocol !== "serial" && !containerWorkspaceOpen && (
                <SnippetBar activeTabId={activeTabId} />
              )}

              <div className="relative flex-1 overflow-hidden bg-white">
                {/* 终端宿主：所有已打开标签的 xterm 实例常驻挂载，切换标签/视图不重建 */}
                <TerminalHost
                  visible={sessionTerminalVisible}
                  style={{ height: terminalHostHeight }}
                />

                {/* 资源监控覆盖层 */}
                {monitorOpen && terminalIsSsh && !!activeTab?.connectionId && sessionTerminalVisible && (
                  <div className="absolute inset-0 z-20 overflow-hidden bg-white">
                    <OverlayBoundary resetKey={`monitor|${activeTab!.connectionId}`}>
                      <MonitorDashboard
                        connId={activeTab!.connectionId!}
                        sessionId={activeTab!.sessionId}
                        onClose={() => setMonitorOpen(false)}
                      />
                    </OverlayBoundary>
                  </div>
                )}

                {/* 全 SFTP 视图 / 上下分屏的下半区（覆盖在终端宿主之上，终端仍保持挂载） */}
                {terminalIsSsh && !!activeTab?.connectionId && sessionViewMode !== "terminal" && (
                  <div
                    className="absolute inset-x-0 bottom-0 z-20 overflow-hidden border-t border-slate-200 bg-white"
                    style={{ top: sessionViewMode === "split" ? `calc(${splitRatio}% + 8px)` : 0 }}
                  >
                    <OverlayBoundary resetKey={`sftp|${activeTab!.connectionId}`}>
                      <SftpView connId={activeTab!.connectionId!} sessionId={activeTab!.sessionId} />
                    </OverlayBoundary>
                  </div>
                )}

                {/* 画布级容器工作区：接管整块工作区（容器之间在此「路由」切换） */}
                {containerWorkspaceOpen && terminalIsSsh && !!activeTab?.connectionId && (
                  <OverlayBoundary resetKey={`container-ws|${activeTab!.connectionId}`}>
                    <ContainerWorkspace
                      connId={activeTab!.connectionId!}
                      initialContainerId={containerFocusId}
                      onClose={() => setContainerWorkspaceOpen(false)}
                    />
                  </OverlayBoundary>
                )}

                {/* 水平拖拽分割条 (FinalShell 经典分界线) */}
                {terminalIsSsh && sessionViewMode === "split" && (
                  <div
                    onMouseDown={handleSplitMouseDown}
                    style={{ top: `${splitRatio}%` }}
                    className="group absolute inset-x-0 z-30 flex h-2 cursor-row-resize select-none items-center justify-center border-y border-slate-300/40 bg-slate-200/90 transition-colors hover:bg-apple-blue"
                    title="上下拖拽调整终端与 SFTP 占比"
                  >
                    <div className="h-1 w-12 rounded-full bg-slate-400 transition-colors group-hover:bg-white" />
                  </div>
                )}
              </div>

              {/* 多会话同步输入栏 */}
              {multiExecOpen && (
                <MultiExecBar onClose={() => setMultiExecOpen(false)} />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 底部状态栏 (Apple Light Status Bar) */}
      <footer
        className={`relative z-10 flex h-7 shrink-0 items-center justify-between border-t border-black/[0.08] px-3 text-[11px] text-slate-600 select-none ${
          shellBackgroundStyle ? "bg-[#f5f5f7]/85" : "bg-[#f5f5f7]"
        }`}
      >
        <div className="flex items-center space-x-3">
          <span className="flex items-center space-x-1.5">
            <span className="h-2 w-2 rounded-full bg-apple-green shadow-apple-sm" />
            <span className="font-medium text-slate-700">核心引擎: Ready</span>
          </span>

          {activeTab && (
            <>
              <span className="text-slate-300">|</span>
              <span className="text-slate-800 font-semibold">
                当前: {activeTab.sessionName} (
                {activeTab.protocol === "serial"
                  ? "串口"
                  : sessionViewMode === "sftp"
                    ? "SFTP 视图"
                    : sessionViewMode === "split"
                      ? "分屏 · 终端 + SFTP"
                      : "终端命令行"}
                )
              </span>

              {/* 快捷保存/编辑活动会话动作 */}
              <button
                onClick={handleSaveActiveTabAsSession}
                className="text-[11px] text-apple-blue hover:underline px-1 py-0.5 rounded transition font-medium"
                title="保存或编辑该活动会话属性"
              >
                💾 保存会话
              </button>

              {activeTab.protocol === "ssh" && (
                <span className="text-slate-400 font-mono">延迟: ~18ms</span>
              )}
            </>
          )}
        </div>

        <div className="flex items-center space-x-3">
          {transfers.length > 0 && (
            <button
              onClick={() => setTransferQueueOpen(!transferQueueOpen)}
              className="flex items-center space-x-1 px-2 py-0.5 rounded-lg bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 shadow-apple-sm transition"
              title="点击打开/关闭传输抽屉"
            >
              <span className="text-apple-blue font-bold">⚡</span>
              <span>
                传输: {transfers.filter((t) => t.state === "transferring" || t.state === "queued").length} 活动 / {transfers.length} 项
              </span>
            </button>
          )}

          {/* 底部常驻同步小组件 */}
          <SyncStatusWidget variant="footer" />

          <span className="text-slate-300">|</span>
          <span className="text-slate-500 font-mono">UTF-8</span>

          <span className="flex items-center space-x-1 text-emerald-700 font-medium">
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <span>XChaCha20-Poly1305</span>
          </span>
        </div>
      </footer>

      {/* 全局模态弹窗与抽屉 */}
      <VaultUnlockModal />
      {/*
        浮层与终端工作区隔离：任何一个弹窗渲染异常都只让该浮层消失，
        不会卸载常驻的 xterm（避免「点错按钮 → 报错页 → SSH 断连」）。
      */}
      <OverlayBoundary
        resetKey={[
          isSessionModalOpen,
          commandPaletteOpen,
          forwardModalOpen,
          importExportOpen,
          portCheckerOpen,
          multiExecOpen,
          settingsModalOpen,
          syncModalOpen,
          transferQueueOpen,
          activeTabId ?? "home",
        ].join("|")}
      >
      <SessionModal
        isOpen={isSessionModalOpen}
        onClose={() => {
          setIsSessionModalOpen(false);
          setInitialSessionValues(undefined);
        }}
        editingSession={editingSession}
        initialValues={initialSessionValues}
        onConnectSession={handleConnectSession}
      />
      <CommandPaletteModal
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onNewSession={handleNewSessionWithValues}
        onOpenPortForward={() => setForwardModalOpen(true)}
        onOpenSync={() => useSyncStore.getState().setModalOpen(true)}
        onOpenPortChecker={() => setPortCheckerOpen(true)}
        onOpenImportExport={() => setImportExportOpen(true)}
        onToggleMultiExec={() => setMultiExecOpen((prev) => !prev)}
      />
      <TransferQueueDrawer />
      <RemoteEditorModal />
      {forwardModalOpen && (
        <PortForwardModal
          sessionId={activeTab?.sessionId}
          connId={activeTab?.connectionId || undefined}
          onClose={() => setForwardModalOpen(false)}
        />
      )}
      {importExportOpen && (
        <ImportExportModal onClose={() => setImportExportOpen(false)} />
      )}
      <SettingsModal />
      <UpdateModal />
      <SyncSettingsModal />
      <PortCheckerModal
        isOpen={portCheckerOpen}
        onClose={() => setPortCheckerOpen(false)}
        defaultHost={activeTab?.sessionName ? undefined : "127.0.0.1"}
      />
      </OverlayBoundary>
    </div>
  );
};
