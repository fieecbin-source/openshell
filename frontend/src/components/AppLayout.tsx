import { GlassMaterial } from "./ui/GlassMaterial";
import React, { useEffect, useState } from "react";
import type { Session, SessionInput } from "../types/ipc";
import { useVaultStore } from "../stores/vaultStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";
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
import { SettingsDropdown } from "./SettingsDropdown";
import { AboutModal } from "./AboutModal";
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
  const [settingsTab, setSettingsTab] = useState<"wallpaper" | "terminal" | "colors" | "security">("wallpaper");
  const [aboutModalOpen, setAboutModalOpen] = useState(false);

  const isFullscreen = useTerminalStore((s) => s.isFullscreen);
  const setFullscreen = useTerminalStore((s) => s.setFullscreen);
  const toggleFullscreen = useTerminalStore((s) => s.toggleFullscreen);

  // FinalShell 经典布局：全终端 / 上下分屏 / 全 SFTP。
  // 布局状态收敛到 store，顶栏、标签栏、会话树共用同一份状态，避免出现「多个 SFTP 视图」互相打架。
  const sessionViewMode = useTerminalStore((s) => s.layoutMode);
  const setSessionViewMode = useTerminalStore((s) => s.setLayoutMode);
  const [splitRatio, setSplitRatio] = useState<number>(55);
  const [sidebarView, setSidebarView] = useState<"server" | "tree">("server");

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

  // 监听全局 Ctrl+K / Cmd+K / F11 快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        toggleFullscreen();
        return;
      }
      if (e.key === "Escape" && isFullscreen) {
        setFullscreen(false);
        return;
      }
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
  }, [isFullscreen]);

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

  /**
   * 打开全屏服务器监控大屏（恢复最初版本顶栏的「服务器监控」入口）。
   *
   * 大屏覆盖层只在「终端可见」时渲染，若当前处于 SFTP 全屏 / 容器工作区，
   * 必须先切回终端布局再打开，否则会出现「点了没反应」的错觉。
   */
  const handleOpenMonitor = () => {
    if (!terminalIsSsh || !activeTab?.connectionId) return;
    setContainerWorkspaceOpen(false);
    if (!monitorOpen && sessionViewMode !== "terminal") {
      setSessionViewMode("terminal");
    }
    setMonitorOpen((prev) => !prev);
  };

  // 切换标签时同样收起：大屏属于「某个会话的临时视图」，不该跟着标签串台。
  useEffect(() => {
    setMonitorOpen(false);
  }, [activeTabId]);

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
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-canvas font-sans antialiased select-none text-ink">
      {/* 顶部主导航栏 (Apple Translucent Frosted Glass Header) */}
      {!isFullscreen && (
        <header className="glass-host relative z-50 flex h-11 shrink-0 items-center gap-2 border-b border-line/10 liquid-glass-chrome px-3 text-ink">
          <GlassMaterial radius={0} />
          {/* 顶部左侧品牌区已移除：logo / OpenShell 字样 / 版本号会与左上角区域冲突 */}

          {/* 顶部中央快捷搜索与直连触发器 (⌘K) */}
          <div className="flex min-w-0 flex-1 justify-center px-2">
            <button
              onClick={() => setCommandPaletteOpen(true)}
              className="flex w-full max-w-[18rem] items-center justify-between gap-2 px-3 py-1.5 rounded-xl border border-line/15 bg-line/5 text-ink-secondary hover:text-ink hover:bg-line/5 transition text-xs shadow-apple-sm"
              title="搜索会话、快速连接或切换主题 (Ctrl+K / ⌘K)"
            >
              <div className="flex min-w-0 items-center space-x-1.5">
                <svg className="w-3.5 h-3.5 shrink-0 text-ink-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <span className="truncate text-ink-secondary">快速搜索会话或直连...</span>
              </div>
              <kbd className="hidden shrink-0 px-1.5 py-0.2 text-[10px] font-mono bg-surface border border-line/15 rounded-md text-ink-tertiary shadow-apple-sm md:inline">
                ⌘K
              </kbd>
            </button>
          </div>

          {/* 顶部右侧快捷工具栏 */}
          <div className="flex shrink-0 items-center gap-1.5 text-xs">
            {/* 全屏服务器监控大屏入口 */}
            {isConnected && terminalIsSsh && activeTab?.connectionId && (
              <button
                onClick={handleOpenMonitor}
                className={`flex items-center space-x-1 rounded-xl border px-2.5 py-1 font-semibold transition shadow-apple-sm ${
                  monitorOpen
                    ? "border-accent/30 bg-accent/10 text-accent"
                    : "border-accent/30 bg-accent/10 text-accent hover:border-accent/30 hover:bg-accent/10"
                }`}
                title={monitorOpen ? "返回终端 (再次点击或按 Esc 切回)" : "打开全屏服务器监控大屏"}
              >
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                  />
                </svg>
                <span className="hidden md:inline">{monitorOpen ? "返回终端" : "监控大屏"}</span>
              </button>
            )}

            <button
              onClick={() => setForwardModalOpen(true)}
              className="hidden md:flex items-center space-x-1 px-2.5 py-1 rounded-xl border border-line/15 bg-line/5 hover:bg-line/10 text-ink transition shadow-apple-sm font-medium"
              title="端口转发与隧道"
            >
              <svg className="w-3.5 h-3.5 shrink-0 text-state-warning" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
              <span className="hidden xl:inline">端口转发</span>
            </button>

            <button
              onClick={() => setMultiExecOpen(!multiExecOpen)}
              className={`hidden md:flex items-center space-x-1 px-2.5 py-1 rounded-xl border transition shadow-apple-sm font-medium ${
                multiExecOpen
                  ? "bg-state-warning/100/25 border-state-warning/30 text-state-warning"
                  : "border-line/15 bg-line/5 hover:bg-line/10 text-ink"
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
              className="hidden md:flex items-center space-x-1 px-2.5 py-1 rounded-xl border border-line/15 bg-line/5 hover:bg-line/10 text-ink transition shadow-apple-sm font-medium"
              title="网络连通探测 (Ping / TCP)"
            >
              <svg className="w-3.5 h-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              <span className="hidden xl:inline">连通探测</span>
            </button>

            <button
              onClick={() => setImportExportOpen(true)}
              className="hidden md:flex items-center space-x-1 px-2.5 py-1 rounded-xl border border-line/15 bg-line/5 hover:bg-line/10 text-ink transition shadow-apple-sm font-medium"
              title="导入 / 导出备份"
            >
              <svg className="w-3.5 h-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              <span className="hidden xl:inline">导入/导出</span>
            </button>

            {/* 顶部常驻同步小组件 (Apple Header Capsule) */}
            <SyncStatusWidget variant="header" />

            {/* 更新入口：有新版本时右上角出现红点 */}
            <UpdateBadge />

            {/* 设置下拉入口 */}
            <SettingsDropdown
              onOpenSettings={(tab) => {
                setSettingsTab(tab || "wallpaper");
                setSettingsModalOpen(true);
              }}
              onOpenSync={() => useSyncStore.getState().setModalOpen(true)}
              onOpenAbout={() => setAboutModalOpen(true)}
              onCheckUpdate={() => useUpdaterStore.getState().setModalOpen(true)}
            />

            {status && status.state === "unlocked" && (
              <button
                onClick={() => lock()}
                className="flex items-center space-x-1.5 rounded-xl border border-line/15 bg-surface px-2.5 py-1 text-xs font-semibold text-ink-secondary hover:bg-surface-muted transition shadow-apple-sm"
                title="锁定主保险库"
              >
                <svg className="h-3.5 w-3.5 shrink-0 text-state-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                </svg>
                <span className="hidden xl:inline">锁定</span>
              </button>
            )}
          </div>
        </header>
      )}

      {/* 终端全屏退出悬浮胶囊按钮 (Liquid Glass Exit Capsule) */}
      {isFullscreen && (
        <button
          onClick={() => setFullscreen(false)}
          className="fixed top-2.5 right-4 z-50 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full liquid-glass-panel text-ink  text-xs shadow-lg hover:scale-105 transition-all backdrop-blur-xl font-medium border border-white/20 active:scale-95"
          title="退出终端全屏 (Esc / F11)"
        >
          <span>✕ 退出全屏 (Esc / F11)</span>
        </button>
      )}

      {/* 数据恢复提示：仅在迁移失败并已回滚时出现 */}
      <RecoveryBanner />

      {/* 主工作区 */}
      <div className="relative z-10 flex flex-1 flex-col overflow-hidden bg-canvas">
        {/* 顶部标签栏（含常驻 🏠 主页 标签，随时点击无缝返回大盘） */}
        <TerminalTabs
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
          onNewTabClick={() => handleNewSession()}
          onHomeClick={() => useTerminalStore.getState().setActiveTab("home")}
        />

        <div className="relative flex-1 overflow-hidden">
          {/* 主页以覆盖层展示，工作区始终保持挂载：
              这样「终端 → 主页 → 切回终端」不会销毁 xterm 实例、不会丢 scrollback，
              也不会在远端重复打开 shell。 */}
          {isHomeActive && (
            <div className="absolute inset-0 z-30 overflow-hidden bg-canvas text-ink">
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
            {!isFullscreen && activeTab && activeTab.protocol === "ssh" && (
              <div className="shrink-0 flex flex-col h-full border-r border-line/10 bg-surface-muted">
                <div className="flex items-center p-1 bg-surface-muted/90 border-b border-line/10 text-[11px] font-semibold gap-0.5">
                  <button
                    onClick={() => setSidebarView("server")}
                    className={`flex-1 py-1 rounded-md transition text-center ${
                      sidebarView === "server"
                        ? "bg-accent/15 text-accent font-bold"
                        : "text-ink-secondary hover:text-ink"
                    }`}
                    title="查看服务器资源监控、端口与容器"
                  >
                    📊 资源与容器
                  </button>
                  <button
                    onClick={() => setSidebarView("tree")}
                    className={`flex-1 py-1 rounded-md transition text-center ${
                      sidebarView === "tree"
                        ? "bg-accent/15 text-accent font-bold"
                        : "text-ink-secondary hover:text-ink"
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
                        onOpenMonitor={handleOpenMonitor}
                        onOpenContainer={(containerId) => {
                          setContainerFocusId(containerId);
                          setContainerWorkspaceOpen(true);
                        }}
                      />
                    ) : (
                      <div className="w-64 h-full overflow-y-auto bg-surface-muted">
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

            <div className="flex-1 flex flex-col overflow-hidden bg-canvas">
              {/* 快捷命令片段栏 (SSH 模式)；容器工作区打开时一并让位 */}
              {activeTab && activeTab.protocol !== "serial" && !containerWorkspaceOpen && (
                <SnippetBar activeTabId={activeTabId} />
              )}

              <div className="relative flex-1 overflow-hidden bg-surface">
                {/* 终端宿主：所有已打开标签的 xterm 实例常驻挂载，切换标签/视图不重建 */}
                <TerminalHost
                  visible={sessionTerminalVisible}
                  style={{ height: terminalHostHeight }}
                />

                {/* 资源监控覆盖层 */}
                {monitorOpen && terminalIsSsh && !!activeTab?.connectionId && sessionTerminalVisible && (
                  // 大屏固定深色底：父层先铺深色，避免挂载瞬间闪出白底
                  <div className="absolute inset-0 z-20 overflow-hidden bg-canvas">
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
                    className="absolute inset-x-0 bottom-0 z-20 overflow-hidden border-t border-line/15 bg-surface"
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
                    className="group absolute inset-x-0 z-30 flex h-2 cursor-row-resize select-none items-center justify-center border-y border-line/25 bg-line/10 transition-colors hover:bg-action"
                    title="上下拖拽调整终端与 SFTP 占比"
                  >
                    <div className="h-1 w-12 rounded-full bg-line/20 transition-colors group-hover:bg-surface" />
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
      {!isFullscreen && (
        <footer className="relative z-10 flex h-7 shrink-0 items-center justify-between border-t border-line/10 px-3 text-[11px] text-ink-secondary select-none bg-surface/85 backdrop-blur-xl">
          <div className="flex items-center space-x-3">
            <span className="flex items-center space-x-1.5">
              <span className="h-2 w-2 rounded-full bg-state-success shadow-apple-sm" />
              <span className="font-medium text-ink-secondary">核心引擎: Ready</span>
            </span>

            {activeTab && (
              <>
                <span className="text-ink-secondary">|</span>
                <span className="text-ink font-semibold">
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
                  className="text-[11px] text-accent hover:underline px-1 py-0.5 rounded transition font-medium"
                  title="保存或编辑该活动会话属性"
                >
                  💾 保存会话
                </button>

                {activeTab.protocol === "ssh" && (
                  <span className="text-ink-tertiary font-mono">延迟: ~18ms</span>
                )}
              </>
            )}
          </div>

          <div className="flex items-center space-x-3">
            {transfers.length > 0 && (
              <button
                onClick={() => setTransferQueueOpen(!transferQueueOpen)}
                className="flex items-center space-x-1 px-2 py-0.5 rounded-lg bg-surface border border-line/15 text-ink-secondary hover:bg-surface-muted shadow-apple-sm transition"
                title="点击打开/关闭传输抽屉"
              >
                <span className="text-accent font-bold">⚡</span>
                <span>
                  传输: {transfers.filter((t) => t.state === "transferring" || t.state === "queued").length} 活动 / {transfers.length} 项
                </span>
              </button>
            )}

            {/* 底部常驻同步小组件 */}
            <SyncStatusWidget variant="footer" />

            <span className="text-ink-secondary">|</span>
            <span className="text-ink-secondary font-mono">UTF-8</span>

            <span className="flex items-center space-x-1 text-state-success font-medium">
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              <span>XChaCha20-Poly1305</span>
            </span>
          </div>
        </footer>
      )}

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
      <SettingsModal initialTab={settingsTab} />
      <AboutModal open={aboutModalOpen} onClose={() => setAboutModalOpen(false)} />
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
