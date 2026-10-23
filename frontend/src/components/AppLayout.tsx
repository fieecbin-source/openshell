import React, { useEffect, useState } from "react";
import type { Session, SessionInput } from "../types/ipc";
import { useVaultStore } from "../stores/vaultStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useSessionStore } from "../stores/sessionStore";
import { HomeHub } from "./HomeHub";
import { ServerSidebar } from "./ServerSidebar";
import { TerminalTabs } from "./TerminalTabs";
import { XtermView } from "./XtermView";
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
import { SerialControlBar } from "./SerialControlBar";
import { SerialSendBar } from "./SerialSendBar";
import { HexDumpView } from "./HexDumpView";
import { useSerialStore } from "../stores/serialStore";
import { SftpView } from "./SftpView";
import { DisconnectedBackdrop } from "./DisconnectedBackdrop";
import { useSftpStore } from "../stores/sftpStore";
import { SessionTree } from "./SessionTree";

export const AppLayout: React.FC = () => {
  const { status, lock } = useVaultStore();
  const { tabs, activeTabId, reconnectTab } = useTerminalStore();
  const { sessions } = useSessionStore();
  const { loadSettings, setSettingsModalOpen } = useSettingsStore();
  const { loadConfig: loadSyncConfig } = useSyncStore();
  const { viewMode } = useSerialStore();
  const { transfers, transferQueueOpen, setTransferQueueOpen } = useSftpStore();

  const [isSessionModalOpen, setIsSessionModalOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [initialSessionValues, setInitialSessionValues] = useState<Partial<SessionInput> | undefined>();

  // 命令面板快捷键与状态
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // M3/M5 侧边栏与功能抽屉状态
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [forwardModalOpen, setForwardModalOpen] = useState(false);
  const [multiExecOpen, setMultiExecOpen] = useState(false);
  const [importExportOpen, setImportExportOpen] = useState(false);
  const [portCheckerOpen, setPortCheckerOpen] = useState(false);

  // FinalShell 经典布局增强：全终端 / 上下分屏 / 全SFTP 视图模式与分屏比例
  const [sessionViewMode, setSessionViewMode] = useState<"terminal" | "split" | "sftp">("split");
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
  }, []);

  // 监听全局 Ctrl+K / Cmd+K 唤起命令面板
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      } else if (e.ctrlKey && e.shiftKey && e.key === "Tab") {
        e.preventDefault();
        setSessionViewMode((prev) => {
          if (prev === "terminal") return "split";
          if (prev === "split") return "sftp";
          return "terminal";
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const isHomeActive = activeTabId === null || activeTabId === "home" || tabs.length === 0;
  const activeTab = isHomeActive ? null : tabs.find((t) => t.tabId === activeTabId);
  const isConnected = activeTab && activeTab.status === "connected" && (activeTab.connectionId || activeTab.protocol === "serial");

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
    <div className="flex h-screen w-screen flex-col bg-[#f5f5f7] font-sans antialiased select-none text-slate-800">
      {/* 顶部主导航栏 (Apple Translucent Frosted Glass Header) */}
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-black/[0.08] bg-white/80 backdrop-blur-xl px-3 z-20">
        <div className="flex items-center space-x-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-apple-blue text-white font-black text-[11px] shadow-apple-sm">
            OS
          </div>
          <span className="text-sm font-semibold tracking-tight text-slate-900">
            OpenShell
          </span>
          <span className="rounded-full bg-slate-100 border border-slate-200/80 px-2 py-0.5 text-[10px] font-medium text-slate-600 font-mono">
            v1.0.0
          </span>
        </div>

        {/* 顶部中央快捷搜索与直连触发器 (⌘K) */}
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setCommandPaletteOpen(true)}
            className="flex items-center space-x-2 px-3 py-1.5 rounded-xl border border-slate-200/80 bg-slate-100/70 text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition text-xs w-72 justify-between shadow-apple-sm"
            title="搜索会话、快速连接或切换主题 (Ctrl+K / ⌘K)"
          >
            <div className="flex items-center space-x-1.5 truncate">
              <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <span className="truncate text-slate-500">快速搜索会话或直连...</span>
            </div>
            <kbd className="px-1.5 py-0.2 text-[10px] font-mono bg-white border border-slate-200/80 rounded-md text-slate-400 shadow-apple-sm">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* 顶部右侧快捷工具栏 */}
        <div className="flex items-center space-x-1.5 text-xs">
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

              <button
                onClick={() => setMonitorOpen(true)}
                className="flex items-center space-x-1 px-2.5 py-1 rounded-xl border bg-white border-slate-200/80 text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition shadow-apple-sm font-medium"
                title="查看服务器资源监控"
              >
                <svg className="w-3.5 h-3.5 text-apple-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <span>服务器监控</span>
              </button>
            </>
          )}

          <button
            onClick={() => setForwardModalOpen(true)}
            className="flex items-center space-x-1 px-2.5 py-1 rounded-xl border bg-white border-slate-200/80 text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition shadow-apple-sm font-medium"
            title="端口转发与隧道"
          >
            <svg className="w-3.5 h-3.5 text-apple-orange" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            <span>端口转发</span>
          </button>

          <button
            onClick={() => setMultiExecOpen(!multiExecOpen)}
            className={`flex items-center space-x-1 px-2.5 py-1 rounded-xl border transition shadow-apple-sm font-medium ${
              multiExecOpen
                ? "bg-amber-50 border-amber-300 text-amber-800"
                : "bg-white border-slate-200/80 text-slate-700 hover:bg-slate-50"
            }`}
            title="多会话同步输入"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z" />
            </svg>
            <span>多机同步</span>
          </button>

          <button
            onClick={() => setPortCheckerOpen(true)}
            className="flex items-center space-x-1 px-2.5 py-1 rounded-xl border bg-white border-slate-200/80 text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition shadow-apple-sm font-medium"
            title="网络连通探测 (Ping / TCP)"
          >
            <svg className="w-3.5 h-3.5 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span>网络探测</span>
          </button>

          <button
            onClick={() => setImportExportOpen(true)}
            className="flex items-center space-x-1 px-2.5 py-1 rounded-xl border bg-white border-slate-200/80 text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition shadow-apple-sm font-medium"
            title="导入 / 导出备份"
          >
            <svg className="w-3.5 h-3.5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span>导入/导出</span>
          </button>

          {/* 顶部常驻同步小组件 (Apple Header Capsule) */}
          <SyncStatusWidget variant="header" />

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
              <svg className="h-3.5 w-3.5 text-apple-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
              </svg>
              <span>锁定</span>
            </button>
          )}
        </div>
      </header>

      {/* 主工作区 */}
      <div className="flex flex-1 flex-col overflow-hidden bg-white">
        {/* 顶部标签栏（含常驻 🏠 主页 标签，随时点击无缝返回大盘） */}
        <TerminalTabs
          onNewTabClick={() => handleNewSession()}
          onHomeClick={() => useTerminalStore.getState().setActiveTab("home")}
        />

        {isHomeActive ? (
          /* 主页模式：大盘机器连接与管理中心（包含大号新建连接、卡片极速直连、状态大盘） */
          <HomeHub
            onNewSession={(groupId) => handleNewSession(groupId)}
            onEditSession={handleEditSession}
            onConnectSession={handleConnectSession}
            onPortCheckerOpen={() => setPortCheckerOpen(true)}
          />
        ) : (
          /* 活动会话模式：左侧可切换【服务器监控/网络/容器】与【主机连接列表】，右侧为终端/SFTP交互区 */
          <div className="flex flex-1 overflow-hidden">
            {activeTab && activeTab.protocol === "ssh" && (
              <div className="shrink-0 flex flex-col h-full border-r border-slate-200/80 bg-[#fbfbfd]">
                <div className="flex items-center p-1 bg-slate-100/90 border-b border-slate-200/80 text-[11px] font-semibold gap-0.5">
                  <button
                    onClick={() => setSidebarView("server")}
                    className={`flex-1 py-1 rounded-md transition text-center ${
                      sidebarView === "server"
                        ? "bg-white text-apple-blue shadow-apple-sm font-bold"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                    title="查看服务器资源监控、网络端口与容器"
                  >
                    📊 资源与容器
                  </button>
                  <button
                    onClick={() => setSidebarView("tree")}
                    className={`flex-1 py-1 rounded-md transition text-center ${
                      sidebarView === "tree"
                        ? "bg-white text-apple-blue shadow-apple-sm font-bold"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                    title="查看主机连接列表与快捷管理"
                  >
                    💻 主机列表
                  </button>
                </div>
                <div className="flex-1 overflow-hidden">
                  {sidebarView === "server" ? (
                    <ServerSidebar tab={activeTab} />
                  ) : (
                    <div className="w-64 h-full overflow-y-auto bg-[#fbfbfd]">
                      <SessionTree
                        onNewSession={(gId) => handleNewSession(gId)}
                        onEditSession={handleEditSession}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex-1 flex flex-col overflow-hidden bg-white">
              {/* 快捷命令片段栏 (SSH 模式) */}
              {activeTab && activeTab.protocol !== "serial" && (
                <SnippetBar activeTabId={activeTabId} />
              )}

              <div className="relative flex-1 overflow-hidden flex bg-white">
                {activeTab && (
                  activeTab.protocol === "serial" ? (
                    <div className="flex-1 h-full relative overflow-hidden flex flex-col bg-white">
                      <SerialControlBar
                        cardId={activeTab.cardId || activeTab.tabId}
                        baudRate={activeTab.baudRate}
                      />
                      <div className="flex-1 relative overflow-hidden">
                        {viewMode === "hex" ? (
                          <HexDumpView cardId={activeTab.cardId || activeTab.tabId} />
                        ) : (
                          <XtermView key={activeTab.tabId} tab={activeTab} />
                        )}
                      </div>
                      <SerialSendBar cardId={activeTab.cardId || activeTab.tabId} />

                      {/* 串口断开半透明遮罩 */}
                      {activeTab.status === "disconnected" && (
                        <DisconnectedBackdrop
                          isSerial={true}
                          reason={activeTab.error}
                          onReconnect={async () => {
                            setIsReconnecting(true);
                            await reconnectTab(activeTab.tabId);
                            setIsReconnecting(false);
                          }}
                          reconnecting={isReconnecting}
                        />
                      )}
                    </div>
                  ) : (
                    <div className="flex-1 h-full relative overflow-hidden flex flex-col bg-white">
                      {/* 会话主交互区：根据 sessionViewMode 动态切换终端与 SFTP 布局 */}
                      {sessionViewMode === "terminal" && (
                        <div className="w-full h-full relative">
                          <XtermView key={activeTab.tabId} tab={activeTab} />
                          {monitorOpen && activeTab.connectionId && (
                            <MonitorDashboard
                              connId={activeTab.connectionId}
                              sessionId={activeTab.sessionId}
                              onClose={() => setMonitorOpen(false)}
                            />
                          )}
                        </div>
                      )}

                      {sessionViewMode === "sftp" && (
                        <div className="w-full h-full relative">
                          {activeTab.connectionId && (
                            <SftpView
                              connId={activeTab.connectionId}
                              sessionId={activeTab.sessionId}
                            />
                          )}
                        </div>
                      )}

                      {sessionViewMode === "split" && (
                        <div className="w-full h-full flex flex-col overflow-hidden relative">
                          {/* 上半区：终端 */}
                          <div style={{ height: `${splitRatio}%` }} className="w-full relative overflow-hidden">
                            <XtermView key={activeTab.tabId} tab={activeTab} />
                            {monitorOpen && activeTab.connectionId && (
                              <MonitorDashboard
                                connId={activeTab.connectionId}
                                sessionId={activeTab.sessionId}
                                onClose={() => setMonitorOpen(false)}
                              />
                            )}
                          </div>

                          {/* 水平拖拽分割条 (FinalShell 经典分界线) */}
                          <div
                            onMouseDown={handleSplitMouseDown}
                            className="h-2 w-full bg-slate-200/90 hover:bg-apple-blue cursor-row-resize flex items-center justify-center transition-colors z-10 shrink-0 group border-y border-slate-300/40 select-none"
                            title="上下拖拽调整终端与 SFTP 占比"
                          >
                            <div className="w-12 h-1 bg-slate-400 group-hover:bg-white rounded-full transition-colors" />
                          </div>

                          {/* 下半区：SFTP 文件管理器 */}
                          <div style={{ height: `${100 - splitRatio}%` }} className="w-full relative overflow-hidden">
                            {activeTab.connectionId && (
                              <SftpView
                                connId={activeTab.connectionId}
                                sessionId={activeTab.sessionId}
                              />
                            )}
                          </div>
                        </div>
                      )}

                      {/* 会话断开半透明遮罩 */}
                      {activeTab.status === "disconnected" && (
                        <DisconnectedBackdrop
                          isSerial={false}
                          reason={activeTab.error}
                          onReconnect={async () => {
                            setIsReconnecting(true);
                            await reconnectTab(activeTab.tabId);
                            setIsReconnecting(false);
                          }}
                          reconnecting={isReconnecting}
                        />
                      )}
                    </div>
                  )
                )}
              </div>

              {/* 多会话同步输入栏 */}
              {multiExecOpen && (
                <MultiExecBar onClose={() => setMultiExecOpen(false)} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* 底部状态栏 (Apple Light Status Bar) */}
      <footer className="flex h-7 shrink-0 items-center justify-between border-t border-black/[0.08] bg-[#f5f5f7] px-3 text-[11px] text-slate-600 select-none">
        <div className="flex items-center space-x-3">
          <span className="flex items-center space-x-1.5">
            <span className="h-2 w-2 rounded-full bg-apple-green shadow-apple-sm" />
            <span className="font-medium text-slate-700">核心引擎: Ready</span>
          </span>

          {activeTab && (
            <>
              <span className="text-slate-300">|</span>
              <span className="text-slate-800 font-semibold">
                当前: {activeTab.sessionName} ({activeTab.currentMode === "view" ? "SFTP 视图" : "终端命令行"})
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
      <SessionModal
        isOpen={isSessionModalOpen}
        onClose={() => {
          setIsSessionModalOpen(false);
          setInitialSessionValues(undefined);
        }}
        editingSession={editingSession}
        initialValues={initialSessionValues}
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
      <SyncSettingsModal />
      <PortCheckerModal
        isOpen={portCheckerOpen}
        onClose={() => setPortCheckerOpen(false)}
        defaultHost={activeTab?.sessionName ? undefined : "127.0.0.1"}
      />
    </div>
  );
};
